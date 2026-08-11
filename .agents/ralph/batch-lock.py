#!/usr/bin/env python3
"""Serialize `ralph batch` per target repo behind an fd-based flock(2) (#82).

Two batches on ONE target repo share mutable local state (`.ralph/last-run.env`,
the git worktree registry, `.agent-run/`), so an overlapping second run silently
orphans the first: the log cuts off, no result, no PR. batch-loop.sh therefore
re-execs itself through this guardian:

  batch-lock.py <lockfile> <target-repo> -- <command> [args...]

The guardian takes LOCK_EX|LOCK_NB on <lockfile>, publishes one line of holder
metadata into it, then runs <command> and exits with its status. Two properties
are the whole point, and both fall out of flock(2) semantics:

  * NO stale lock is possible. The lock lives on an open file descriptor, so the
    kernel drops it when this process dies — normal exit, unhandled error and
    SIGKILL alike. The lockfile itself is never deleted and its contents are
    diagnostics only, so a leftover file can never make a future batch look busy.
  * NO descendant can keep the lock alive. The locked fd is closed before the
    batch starts (Popen's close_fds), so an agent, a check, or a daemon they leave
    behind cannot inherit the lock and hold it after the batch is gone.

A second, overlapping batch is refused LOUDLY (exit CONFLICT_EXIT) naming the live
holder — never allowed to proceed and corrupt the run already in flight.
`--allow-concurrent` / RALPH_ALLOW_CONCURRENT=1 skips this guardian entirely
(batch-loop.sh never spawns it) for the deliberate parallel pattern where every
run has its own worktree.

flock(2) is taken through python3 — already a hard dependency of batch-loop.sh —
and NOT through flock(1), which is util-linux and absent on a stock macOS.
"""

import fcntl
import os
import signal
import subprocess
import sys
import time

# Distinct from every status batch-loop.sh itself exits with (1 die, 3 preflight,
# 4 backend unavailable, 5 efficiency pause), so a caller can tell "refused, a
# batch is already running" from "the batch ran and failed".
CONFLICT_EXIT = 121
# The holder publishes its metadata immediately after acquiring the lock, but a
# contender can lose that race by microseconds (or read the file mid-rewrite when
# the run id is filled in), so wait briefly for the line instead of reporting a
# nameless holder.
HOLDER_WAIT_SECONDS = 5.0
HOLDER_POLL_SECONDS = 0.02
USAGE = "usage: batch-lock.py <lockfile> <target-repo> -- <command> [args...]\n"


def read_holder(lockfile):
    """The holder line, waited for briefly; never raises."""
    deadline = time.time() + HOLDER_WAIT_SECONDS
    while True:
        try:
            with open(lockfile, "r") as fh:
                line = fh.readline().strip()
        except OSError:
            line = ""
        if line:
            return line
        if time.time() >= deadline:
            return "run=unknown pid=unknown"
        time.sleep(HOLDER_POLL_SECONDS)


def publish(fd, line):
    """Rewrite the holder metadata through the LOCKED fd (never reopen/unlink)."""
    blob = line.encode()
    os.lseek(fd, 0, os.SEEK_SET)
    os.write(fd, blob)
    os.ftruncate(fd, len(blob))


def main(argv):
    if len(argv) < 4 or argv[2] != "--":
        sys.stderr.write(USAGE)
        return 2
    lockfile, label, cmd = argv[0], argv[1], argv[3:]
    if not cmd:
        sys.stderr.write(USAGE)
        return 2
    parent = os.path.dirname(lockfile)
    if parent:
        os.makedirs(parent, exist_ok=True)
    # O_CREAT but never O_TRUNC: a contender has to be able to read the holder's
    # metadata out of the very file it is about to fail to lock.
    fd = os.open(lockfile, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.stderr.write(
            "ralph: Another batch is already active for %s (%s). Refusing to run "
            "concurrently; use --allow-concurrent only with separate worktrees.\n"
            % (label, read_holder(lockfile))
        )
        sys.stderr.flush()
        return CONFLICT_EXIT
    # Provisional: the batch replaces this with its real run id once it has one.
    publish(fd, "run=batch-pending pid=%d\n" % os.getpid())
    # close_fds=True (the default) is what keeps the locked fd out of the batch and
    # therefore out of every agent/check descendant. stdio is inherited untouched,
    # so a normal single run looks exactly as it did without the lock.
    child = subprocess.Popen(cmd)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda signum, frame: forward(child, signum))
    status = child.wait()
    # The kernel already releases the lock when this process exits; nothing here
    # deletes the lockfile, precisely so the crash path and this path agree.
    return status if status >= 0 else 128 - status


def forward(child, signum):
    try:
        child.send_signal(signum)
    except OSError:
        pass


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

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

The lock must outlive this process being killed on its own, though: `kill -9` (or an
OOM kill) aimed at the guardian and not at the batch would otherwise free the lock
while the batch runs on, which is precisely the two-overlapping-batches state #82
forbids. So the guardian also starts a tiny KEEPER holding the same locked fd (an
flock lives on the open file description, which fork shares) that is not a descendant
of the batch — see spawn_keeper(). Lock held == a live batch, in both directions.

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
# Only ever used on the abnormal path (the guardian died without reporting the
# batch's exit), so it never delays a normal back-to-back pair of batches.
KEEPER_POLL_SECONDS = 0.25
KEEPER_VERIFY_SECONDS = 5.0
# One byte on the notify pipe means "the batch is over, release the lock now".
KEEPER_DONE = b"d"
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


def batch_marker(cmd):
    """How to recognize the batch in `ps` output (empty = don't try)."""
    for arg in cmd:
        if arg.endswith(".sh"):
            return os.path.basename(arg)
    return ""


def spawn_keeper(lock_fd, batch_pid, marker):
    """Start the keeper that holds the lock for as long as the batch lives.

    The keeper inherits the LOCKED fd, and an flock is released only once every fd
    referring to that open file description is closed — so the lock survives this
    guardian being SIGKILLed while the batch it started keeps running. The keeper is
    a child of the guardian, never of the batch, so it cannot reintroduce the "a
    leftover agent/check daemon holds the lock open" hole that close_fds avoids.

    Returns the write end of the notify pipe, or None if no keeper could be started
    (in which case the lock simply reverts to living exactly as long as we do).
    """
    try:
        read_fd, write_fd = os.pipe()
    except OSError:
        return None
    try:
        # pass_fds keeps both fds at these numbers in the keeper and closes
        # everything else; its stdio is /dev/null so a keeper that outlives us can
        # never write to the caller's terminal or hold a caller's pipe open.
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--keeper",
             str(batch_pid), str(lock_fd), str(read_fd), marker],
            pass_fds=(lock_fd, read_fd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, ValueError) as err:
        os.close(read_fd)
        os.close(write_fd)
        sys.stderr.write(
            "ralph: batch lock keeper could not start (%s); the lock now lasts only as "
            "long as pid %d.\n" % (err, os.getpid())
        )
        return None
    os.close(read_fd)
    return write_fd


def release_keeper(write_fd):
    """Tell the keeper the batch is over (and free the lock) — then it exits at once."""
    if write_fd is None:
        return
    try:
        os.write(write_fd, KEEPER_DONE)
    except OSError:
        pass
    try:
        os.close(write_fd)
    except OSError:
        pass


def batch_alive(pid, marker):
    """Is that batch still running? Guards against pid reuse so a recycled pid can
    never keep the lock held (the ticket forbids any stale lock)."""
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    if not marker:
        return True
    try:
        ps = subprocess.Popen(
            ["ps", "-p", str(pid), "-o", "args="],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        out = ps.communicate()[0]
    except OSError:
        return True  # no usable ps: pid liveness is all we have
    if ps.returncode != 0:
        return False
    text = out.decode("utf-8", "replace").strip()
    return marker in text if text else True


def keeper(batch_pid, lock_fd, pipe_fd, marker):
    """Hold `lock_fd` (and therefore the flock) until the batch is really gone."""
    # Terminal signals must not drop the lock out from under a running batch: a
    # Ctrl-C reaches the whole foreground process group, and it is the guardian that
    # decides when the batch is over. An explicit SIGTERM still ends us.
    for sig in (signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, signal.SIG_IGN)
    del lock_fd  # held purely by staying open in this process; never read or written
    with os.fdopen(pipe_fd, "rb", 0) as pipe:
        try:
            reported_done = pipe.read(1) == KEEPER_DONE
        except OSError:
            reported_done = False
    if reported_done:
        return 0  # the guardian saw the batch exit: release immediately
    # EOF without the handshake byte: the guardian died without reporting an exit.
    # Keep the lock, but only while that batch is demonstrably still alive. The pid
    # check is cheap enough to run often; the `ps` identity check (pid reuse) only
    # has to run occasionally, so a long batch does not fork `ps` every quarter second.
    last_verified = 0.0
    while True:
        now = time.time()
        verify = now - last_verified >= KEEPER_VERIFY_SECONDS
        if not batch_alive(batch_pid, marker if verify else ""):
            return 0
        if verify:
            last_verified = now
        time.sleep(KEEPER_POLL_SECONDS)


def main(argv):
    if argv and argv[0] == "--keeper":
        if len(argv) != 5:
            sys.stderr.write(USAGE)
            return 2
        return keeper(int(argv[1]), int(argv[2]), int(argv[3]), argv[4])
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
    # After the batch, so the batch cannot inherit the notify pipe: the keeper must
    # learn that the GUARDIAN is gone, not that the last descendant is.
    keeper_fd = spawn_keeper(fd, child.pid, batch_marker(cmd))
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda signum, frame: forward(child, signum))
    status = child.wait()
    # The kernel already releases the lock when this process exits; nothing here
    # deletes the lockfile, precisely so the crash path and this path agree. The
    # keeper is told explicitly so the next batch never waits on a poll interval.
    release_keeper(keeper_fd)
    return status if status >= 0 else 128 - status


def forward(child, signum):
    try:
        child.send_signal(signum)
    except OSError:
        pass


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

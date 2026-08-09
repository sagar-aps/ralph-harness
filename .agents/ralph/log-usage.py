#!/usr/bin/env python3
"""Append ONE driver/orchestrator usage line to <target>/.ralph/ledger.jsonl (#70).

This is the documented ingestion hook for the third role. The builder and the
reviewer are metered automatically (batch-loop.sh's extract_usage sidecars ->
round-usage.sh), but the DRIVER — the model that reads ORCHESTRATOR.md and
dispatches each round — runs outside that path, and on a capped plan it is often
the largest single consumer. The CLIs already print their own usage, so this hook
takes that JSON and records it in the same ledger, with the same
{pool, tokens, model, timestamp} shape, tagged role=driver|orchestrator. Once the
line is there, `ralph report` breaks it out by role and by pool.

  ralph log-usage --role driver --pool anthropic --usage-json driver.json

Accepted --usage-json shapes (all three are what the tools already emit; nothing
else is guessed at):

  1. claude family, `--output-format json`: the result object, whose `usage` block
     carries input_tokens / output_tokens / cache_read_input_tokens /
     cache_creation_input_tokens, and whose `modelUsage` map names the model.
  2. codex, `--json`: the JSONL event stream (or a single event) — usage rides
     the final `turn.completed` event as input_tokens / output_tokens /
     cached_input_tokens / cache_write_input_tokens.
  3. the harness's own per-attempt sidecar (`*.usage.json`, written by
     extract_usage): input / output / cache_read / cache_creation.

Field names per shape match extract_usage exactly, so this hook and the automatic
capture agree on the same log.

APPEND-ONLY, like every other ledger writer: existing lines are never read back,
rewritten or reordered. A malformed/unusable usage JSON is an error (exit 2) and
writes NOTHING, rather than recording a line of zeros that would silently
under-count the driver.

Usage:
  python3 log-usage.py --repo DIR --role driver|orchestrator --pool NAME
                       --usage-json FILE|-  [--model M] [--provider P]
                       [--round ID] [--run-id ID] [--json]

  --provider  prices the line in `ralph report`; defaults to the POOL name, which
              is right whenever the pool is named after its provider (anthropic,
              openai, zai, ...) and resolves through the pricing aliases. Pass it
              explicitly for a pool named anything else, or the cost is unknown.
  --model     defaults to whatever the usage JSON reports, else "unknown".
  --round     the ticket this driver pass belongs to, so its cost joins that
              round's total. Defaults to "driver" (a standing pseudo-ticket).
"""
import datetime
import json
import os
import sys

ROLES = ("driver", "orchestrator")
DEFAULT_ROUND = "driver"
UNKNOWN = "unknown"

USAGE = (
    "Usage: log-usage.py --repo DIR --role driver|orchestrator --pool NAME "
    "--usage-json FILE|- [--model M] [--provider P] [--round ID] [--run-id ID] [--json]"
)


class UsageError(Exception):
    """The usage JSON could not be turned into token counts."""


def _num(val):
    """The value if it is a real number, else None (bools are not numbers)."""
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return val
    return None


def _first_num(block, *names):
    for name in names:
        val = _num(block.get(name))
        if val is not None:
            return val
    return None


def _nonempty_str(val):
    return isinstance(val, str) and val.strip() != ""


def _model_from_object(obj):
    """The model id a CLI result object reports, or None.

    Same source as reported-model.sh: the claude family's `modelUsage` map is
    keyed by model id, and more than one key is reported as-is rather than
    picking one arbitrarily.
    """
    model_usage = obj.get("modelUsage")
    if isinstance(model_usage, dict):
        keys = sorted(k for k in model_usage if _nonempty_str(k))
        if keys:
            return keys[0] if len(keys) == 1 else "+".join(keys)
    for key in ("model", "model_id"):
        if _nonempty_str(obj.get(key)):
            return obj[key].strip()
    return None


def _usage_from_block(block):
    """Normalize a CLI `usage` block onto the sidecar field names."""
    return {
        "input": _num(block.get("input_tokens")),
        "output": _num(block.get("output_tokens")),
        # claude spells these cache_read_input_tokens / cache_creation_input_tokens;
        # codex spells them cached_input_tokens / cache_write_input_tokens.
        "cache_read": _first_num(block, "cache_read_input_tokens", "cached_input_tokens"),
        "cache_creation": _first_num(
            block, "cache_creation_input_tokens", "cache_write_input_tokens"),
    }


def _usage_from_object(obj):
    """(fields, model) for one JSON object, or (None, model) if it carries no usage."""
    if not isinstance(obj, dict):
        return None, None
    model = _model_from_object(obj)
    block = obj.get("usage")
    if isinstance(block, dict):
        return _usage_from_block(block), model
    # The harness's own sidecar shape.
    if _num(obj.get("input")) is not None or _num(obj.get("output")) is not None:
        return {
            "input": _num(obj.get("input")),
            "output": _num(obj.get("output")),
            "cache_read": _num(obj.get("cache_read")),
            "cache_creation": _num(obj.get("cache_creation")),
        }, model
    return None, model


def parse_usage(text):
    """(fields, model) from a CLI usage JSON. Raises UsageError when unusable.

    Whole-file JSON first (a claude result object or a sidecar), then JSONL: the
    LAST event that reports usage wins, which for `codex --json` is the final
    `turn.completed` — the turn totals, not an intermediate snapshot.
    """
    if not text.strip():
        raise UsageError("the usage JSON is empty")

    try:
        whole = json.loads(text)
    except ValueError:
        whole = None
    if isinstance(whole, list):
        # A JSONL stream someone collected into an array: same rule, last wins.
        fields = model = None
        for event in whole:
            event_fields, event_model = _usage_from_object(event)
            if event_fields is not None:
                fields = event_fields
            if event_model:
                model = event_model
        if fields is not None:
            return fields, model
        raise UsageError("no object in the usage JSON array reports usage")
    if whole is not None:
        fields, model = _usage_from_object(whole)
        if fields is not None:
            return fields, model
        if isinstance(whole, dict):
            raise UsageError(
                "the usage JSON has no recognisable token counts (expected a "
                "`usage` block, or the harness sidecar's input/output fields)")

    fields = None
    model = None
    saw_json_line = False
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] != "{":
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        saw_json_line = True
        line_fields, line_model = _usage_from_object(event)
        if line_fields is not None:
            fields = line_fields
        if line_model:
            model = line_model
    if fields is not None:
        return fields, model
    if saw_json_line:
        raise UsageError(
            "no event in the usage JSONL reports usage (codex reports it on the "
            "final `turn.completed` event)")
    raise UsageError("the usage JSON is not valid JSON (or JSONL)")


def tokens_record(fields):
    """The ledger's tokens block, or raise when the counts are not usable.

    input and output must be reported: without them there is nothing to record.
    A cache field the CLI does not report counts as 0 — codex, for instance,
    reports no cache-write number on this path.
    """
    missing = [name for name in ("input", "output") if fields.get(name) is None]
    if missing:
        raise UsageError(
            "the usage JSON reports no {} token count".format(" or ".join(missing)))
    input_tokens = int(fields["input"])
    output_tokens = int(fields["output"])
    cache_read = int(fields["cache_read"] or 0)
    cache_creation = int(fields["cache_creation"] or 0)
    cached = cache_read + cache_creation
    return {
        "input": input_tokens,
        "output": output_tokens,
        "cached": cached,
        "total": input_tokens + output_tokens + cached,
    }


def read_source(path):
    """The usage JSON text, from a file or from stdin when path is "-"."""
    if path == "-":
        return sys.stdin.read()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError as exc:
        raise UsageError("cannot read {}: {}".format(path, exc))


def build_record(opts, fields, model):
    """The ledger line for this driver pass."""
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    record = {
        "timestamp": timestamp,
        "round": opts["round"],
        "role": opts["role"],
        "pool": opts["pool"],
        "provider": opts["provider"],
        "model": opts["model"] or model or UNKNOWN,
        "tokens": tokens_record(fields),
        "source": "log-usage",
        "target": opts["repo"],
    }
    if opts["run_id"]:
        record["run_id"] = opts["run_id"]
    return record


def append_record(repo, record):
    """Append the line to <repo>/.ralph/ledger.jsonl. Returns the ledger path."""
    ledger_dir = os.path.join(repo, ".ralph")
    os.makedirs(ledger_dir, exist_ok=True)
    ledger = os.path.join(ledger_dir, "ledger.jsonl")
    with open(ledger, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
    return ledger


def parse_args(argv):
    opts = {
        "repo": os.getcwd(),
        "role": None,
        "pool": None,
        "usage_json": None,
        "model": None,
        "provider": None,
        "round": DEFAULT_ROUND,
        "run_id": None,
        "json": False,
    }
    flags = {
        "--repo": "repo",
        "--role": "role",
        "--pool": "pool",
        "--usage-json": "usage_json",
        "--model": "model",
        "--provider": "provider",
        "--round": "round",
        "--run-id": "run_id",
    }
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--json":
            opts["json"] = True
            i += 1
            continue
        key = flags.get(arg)
        if key:
            if i + 1 >= len(argv):
                raise UsageError("{} needs a value".format(arg))
            opts[key] = argv[i + 1]
            i += 2
            continue
        matched = False
        for flag, name in flags.items():
            if arg.startswith(flag + "="):
                opts[name] = arg[len(flag) + 1:]
                matched = True
                break
        if matched:
            i += 1
            continue
        raise UsageError("unknown log-usage option {!r}".format(arg))
    return opts


def validate(opts):
    role = (opts["role"] or "").strip().lower()
    if not role:
        raise UsageError("--role is required (one of: {})".format(", ".join(ROLES)))
    if role not in ROLES:
        # builder/reviewer are captured automatically by the loop; letting the
        # hook write them would double-count a round that is already metered.
        raise UsageError(
            "--role must be one of {} (got {!r}); builder/reviewer usage is "
            "captured automatically by the review/batch loop".format(
                ", ".join(ROLES), opts["role"]))
    opts["role"] = role

    pool = (opts["pool"] or "").strip()
    if not pool:
        raise UsageError("--pool is required (the credential pool this run drew on)")
    opts["pool"] = pool

    if not (opts["usage_json"] or "").strip():
        raise UsageError("--usage-json is required (a file, or - for stdin)")
    opts["usage_json"] = opts["usage_json"].strip()

    round_id = (opts["round"] or "").strip()
    opts["round"] = round_id or DEFAULT_ROUND

    provider = (opts["provider"] or "").strip()
    # The pool is named after its provider in every shipped example, so it is the
    # honest default; a pool named otherwise just needs --provider to be priced.
    opts["provider"] = provider or pool

    opts["model"] = (opts["model"] or "").strip() or None
    opts["run_id"] = (opts["run_id"] or "").strip() or None
    opts["repo"] = os.path.abspath(opts["repo"])
    return opts


def main(argv):
    if argv and argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    try:
        opts = validate(parse_args(argv))
        text = read_source(opts["usage_json"])
        fields, model = parse_usage(text)
        record = build_record(opts, fields, model)
    except UsageError as exc:
        print("ralph: log-usage: {}".format(exc), file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    if not os.path.isdir(opts["repo"]):
        print("ralph: log-usage: target repo not found: {}".format(opts["repo"]),
              file=sys.stderr)
        return 2

    try:
        ledger = append_record(opts["repo"], record)
    except OSError as exc:
        print("ralph: log-usage: could not append to the ledger: {}".format(exc),
              file=sys.stderr)
        return 1

    if opts["json"]:
        json.dump({"ledger": ledger, "record": record}, sys.stdout, indent=2,
                  sort_keys=True)
        sys.stdout.write("\n")
        return 0
    tokens = record["tokens"]
    print("logged {} usage to {}".format(record["role"], ledger))
    print("  round={} pool={} provider={} model={}".format(
        record["round"], record["pool"], record["provider"], record["model"]))
    print("  tokens: input={} output={} cached={} total={}".format(
        tokens["input"], tokens["output"], tokens["cached"], tokens["total"]))
    print("  see it broken out by role and pool: ralph report --repo {}".format(
        opts["repo"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

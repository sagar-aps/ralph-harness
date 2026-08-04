#!/usr/bin/env bash
# Capture the provider-REPORTED model from a raw per-attempt backend log, alongside
# (but independent of) the #40 extract_usage sidecar. extract_usage() rewrites the
# logfile in place (JSON -> plain text) so the verdict grep can read it; this must
# run BEFORE that rewrite, against the same untouched raw log, or the model id is
# already gone. It never touches extract_usage's own parsing or its usage.json shape.
#
# Field names (see .agents/ralph/references/TOKEN_ECONOMICS.md for the equivalent
# usage-field survey):
#   claude family  --output-format json   top-level `modelUsage` map, keyed by model id
#                  (added so mixed-model sessions, e.g. a Haiku subagent under a Sonnet
#                  main agent, can be broken down per model; see docs/agent-sdk cost
#                  tracking). A single key is the reported model.
#   codex          --json (JSONL)         no model id anywhere in the event stream as
#                  of this writing (upstream issue: openai/codex#14736) -> nothing to
#                  extract; the round stays "unknown" for this backend rather than
#                  guessing.
ralph_capture_reported_model() {  # <logfile> <sidecar>
  local log="$1" side="$2"
  [[ -s "$log" ]] || return 0
  python3 - "$log" "$side" <<'PY' 2>/dev/null || true
import json, sys
log, side = sys.argv[1], sys.argv[2]
try:
    raw = open(log, encoding="utf-8", errors="replace").read()
except Exception:
    sys.exit(0)
obj = None
for cand in [raw, *reversed(raw.splitlines())]:
    cand = cand.strip()
    if not cand or cand[0] != "{":
        continue
    try:
        o = json.loads(cand)
    except Exception:
        continue
    if isinstance(o, dict) and "result" in o:
        obj = o
        break
if obj is None:
    sys.exit(0)   # codex JSONL (or anything else): no model id available, stays unknown
mu = obj.get("modelUsage")
if not isinstance(mu, dict) or not mu:
    sys.exit(0)
keys = sorted(k for k in mu.keys() if isinstance(k, str) and k.strip())
if not keys:
    sys.exit(0)
# More than one model in the same attempt (e.g. a subagent on a different model) is
# reported as-is rather than picking one arbitrarily -- it will simply not string-match
# a single requested pin, which is the correct "can't confirm the pin" signal.
model = keys[0] if len(keys) == 1 else "+".join(keys)
with open(side, "w", encoding="utf-8") as fh:
    json.dump({"model": model}, fh, indent=2)
    fh.write("\n")
PY
}

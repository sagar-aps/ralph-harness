#!/usr/bin/env bash
# Emit and persist one self-describing usage record for a completed batch task.
# Token values come only from extract_usage sidecars. A missing sidecar or field
# makes the corresponding round aggregate unknown rather than a partial estimate.

ralph_round_usage_line() {  # <run-dir> <round> <builder-count> <reviewer-count> <quota-count>
  local run_dir="$1" round="$2" builder_count="$3" reviewer_count="$4" quota_count="$5"
  local timestamp builder_provider reviewer_provider builder_model reviewer_model
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  builder_provider="${BUILDER_PROVIDER:-${BUILDER:-unknown}}"
  reviewer_provider="${REVIEWER_PROVIDER:-${REVIEWER:-unknown}}"
  builder_model="${BUILDER_REQUESTED_MODEL:-default}"
  reviewer_model="${REVIEWER_REQUESTED_MODEL:-default}"

  python3 - "$run_dir" "$round" "$timestamp" \
    "$builder_provider" "$builder_model" "$reviewer_provider" "$reviewer_model" \
    "$builder_count" "$reviewer_count" "$quota_count" <<'PY'
import glob
import json
import os
import sys

(run_dir, round_id, timestamp, builder_provider, builder_model,
 reviewer_provider, reviewer_model, builder_count, reviewer_count,
 quota_count) = sys.argv[1:]
builder_count = int(builder_count)
reviewer_count = int(reviewer_count)
quota_count = int(quota_count)

sidecars = []
for role in ("builder", "reviewer"):
    sidecars.extend(glob.glob(os.path.join(
        run_dir, "task-{}-iter-*-{}.usage.json".format(round_id, role))))

expected = builder_count + reviewer_count
rows = []
for sidecar in sidecars:
    try:
        with open(sidecar, encoding="utf-8") as handle:
            value = json.load(handle)
        if isinstance(value, dict):
            rows.append(value)
    except (OSError, ValueError):
        pass

def aggregate(field):
    if expected == 0 or len(rows) != expected:
        return "unknown"
    values = [row.get(field) for row in rows]
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in values):
        return "unknown"
    return sum(values)

input_tokens = aggregate("input")
output_tokens = aggregate("output")
cache_read = aggregate("cache_read")
cache_creation = aggregate("cache_creation")
if cache_read == "unknown" or cache_creation == "unknown":
    cached_tokens = "unknown"
else:
    cached_tokens = cache_read + cache_creation
if "unknown" in (input_tokens, output_tokens, cached_tokens):
    total_tokens = "unknown"
else:
    total_tokens = input_tokens + output_tokens + cached_tokens

record = {
    "timestamp": timestamp,
    "round": "task-{}".format(round_id),
    "agents": {
        "builder": {"provider": builder_provider, "requested_model": builder_model, "role": "builder"},
        "reviewer": {"provider": reviewer_provider, "requested_model": reviewer_model, "role": "reviewer"},
    },
    "invocations": {
        "builder_attempts": builder_count,
        "reviewer_attempts": reviewer_count,
        "quota_rejected": quota_count,
    },
    "tokens": {
        "input": input_tokens,
        "output": output_tokens,
        "cached": cached_tokens,
        "total": total_tokens,
    },
}
artifact = os.path.join(run_dir, "round-usage.jsonl")
with open(artifact, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")

def shown(value):
    return str(value)

print(
    "USAGE timestamp={} round=task-{} "
    "builder_provider={} builder_model={} reviewer_provider={} reviewer_model={} roles=builder,reviewer "
    "builder_attempts={} reviewer_attempts={} quota_rejected={} "
    "input={} output={} cached={} total={}".format(
        timestamp, round_id, builder_provider, builder_model, reviewer_provider, reviewer_model,
        builder_count, reviewer_count, quota_count, shown(input_tokens), shown(output_tokens),
        shown(cached_tokens), shown(total_tokens)))
PY
}

#!/usr/bin/env python3
"""Read .ralph/ledger.jsonl and print a per-ticket cost/iteration summary.

Usage: python3 report.py <target-repo> [--json]
"""
import json
import os
import sys


def main():
    if len(sys.argv) < 2:
        print("Usage: report.py <target-repo> [--json]", file=sys.stderr)
        sys.exit(1)

    target_repo = sys.argv[1]
    as_json = "--json" in sys.argv[2:]

    ledger_path = os.path.join(target_repo, ".ralph", "ledger.jsonl")

    if not os.path.isfile(ledger_path):
        print("no usage recorded yet")
        sys.exit(0)

    lines = []
    bad = 0
    try:
        with open(ledger_path, "r", encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    lines.append(json.loads(raw))
                except (ValueError, json.JSONDecodeError):
                    bad += 1
    except OSError:
        print("no usage recorded yet")
        sys.exit(0)

    if not lines:
        print("no usage recorded yet")
        sys.exit(0)

    # Group by ticket/round id and collect distinct run_ids
    groups = {}  # round -> list of records
    run_ids = set()
    for rec in lines:
        round_id = rec.get("round", "unknown")
        groups.setdefault(round_id, []).append(rec)
        run_id = rec.get("run_id")
        if run_id:
            run_ids.add(run_id)

    # Build per-ticket summary
    tickets = []
    grand_builder = 0
    grand_reviewer = 0
    grand_quota = 0
    grand_input = 0
    grand_output = 0
    grand_cached = 0
    grand_total = 0
    grand_unknown = False  # if any token field is "unknown" across any line

    for round_id in sorted(groups.keys()):
        recs = groups[round_id]
        n_rounds = len(recs)

        builder_attempts = 0
        reviewer_attempts = 0
        quota_rejected = 0

        input_tokens = 0
        output_tokens = 0
        cached_tokens = 0
        total_tokens = 0
        unknown_tokens = False

        builder_models = set()
        reviewer_models = set()

        for rec in recs:
            inv = rec.get("invocations", {})
            if isinstance(inv, dict):
                builder_attempts += _safe_int(inv.get("builder_attempts"))
                reviewer_attempts += _safe_int(inv.get("reviewer_attempts"))
                quota_rejected += _safe_int(inv.get("quota_rejected"))

            tok = rec.get("tokens", {})
            if isinstance(tok, dict):
                for field in ("input", "output", "cached", "total"):
                    val = tok.get(field)
                    if val == "unknown":
                        unknown_tokens = True
                    else:
                        n = _safe_int(val)
                        if field == "input":
                            input_tokens += n
                        elif field == "output":
                            output_tokens += n
                        elif field == "cached":
                            cached_tokens += n
                        elif field == "total":
                            total_tokens += n

            agents = rec.get("agents", {})
            if isinstance(agents, dict):
                for role_key in ("builder", "reviewer"):
                    agent = agents.get(role_key)
                    if isinstance(agent, dict):
                        provider = agent.get("provider", "unknown")
                        model = agent.get("requested_model", "default")
                        entry = "{}:{}".format(provider, model)
                        if role_key == "builder":
                            builder_models.add(entry)
                        else:
                            reviewer_models.add(entry)

        ticket = {
            "round": round_id,
            "rounds": n_rounds,
            "builder_attempts": builder_attempts,
            "reviewer_attempts": reviewer_attempts,
            "quota_rejected": quota_rejected,
            "tokens": {
                "input": "unknown" if unknown_tokens else input_tokens,
                "output": "unknown" if unknown_tokens else output_tokens,
                "cached": "unknown" if unknown_tokens else cached_tokens,
                "total": "unknown" if unknown_tokens else total_tokens,
            },
            "builder_providers": sorted(builder_models),
            "reviewer_providers": sorted(reviewer_models),
        }
        tickets.append(ticket)

        grand_builder += builder_attempts
        grand_reviewer += reviewer_attempts
        grand_quota += quota_rejected
        grand_input += input_tokens
        grand_output += output_tokens
        grand_cached += cached_tokens
        grand_total += total_tokens
        if unknown_tokens:
            grand_unknown = True

    grand_tokens = {
        "input": "unknown" if grand_unknown else grand_input,
        "output": "unknown" if grand_unknown else grand_output,
        "cached": "unknown" if grand_unknown else grand_cached,
        "total": "unknown" if grand_unknown else grand_total,
    }

    result = {
        "runs": len(run_ids),
        "builder_attempts": grand_builder,
        "reviewer_attempts": grand_reviewer,
        "quota_rejected": grand_quota,
        "tokens": grand_tokens,
        "tickets": tickets,
    }

    if as_json:
        json.dump(result, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        # Human-readable output
        print("  runs: {}".format(result["runs"]))
        print("  rounds (total): {}".format(sum(t["rounds"] for t in tickets)))
        print()
        print("  totals:")
        print("    builder_attempts: {}".format(grand_builder))
        print("    reviewer_attempts: {}".format(grand_reviewer))
        print("    quota_rejected:   {}".format(grand_quota))
        print("    tokens:")
        print("      input:  {}".format(_shown(grand_tokens["input"])))
        print("      output: {}".format(_shown(grand_tokens["output"])))
        print("      cached: {}".format(_shown(grand_tokens["cached"])))
        print("      total:  {}".format(_shown(grand_tokens["total"])))
        print()
        if not tickets:
            print("  (no tickets)")
        else:
            for t in tickets:
                print("  {}:".format(t["round"]))
                print("    rounds: {}".format(t["rounds"]))
                print("    builder_attempts: {}".format(t["builder_attempts"]))
                print("    reviewer_attempts: {}".format(t["reviewer_attempts"]))
                print("    quota_rejected:   {}".format(t["quota_rejected"]))
                print("    tokens:")
                print("      input:  {}".format(_shown(t["tokens"]["input"])))
                print("      output: {}".format(_shown(t["tokens"]["output"])))
                print("      cached: {}".format(_shown(t["tokens"]["cached"])))
                print("      total:  {}".format(_shown(t["tokens"]["total"])))
                if t["builder_providers"]:
                    print("    builder provider+model: {}".format(
                        ", ".join(t["builder_providers"])))
                if t["reviewer_providers"]:
                    print("    reviewer provider+model: {}".format(
                        ", ".join(t["reviewer_providers"])))
                print()

    if bad:
        print("note: {} malformed line(s) skipped".format(bad), file=sys.stderr)


def _safe_int(val):
    """Return int(val) or 0 if val is not a number."""
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return int(val)
    try:
        return int(val)
    except (ValueError, TypeError):
        return 0


def _shown(val):
    """Format a value for display (handles 'unknown' strings)."""
    if val == "unknown":
        return "unknown"
    return str(val)


if __name__ == "__main__":
    main()

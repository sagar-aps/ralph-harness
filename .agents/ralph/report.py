#!/usr/bin/env python3
"""Read .ralph/ledger.jsonl and print a per-ticket cost/iteration summary.

Cost is computed as captured tokens x the producing backend's provider rate
(NOT the CLI's total_cost_usd). Provider rates come from a pricing table;
unknown providers yield cost=unknown.

Usage: python3 report.py <target-repo> [--json]
"""
import json
import os
import sys


def _load_pricing():
    """Load the per-provider pricing table.

    Looks for RALPH_PRICING_FILE in the environment, then falls back to the
    default pricing.json shipped next to this script.
    """
    env_file = os.environ.get("RALPH_PRICING_FILE", "")
    if env_file and os.path.isfile(env_file):
        try:
            with open(env_file, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError, json.JSONDecodeError):
            pass

    default = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pricing.json")
    if os.path.isfile(default):
        try:
            with open(default, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError, json.JSONDecodeError):
            pass

    return {"providers": {}, "aliases": {}}


def _resolve_provider(name, pricing):
    """Resolve a backend provider name to a canonical pricing key.

    Returns the canonical provider name (e.g. "anthropic") if the backend
    name is known directly or via an alias, or None if unknown.
    """
    if not isinstance(name, str) or not name.strip():
        return None
    name = name.strip()
    providers = pricing.get("providers", {})
    aliases = pricing.get("aliases", {})
    if name in providers:
        return name
    if name in aliases:
        canonical = aliases[name]
        if canonical in providers:
            return canonical
    return None


def _compute_cost(tokens, provider_name, pricing):
    """Compute cost in USD from a token dict and a canonical provider name.

    tokens: dict with keys input, output, cached (int or "unknown").
    provider_name: canonical provider key in pricing["providers"].
    pricing: the full pricing dict.

    Returns a float USD cost, or "unknown" if tokens are unknown or provider
    is missing.
    """
    rates = pricing.get("providers", {}).get(provider_name)
    if not isinstance(rates, dict):
        return "unknown"

    input_tok = tokens.get("input")
    output_tok = tokens.get("output")
    cached_tok = tokens.get("cached")

    if input_tok == "unknown" or output_tok == "unknown" or cached_tok == "unknown":
        return "unknown"

    inp = _safe_int(input_tok)
    out = _safe_int(output_tok)
    cached = _safe_int(cached_tok)
    if inp == 0 and out == 0 and cached == 0:
        return 0.0

    cost = 0.0
    if inp:
        cost += (inp / 1_000_000.0) * _safe_float(rates.get("input", 0))
    if out:
        cost += (out / 1_000_000.0) * _safe_float(rates.get("output", 0))
    if cached:
        cache_rate = _safe_float(rates.get("cache_read", 0))
        cost += (cached / 1_000_000.0) * cache_rate
    return round(cost, 6)


def main():
    if len(sys.argv) < 2:
        print("Usage: report.py <target-repo> [--json]", file=sys.stderr)
        sys.exit(1)

    target_repo = sys.argv[1]
    as_json = "--json" in sys.argv[2:]

    pricing = _load_pricing()

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
                    rec = json.loads(raw)
                except (ValueError, json.JSONDecodeError):
                    bad += 1
                    continue
                # The ledger is an append-only log, and since #64 it also carries
                # EVENT records (an escalation from one rung to another) that are
                # not usage rounds: they have no token totals, so counting them
                # would invent an "unknown" ticket with an unknown cost.
                if isinstance(rec, dict) and rec.get("event"):
                    continue
                lines.append(rec)
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
    grand_cost = 0.0
    grand_unknown = False  # if any token field is "unknown" across any line
    grand_cost_unknown = False  # if any cost is unknown across any line

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

        ticket_cost = 0.0
        ticket_cost_unknown = False
        ticket_cost_providers = set()

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

            # Compute cost for this ledger line using the builder's provider.
            line_provider = (
                agents.get("builder", {}).get("provider", "unknown")
                if isinstance(agents, dict)
                else "unknown"
            )
            canonical = _resolve_provider(line_provider, pricing)
            if canonical is None:
                ticket_cost_unknown = True
            else:
                ticket_cost_providers.add(canonical)
                line_cost = _compute_cost(tok, canonical, pricing)
                if line_cost == "unknown":
                    ticket_cost_unknown = True
                else:
                    ticket_cost += line_cost

        if ticket_cost_unknown:
            ticket_cost_display = "unknown"
        else:
            ticket_cost_display = round(ticket_cost, 6)

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
            "cost_usd": ticket_cost_display,
            "cost_providers": sorted(ticket_cost_providers),
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
        if ticket_cost_unknown:
            grand_cost_unknown = True
        else:
            grand_cost += ticket_cost

    grand_tokens = {
        "input": "unknown" if grand_unknown else grand_input,
        "output": "unknown" if grand_unknown else grand_output,
        "cached": "unknown" if grand_unknown else grand_cached,
        "total": "unknown" if grand_unknown else grand_total,
    }

    if grand_cost_unknown:
        grand_cost_display = "unknown"
    else:
        grand_cost_display = round(grand_cost, 6)

    result = {
        "runs": len(run_ids),
        "builder_attempts": grand_builder,
        "reviewer_attempts": grand_reviewer,
        "quota_rejected": grand_quota,
        "tokens": grand_tokens,
        "cost_usd": grand_cost_display,
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
        if grand_cost_display != "unknown":
            print("    cost_usd:         ${:.6f}".format(grand_cost_display))
        else:
            print("    cost_usd:         unknown")
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
                cost_val = t["cost_usd"]
                if cost_val != "unknown":
                    print("    cost_usd:         ${:.6f}".format(cost_val))
                else:
                    print("    cost_usd:         unknown")
                if t["cost_providers"]:
                    print("    cost providers:   {}".format(
                        ", ".join(t["cost_providers"])))
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


def _safe_float(val):
    """Return float(val) or 0.0 if val is not a number."""
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return float(val)
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


def _shown(val):
    """Format a value for display (handles 'unknown' strings)."""
    if val == "unknown":
        return "unknown"
    return str(val)


if __name__ == "__main__":
    main()

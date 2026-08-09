#!/usr/bin/env python3
"""Read .ralph/ledger.jsonl and print a per-ticket cost/iteration summary.

Cost is computed as captured tokens x the producing backend's provider rate
(NOT the CLI's total_cost_usd). Provider rates come from a pricing table;
unknown providers yield cost=unknown.

Totals are also broken out BY ROLE and BY POOL (#70), because the dispatched
builder/reviewer are not the only consumers: the DRIVER (the orchestrator model
that reads ORCHESTRATOR.md and dispatches each round) is often the largest one,
and `ralph log-usage` writes its rounds into the same ledger.

Usage: python3 report.py <target-repo> [--json]
"""
import json
import os
import sys

# A ledger line is one of two shapes, and the difference decides what a "role"
# total can honestly say (#70):
#   * a ROUND record (round-usage.sh) — builder AND reviewer, with ONE token
#     total for the whole round (their sidecars are summed), so there is no
#     per-role split to report and the line lands in the combined bucket below;
#   * a SINGLE-ROLE record carrying a top-level "role" — what `ralph log-usage`
#     appends for the driver/orchestrator. Its tokens ARE that role's.
# Whatever role a single-role line names is reported as-is: this is a reader, and
# what may be WRITTEN is validated by the writer (log-usage.py).
ROUND_ROLE = "builder+reviewer"

# Used when a line names no credential pool: a round dispatched without
# efficiency mode records no pool, and nothing is invented for it.
UNKNOWN_POOL = "unknown"


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


def _entry_role(rec):
    """The role a ledger line belongs to, or None for a builder/reviewer round.

    Only a top-level "role" makes a line single-role; the per-agent "role" keys
    inside a round record's "agents" block describe both roles of one shared
    token total and are deliberately not read here.
    """
    role = rec.get("role")
    if isinstance(role, str) and role.strip():
        return role.strip().lower()
    return None


def _entry_pools(rec):
    """(pool, reviewer_pool) for a ledger line — never invented.

    A single-role line names its pool directly. A round record only knows one
    when efficiency mode picked the rung, which round-usage.sh records as
    builder_pool/reviewer_pool in its "efficiency" block. Otherwise the line is
    reported under the "unknown" pool rather than guessed at from the provider.
    """
    pool = rec.get("pool")
    if isinstance(pool, str) and pool.strip():
        return pool.strip(), None
    efficiency = rec.get("efficiency")
    if isinstance(efficiency, dict):
        builder_pool = efficiency.get("builder_pool")
        reviewer_pool = efficiency.get("reviewer_pool")
        builder_pool = builder_pool.strip() if isinstance(builder_pool, str) else ""
        reviewer_pool = reviewer_pool.strip() if isinstance(reviewer_pool, str) else ""
        if builder_pool:
            return builder_pool, (reviewer_pool or None)
    return UNKNOWN_POOL, None


def _entry_provider(rec):
    """The provider whose rate prices this line.

    A single-role line carries its own; a round record is priced by its
    builder's provider, exactly as it always has been.
    """
    if _entry_role(rec) is not None:
        provider = rec.get("provider")
        if isinstance(provider, str) and provider.strip():
            return provider.strip()
        return "unknown"
    agents = rec.get("agents")
    if isinstance(agents, dict):
        builder = agents.get("builder")
        if isinstance(builder, dict):
            return builder.get("provider", "unknown")
    return "unknown"


def _entry_model_label(rec):
    """"<provider>:<model>" for a single-role line."""
    model = rec.get("model")
    model = model.strip() if isinstance(model, str) and model.strip() else "unknown"
    return "{}:{}".format(_entry_provider(rec), model)


def _new_bucket():
    """An empty role/pool accumulator."""
    return {
        "entries": 0,
        "input": 0,
        "output": 0,
        "cached": 0,
        "total": 0,
        "unknown_tokens": False,
        "cost": 0.0,
        "cost_unknown": False,
        "models": set(),
        "roles": set(),
        "pools": {},
    }


def _bucket_add_tokens(bucket, tok):
    """Add one line's token dict to a bucket ("unknown" poisons that bucket)."""
    if not isinstance(tok, dict):
        bucket["unknown_tokens"] = True
        return
    for field in ("input", "output", "cached", "total"):
        val = tok.get(field)
        if val == "unknown":
            bucket["unknown_tokens"] = True
        else:
            bucket[field] += _safe_int(val)


def _bucket_view(bucket):
    """The reportable view of a bucket (same unknown semantics as a ticket)."""
    return {
        "entries": bucket["entries"],
        "tokens": {
            field: "unknown" if bucket["unknown_tokens"] else bucket[field]
            for field in ("input", "output", "cached", "total")
        },
        "cost_usd": "unknown" if bucket["cost_unknown"] else round(bucket["cost"], 6),
        "models": sorted(bucket["models"]),
    }


def _cost_shown(value):
    """Format a cost for humans ("unknown" stays a word)."""
    if value == "unknown":
        return "unknown"
    return "${:.6f}".format(value)


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

    # #70: the same lines, aggregated on the two dimensions a capped plan is
    # actually reasoned about — who spent it (role) and out of which credential
    # pool. Both are filled from the same pass over the records below.
    role_totals = {}
    pool_totals = {}
    mixed_pool_rounds = 0

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

            # Role/pool breakout (#70). A round record has no per-role token
            # split, so it lands whole in the combined ROUND_ROLE bucket; a
            # driver/orchestrator line written by `ralph log-usage` is broken
            # out on its own.
            line_role = _entry_role(rec) or ROUND_ROLE
            line_pool, line_reviewer_pool = _entry_pools(rec)
            if line_reviewer_pool and line_reviewer_pool != line_pool:
                mixed_pool_rounds += 1
            role_bucket = role_totals.setdefault(line_role, _new_bucket())
            pool_bucket = pool_totals.setdefault(line_pool, _new_bucket())
            role_pool_bucket = role_bucket["pools"].setdefault(line_pool, _new_bucket())
            line_buckets = (role_bucket, pool_bucket, role_pool_bucket)
            for bucket in line_buckets:
                bucket["entries"] += 1
                _bucket_add_tokens(bucket, tok)
            pool_bucket["roles"].add(line_role)
            if line_role != ROUND_ROLE:
                label = _entry_model_label(rec)
                role_bucket["models"].add(label)
                role_pool_bucket["models"].add(label)
                pool_bucket["models"].add(label)

            agents = rec.get("agents", {})
            if isinstance(agents, dict):
                for role_key in ("builder", "reviewer"):
                    agent = agents.get(role_key)
                    if isinstance(agent, dict):
                        provider = agent.get("provider", "unknown")
                        model = agent.get("requested_model", "default")
                        entry = "{}:{}".format(provider, model)
                        role_bucket["models"].add(entry)
                        role_pool_bucket["models"].add(entry)
                        pool_bucket["models"].add(entry)
                        if role_key == "builder":
                            builder_models.add(entry)
                        else:
                            reviewer_models.add(entry)

            # Compute cost for this ledger line: a round is priced by its
            # builder's provider, a single-role line by its own.
            line_provider = _entry_provider(rec)
            canonical = _resolve_provider(line_provider, pricing)
            if canonical is None:
                ticket_cost_unknown = True
                for bucket in line_buckets:
                    bucket["cost_unknown"] = True
            else:
                ticket_cost_providers.add(canonical)
                line_cost = _compute_cost(tok, canonical, pricing)
                if line_cost == "unknown":
                    ticket_cost_unknown = True
                    for bucket in line_buckets:
                        bucket["cost_unknown"] = True
                else:
                    ticket_cost += line_cost
                    for bucket in line_buckets:
                        bucket["cost"] += line_cost

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

    # #70: the by-role and by-pool views of the same lines.
    by_role = []
    for role in sorted(role_totals):
        bucket = role_totals[role]
        view = _bucket_view(bucket)
        view["role"] = role
        view["pools"] = []
        for pool in sorted(bucket["pools"]):
            pool_view = _bucket_view(bucket["pools"][pool])
            pool_view["pool"] = pool
            view["pools"].append(pool_view)
        by_role.append(view)

    by_pool = []
    for pool in sorted(pool_totals):
        bucket = pool_totals[pool]
        view = _bucket_view(bucket)
        view["pool"] = pool
        view["roles"] = sorted(bucket["roles"])
        by_pool.append(view)

    notes = []
    if ROUND_ROLE in role_totals:
        notes.append(
            'a builder/reviewer round carries ONE token total for the whole round '
            '(the ledger has no per-role split), so those lines are reported under '
            'the combined role "{}"; a driver/orchestrator line written by '
            '`ralph log-usage` is single-role and is broken out on its own'.format(
                ROUND_ROLE))
    if UNKNOWN_POOL in pool_totals:
        notes.append(
            'pool "{}" = lines that name no credential pool (a round dispatched '
            'without efficiency mode records none); no pool is inferred for '
            'them'.format(UNKNOWN_POOL))
    if mixed_pool_rounds:
        notes.append(
            "{} round(s) drew on a different pool for the reviewer than for the "
            "builder; with one token total per round they are attributed to the "
            "builder's pool".format(mixed_pool_rounds))

    result = {
        "runs": len(run_ids),
        "builder_attempts": grand_builder,
        "reviewer_attempts": grand_reviewer,
        "quota_rejected": grand_quota,
        "tokens": grand_tokens,
        "cost_usd": grand_cost_display,
        "by_role": by_role,
        "by_pool": by_pool,
        "notes": notes,
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
        print("  by role:")
        for row in by_role:
            print("    {}: {} line(s), tokens {}, cost {}".format(
                row["role"], row["entries"], _shown(row["tokens"]["total"]),
                _cost_shown(row["cost_usd"])))
            for pool_row in row["pools"]:
                print("      pool {}: {} line(s), tokens {}, cost {}".format(
                    pool_row["pool"], pool_row["entries"],
                    _shown(pool_row["tokens"]["total"]),
                    _cost_shown(pool_row["cost_usd"])))
            if row["models"]:
                print("      provider+model: {}".format(", ".join(row["models"])))
        print()
        print("  by pool:")
        for row in by_pool:
            print("    {}: {} line(s), tokens {}, cost {} (roles: {})".format(
                row["pool"], row["entries"], _shown(row["tokens"]["total"]),
                _cost_shown(row["cost_usd"]), ", ".join(row["roles"])))
        print()
        for note in notes:
            print("  note: {}".format(note))
        if notes:
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

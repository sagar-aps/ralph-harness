#!/usr/bin/env python3
"""Pick the orchestrator DRIVER by LIVE per-pool usage (#76).

The operator's cron wiring picks the driver (`RALPH_CRON_DRIVER`, #52) by hand or
by the clock — a static proxy for "which pool is cheaper now" that is blind to the
actual numbers: at 08:00 UTC it still picks codex when the openai pool sits at 95 %
and the zai pool at 10 %. The harness already knows better, because #60/#68 read
per-pool usage (ledger token sums vs the profile's budgets, or a pool's own
`usage_provider` adapter for a %-only plan) and #63 knows which reserves a pool
carries. This is the missing ENTRY POINT: given the candidate drivers, it prints
the one whose credential pool has the most HEADROOM right now.

Headroom, per candidate, is the distance to the first gate that would stop it:

    headroom = min(5h ceiling - 5h used, weekly ceiling - weekly used)

    * the 5h ceiling is the pool's `window_5h_pct` cap (100 % when it declares
      none). It is a rate limit and is never relaxed;
    * the weekly ceiling is its `window_weekly_pct` cap, further reduced by the
      weekly RESERVE that OTHER control-plane roles hold on that pool (#63) — the
      manager's, typically. The orchestrator's own reserve is deliberately NOT
      subtracted: the driver IS the orchestrator, so that share is quota set aside
      for exactly this run, not quota it must leave alone;
    * near the weekly reset (`reserves.near_weekly_reset_hours`) the weekly cap and
      the reserve are lifted, exactly as `efficiency.py select` lifts them — quota
      about to expire is quota you may as well spend.

Every number comes from the existing readers (`efficiency.read_ledger_usage` ->
`usage-state.py`, including the #68 adapters and the ledger fallback); nothing is
re-implemented and no percentage is invented here.

FAIL-OPEN is the contract, matching the usage-provider convention: a candidate with
no usable percentage for either window is reported as unavailable and left out of
the ranking, and when NO candidate can be ranked (no usage data anywhere, a missing
or rejected profile, a broken adapter, no candidates at all) the documented DEFAULT
is printed instead and said to be a fallback. It never errors out.

READ-ONLY and NON-DISPATCHING: it opens the ledger and the profile for reading,
runs each pool's own usage adapter (which is what that adapter is for), writes
nothing, mutates no ledger, and starts no agent. The operator/cron decides whether
to use the answer — nothing in the harness calls this on its own.

Usage:
  pick-driver.py [--candidate NAME[=POOL]]... [--candidates "a,b"] [--repo DIR]
                 [--profile PATH] [--default NAME] [--exhausted-pool POOL]...
                 [--json|--shell]

Candidates, in precedence order: --candidate/--candidates, then
RALPH_CRON_DRIVER_CANDIDATES, then every backend the efficiency profile's rungs
declare (cheapest rung first). A candidate is `backend` (its pool is looked up in
the profile's rungs) or `backend=pool` when the profile does not map it.

stdout is ONLY the driver name, so a cron script can use it directly:

    RALPH_CRON_DRIVER="$(ralph pick-driver --candidates codex,zlaude)"

The reasoning goes to stderr; --json / --shell print the full record instead.

Test/ops seam: RALPH_EFFICIENCY_NOW overrides "now" (ISO-8601 UTC).
"""
import json
import os
import sys

STATUS_SELECTED = "selected"
STATUS_DEFAULT = "default"

# A candidate list an operator/cron can export once instead of passing every time.
CANDIDATES_ENV = "RALPH_CRON_DRIVER_CANDIDATES"

# Why a candidate could not be ranked / was held back.
UNAVAILABLE_NO_POOL = ("no pool: the efficiency profile maps this backend to no "
                       "credential pool (pass it as {}=<pool>)")
UNAVAILABLE_NO_PCT = ("no usage percentage for either window — FAIL-OPEN (nothing "
                      "is invented; see the notes for why)")
UNAVAILABLE_NO_PROFILE = ("nothing to measure against: no usable efficiency profile "
                          "(see the note above) — FAIL-OPEN")
BLOCKED_CIRCUIT = "#28 quota circuit is OPEN (the caller reported this pool exhausted)"
BLOCKED_AVOID = "an avoid window on this pool is ACTIVE now"

USAGE = (
    "Usage: pick-driver.py [--candidate NAME[=POOL]]... [--candidates \"a,b\"]\n"
    "                      [--repo DIR] [--profile PATH] [--default NAME]\n"
    "                      [--exhausted-pool POOL]... [--json|--shell]")


# ---------------------------------------------------------------------------
# Siblings — every computation is delegated, none is duplicated here
# ---------------------------------------------------------------------------
def load_efficiency():
    """Import the sibling efficiency.py by path, or None when it cannot be loaded.

    It owns profile loading/validation, `read_ledger_usage` (which drives
    usage-state.py and the #68 adapters), the role->pool resolution and the
    reserve arithmetic. Without it there is no usage view at all, which is a
    fail-open case, not an error.
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "efficiency.py")
    if not os.path.isfile(path):
        return None
    try:
        import importlib.util
        # Never leave a __pycache__ behind in the template dir — that would dirty a
        # target repo working tree.
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location("ralph_efficiency_for_pick_driver", path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:  # a broken sibling must not take this entry point down
        return None


def is_number(val):
    return isinstance(val, (int, float)) and not isinstance(val, bool)


def is_pct(val):
    return is_number(val) and 0 <= val <= 100


# ---------------------------------------------------------------------------
# Candidates
# ---------------------------------------------------------------------------
def split_candidate(text):
    """"backend" or "backend=pool" -> (name, pool|None)."""
    raw = (text or "").strip()
    if not raw:
        return None, None
    name, sep, pool = raw.partition("=")
    name = name.strip()
    pool = pool.strip() if sep else ""
    return (name or None), (pool or None)


def split_list(text):
    """Split a candidate list on commas and whitespace."""
    return [part for part in (text or "").replace(",", " ").split() if part]


def dedupe_candidates(pairs):
    """Keep the first (name, pool) for each name, preserving the given order."""
    out = []
    seen = set()
    for name, pool in pairs:
        if not name or name in seen:
            continue
        seen.add(name)
        out.append((name, pool))
    return out


def resolve_candidates(explicit, profile, efficiency):
    """(candidates, source) — what to choose between, in preference order.

    Precedence: the CLI list, then RALPH_CRON_DRIVER_CANDIDATES, then every backend
    the profile's rungs declare (cheapest rung first, since that is the ladder's own
    order of preference).
    """
    if explicit:
        return dedupe_candidates(explicit), "--candidate/--candidates"
    from_env = [split_candidate(part) for part in split_list(os.environ.get(CANDIDATES_ENV, ""))]
    from_env = dedupe_candidates(from_env)
    if from_env:
        return from_env, CANDIDATES_ENV
    if profile is not None and efficiency is not None:
        # backend_pools is insertion-ordered by the ladder, cheapest rung first, and
        # keeps each backend's declared spelling (which is what pool_for_backend and
        # resolve_backend_cmd both key on).
        pairs = dedupe_candidates(list(efficiency.backend_pools(profile).items()))
        if pairs:
            return pairs, "the efficiency profile's rung backends (cheapest first)"
    return [], "none"


# ---------------------------------------------------------------------------
# The documented fail-open default
# ---------------------------------------------------------------------------
def env_default_driver():
    """The documented RALPH_CRON_DRIVER chain, read straight from the environment.

    Only used when agents.sh cannot be probed (no efficiency.py to probe with, or
    no agents.sh next to it): the chain itself is
    RALPH_CRON_DRIVER -> RALPH_CRON_DRIVER_DEFAULT -> DEFAULT_AGENT (config.sh §4).
    """
    for var in ("RALPH_CRON_DRIVER", "RALPH_CRON_DRIVER_DEFAULT", "DEFAULT_AGENT"):
        value = os.environ.get(var, "").strip()
        if value:
            return value, "{} in the environment".format(var)
    return None, None


def resolve_default_driver(explicit, efficiency, candidates):
    """(driver, source) — what to fall back to when live usage cannot decide.

    Precedence:
      1. --default NAME — the caller's own rule (e.g. the calendar rule a cron
         script used before it consulted live usage);
      2. whatever RALPH_CRON_DRIVER resolves to right now, asked of #52's own
         resolver (agents.sh:ralph_resolve_cron_driver) so the default chain lives
         in exactly one place;
      3. the environment chain directly, when that resolver cannot be reached;
      4. the first candidate, so an operator who named candidates still gets one.
    """
    if explicit and explicit.strip():
        return explicit.strip(), "--default (the caller's own rule, e.g. its calendar rule)"
    if efficiency is not None:
        names = efficiency.cron_driver_candidates()
        if names:
            return names[0], ("RALPH_CRON_DRIVER resolves to {!r} (agents.sh:"
                              "ralph_resolve_cron_driver, incl. its documented default "
                              "chain)".format(names[0]))
    name, source = env_default_driver()
    if name:
        return name, source
    if candidates:
        return candidates[0][0], "the first candidate (no RALPH_CRON_DRIVER default could be resolved)"
    return None, None


# ---------------------------------------------------------------------------
# Headroom
# ---------------------------------------------------------------------------
def pool_cap_pct(usage_state, profile, pool, field):
    """A pool's declared window cap percentage, cheapest rung first, or None."""
    value, _conflicts = usage_state.pool_cap_value(profile, pool, field)
    return float(value) if is_pct(value) else None


def avoid_window_pools(usage):
    """The pools whose avoid window is active right now, per usage-state.py."""
    state = usage.get("state") if isinstance(usage, dict) else None
    if not isinstance(state, dict):
        return set()
    return set(rec["pool"] for rec in state.get("records", [])
               if rec.get("in_avoid_window"))


def evaluate_candidate(name, pool, usage, profile, efficiency, usage_state, reserves,
                       exhausted, avoiding, now, near_hours):
    """One candidate's headroom (or why it has none). Pure and read-only."""
    record = {
        "name": name, "pool": pool, "headroom_pct": None,
        "binding_window": None, "used_5h_pct": None, "used_weekly_pct": None,
        "pct_source_5h": None, "pct_source_weekly": None,
        "ceiling_5h_pct": None, "ceiling_weekly_pct": None,
        "cap_5h_pct": None, "cap_weekly_pct": None,
        "reserve_pct": None, "reserve_detail": None,
        "headroom_5h_pct": None, "headroom_weekly_pct": None,
        "weekly_reset_at": None, "relaxed": False,
        "ranked": False, "blocked": None, "unavailable": None,
    }
    if pool is None:
        record["unavailable"] = UNAVAILABLE_NO_POOL.format(name)
        return record
    if pool in exhausted:
        record["blocked"] = BLOCKED_CIRCUIT
        return record
    if pool in avoiding:
        record["blocked"] = BLOCKED_AVOID
        return record

    entry = (usage.get("pools") or {}).get(pool) or {}
    used_5h = entry.get("window_5h_pct")
    used_weekly = entry.get("window_weekly_pct")
    record["used_5h_pct"] = used_5h
    record["used_weekly_pct"] = used_weekly
    # Where each percentage came from, keyed exactly as read_ledger_usage records it
    # ("<field>_source": budget | quota | provider_pct).
    record["pct_source_5h"] = entry.get("window_5h_pct_source")
    record["pct_source_weekly"] = entry.get("window_weekly_pct_source")
    record["weekly_reset_at"] = entry.get("weekly_reset_at")
    if used_5h is None and used_weekly is None:
        record["unavailable"] = UNAVAILABLE_NO_PCT
        return record

    cap_5h = pool_cap_pct(usage_state, profile, pool, "window_5h_pct")
    cap_weekly = pool_cap_pct(usage_state, profile, pool, "window_weekly_pct")
    stacked = reserves.get(pool)
    reserve = stacked["pct"] if stacked else None
    record["cap_5h_pct"] = cap_5h
    record["cap_weekly_pct"] = cap_weekly
    record["reserve_pct"] = reserve
    if stacked:
        record["reserve_detail"] = efficiency._reserve_parts_label(stacked)

    # The weekly gates are lifted near the weekly reset, exactly as select_rung
    # lifts them. The rolling 5h cap is a rate limit and is never relaxed.
    hours = efficiency._hours_to_reset(entry.get("weekly_reset_at"), now)
    relaxed = hours is not None and hours <= near_hours
    record["relaxed"] = bool(relaxed)

    ceiling_5h = 100.0 if cap_5h is None else cap_5h
    if relaxed:
        ceiling_weekly = 100.0
    else:
        ceiling_weekly = 100.0 if cap_weekly is None else cap_weekly
        if reserve:
            ceiling_weekly = min(ceiling_weekly, 100.0 - reserve)
    record["ceiling_5h_pct"] = round(ceiling_5h, 1)
    record["ceiling_weekly_pct"] = round(ceiling_weekly, 1)

    if used_5h is not None:
        record["headroom_5h_pct"] = round(ceiling_5h - float(used_5h), 1)
    if used_weekly is not None:
        record["headroom_weekly_pct"] = round(ceiling_weekly - float(used_weekly), 1)
    known = [(record["headroom_5h_pct"], "5h"), (record["headroom_weekly_pct"], "weekly")]
    known = [pair for pair in known if pair[0] is not None]
    headroom, window = min(known)
    record["headroom_pct"] = headroom
    record["binding_window"] = window
    record["ranked"] = True
    return record


def pick_driver(repo, candidates, default_driver, default_source, profile_arg,
                exhausted, efficiency):
    """The decision. Returns the full record; never raises."""
    usage_state = getattr(efficiency, "USAGE_STATE", None) if efficiency else None
    now = efficiency.now_utc() if efficiency else None
    notes = []
    loaded = {"status": "unavailable", "path": None, "errors": []}
    profile = None

    if efficiency is None or usage_state is None:
        notes.append("efficiency.py / usage-state.py are not available next to "
                     "pick-driver.py — no live usage can be read; failing open to the "
                     "default")
    else:
        loaded = efficiency.load_profile(
            efficiency.resolve_profile_path(profile_arg, repo))
        if loaded["status"] == efficiency.STATUS_VALID:
            profile = loaded["profile"]
        elif loaded["status"] == efficiency.STATUS_REJECTED:
            efficiency.warn_rejected(loaded)
            notes.append("the efficiency profile {} was REJECTED — no pools, caps or "
                         "reserves can be read from it; failing open to the "
                         "default".format(loaded["path"]))
        else:
            notes.append("no efficiency profile at {} — no pools, caps or reserves are "
                         "configured; failing open to the default".format(loaded["path"]))

    resolved, candidates_source = resolve_candidates(candidates, profile, efficiency)
    result = {
        "status": STATUS_DEFAULT,
        "driver": default_driver,
        "pool": None,
        "headroom_pct": None,
        "candidates": [],
        "candidates_source": candidates_source,
        "default_driver": default_driver,
        "default_source": default_source,
        "exhausted_pools": sorted(exhausted),
        "profile_path": loaded["path"],
        "profile_status": loaded["status"],
        "now_utc": None if now is None else now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ledger": None,
        "roles": None,
        "reserves": {},
        "near_weekly_reset_hours": None,
        "near_weekly_reset_hours_source": None,
        "notes": notes,
        "usage_notes": [],
        "reason": None,
    }

    if not resolved:
        result["reason"] = (
            "no candidate drivers were given (pass --candidate/--candidates, set {}, "
            "or configure an efficiency profile whose rungs name backends) — FAIL-OPEN "
            "to the default: {}".format(
                CANDIDATES_ENV,
                "{} ({})".format(default_driver, default_source) if default_driver
                else "none could be resolved either"))
        return result

    if profile is None or efficiency is None:
        # Nothing to measure against: report every candidate as unavailable rather
        # than silently ranking them all equal.
        result["candidates"] = [
            {"name": name, "pool": pool, "ranked": False, "blocked": None,
             "unavailable": UNAVAILABLE_NO_PROFILE, "headroom_pct": None}
            for name, pool in resolved]
        result["reason"] = (
            "live usage is unavailable for every candidate ({}) — FAIL-OPEN to the "
            "default: {}".format(
                ", ".join(name for name, _ in resolved),
                "{} ({})".format(default_driver, default_source) if default_driver
                else "none could be resolved either"))
        return result

    usage = efficiency.read_ledger_usage(repo, now, profile)
    result["ledger"] = usage.get("ledger")
    result["usage_notes"] = list(usage.get("notes") or [])

    # The reserves that bind the DRIVER are the ones held by the OTHER control-plane
    # roles: the orchestrator's own share is set aside for this very run, so counting
    # it against the driver's headroom would have it hide from its own reserve.
    roles = efficiency.resolve_role_pools(profile)
    other_roles = dict((role, spec) for role, spec in roles.items()
                       if role != "orchestrator")
    reserves = efficiency.effective_reserves(profile, other_roles)
    result["roles"] = roles
    result["reserves"] = dict((pool, entry["pct"]) for pool, entry in reserves.items())
    near_hours, near_source = efficiency.near_weekly_reset_hours(
        profile.get("reserves") or {})
    result["near_weekly_reset_hours"] = near_hours
    result["near_weekly_reset_hours_source"] = near_source
    result["notes"].append(
        "the orchestrator's own weekly reserve is NOT charged against the driver's "
        "headroom (the driver IS the orchestrator); every other role's reserve on a "
        "pool is")

    avoiding = avoid_window_pools(usage)
    pool_of = {}
    mapping = efficiency.backend_pools(profile)
    pools = efficiency.profile_pools(profile)
    for name, pool in resolved:
        pool_of[name] = pool or efficiency.pool_for_backend(name, mapping, pools)

    records = [evaluate_candidate(name, pool_of[name], usage, profile, efficiency,
                                  usage_state, reserves, exhausted, avoiding, now,
                                  near_hours)
               for name, pool in resolved]
    result["candidates"] = records

    ranked = [rec for rec in records if rec["ranked"]]
    if not ranked:
        result["reason"] = (
            "no candidate has usable live usage ({}) — FAIL-OPEN to the default: "
            "{}".format(
                "; ".join("{}: {}".format(rec["name"], rec["blocked"] or rec["unavailable"])
                          for rec in records),
                "{} ({})".format(default_driver, default_source) if default_driver
                else "none could be resolved either"))
        return result

    # Most headroom wins; a tie keeps the caller's own preference order (the first
    # candidate given), so the ranking never reshuffles equal options.
    best = max(enumerate(ranked), key=lambda pair: (pair[1]["headroom_pct"], -pair[0]))[1]
    result.update({
        "status": STATUS_SELECTED,
        "driver": best["name"],
        "pool": best["pool"],
        "headroom_pct": best["headroom_pct"],
    })
    skipped = [rec for rec in records if not rec["ranked"]]
    reason = ("{} has the most live headroom: {:.1f} pct-point(s) of its {} window "
              "left below its ceiling (of {} candidate(s) with usage data{})".format(
                  best["name"], best["headroom_pct"], best["binding_window"],
                  len(ranked),
                  "; {} skipped".format(len(skipped)) if skipped else ""))
    if best["headroom_pct"] <= 0:
        reason += (" — WARNING: every candidate is at or over its ceiling, so this is "
                   "only the least-exhausted one")
    if best["relaxed"]:
        reason += (" — its weekly ceiling is lifted because the weekly window resets "
                   "within near_weekly_reset_hours={}".format(near_hours))
    result["reason"] = reason
    return result


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def pct(value):
    return "unknown" if value is None else "{:.1f}%".format(float(value))


def describe_candidate(rec):
    """One candidate as a single human line (stderr)."""
    where = "[pool {}]".format(rec["pool"]) if rec.get("pool") else "[no pool]"
    if rec.get("blocked"):
        return "candidate {} {}: HELD BACK — {}".format(rec["name"], where, rec["blocked"])
    if not rec.get("ranked"):
        return "candidate {} {}: UNAVAILABLE — {}".format(
            rec["name"], where, rec.get("unavailable") or "no usage data")
    weekly_ceiling = "ceiling {}".format(pct(rec["ceiling_weekly_pct"]))
    detail = []
    if rec["cap_weekly_pct"] is not None:
        detail.append("cap {}".format(pct(rec["cap_weekly_pct"])))
    if rec["reserve_pct"]:
        detail.append("reserve {}% [{}]".format(rec["reserve_pct"], rec["reserve_detail"]))
    if rec["relaxed"]:
        detail.append("weekly gates RELAXED near the reset")
    if detail:
        weekly_ceiling += " ({})".format(", ".join(detail))
    return ("candidate {} {}: headroom {} ({} window binds) — 5h {} vs ceiling {}; "
            "weekly {} vs {}".format(
                rec["name"], where, pct(rec["headroom_pct"]), rec["binding_window"],
                pct(rec["used_5h_pct"]), pct(rec["ceiling_5h_pct"]),
                pct(rec["used_weekly_pct"]), weekly_ceiling))


def print_human(result, stream):
    print("pick-driver: usage-aware driver selection (READ-ONLY — nothing was "
          "dispatched)", file=stream)
    print("  now (UTC): {}".format(result["now_utc"] or "unknown"), file=stream)
    print("  profile: {} ({})".format(result["profile_path"] or "none",
                                      result["profile_status"]), file=stream)
    print("  ledger: {}".format(result["ledger"] or "none"), file=stream)
    print("  candidates from: {}".format(result["candidates_source"]), file=stream)
    if result["exhausted_pools"]:
        print("  #28 open quota circuits: {}".format(
            ", ".join(result["exhausted_pools"])), file=stream)
    for note in result["notes"]:
        print("  note: {}".format(note), file=stream)
    for note in result["usage_notes"]:
        print("  usage: {}".format(note), file=stream)
    for rec in result["candidates"]:
        print("  {}".format(describe_candidate(rec)), file=stream)
    if result["status"] == STATUS_SELECTED:
        print("PICKED: {} (pool {})".format(result["driver"], result["pool"]), file=stream)
    else:
        print("FAIL-OPEN DEFAULT: {}".format(result["driver"] or "none"), file=stream)
    print("REASON: {}".format(result["reason"]), file=stream)


def shell_payload(result):
    return [
        ("RALPH_PICK_DRIVER_STATUS", result["status"]),
        ("RALPH_PICK_DRIVER_DRIVER", result["driver"]),
        ("RALPH_PICK_DRIVER_POOL", result["pool"]),
        ("RALPH_PICK_DRIVER_HEADROOM_PCT", result["headroom_pct"]),
        ("RALPH_PICK_DRIVER_DEFAULT", result["default_driver"]),
        ("RALPH_PICK_DRIVER_DEFAULT_SOURCE", result["default_source"]),
        ("RALPH_PICK_DRIVER_CANDIDATES",
         " ".join(rec["name"] for rec in result["candidates"])),
        ("RALPH_PICK_DRIVER_REASON", result["reason"]),
        ("RALPH_PICK_DRIVER_PROFILE", result["profile_path"]),
        ("RALPH_PICK_DRIVER_NOW", result["now_utc"]),
    ]


def print_shell(result):
    import shlex
    for key, value in shell_payload(result):
        print("{}={}".format(key, shlex.quote("" if value is None else str(value))))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv):
    if argv and argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0

    repo = os.getcwd()
    profile_arg = None
    default_arg = None
    candidates = []
    exhausted = []
    as_json = False
    as_shell = False
    value_flags = ("--repo", "--profile", "--default", "--candidate", "--candidates",
                   "--exhausted-pool")
    i = 0
    while i < len(argv):
        arg = argv[i]
        value = None
        if arg in value_flags:
            if i + 1 >= len(argv):
                print("ralph: {} needs a value".format(arg), file=sys.stderr)
                return 2
            value = argv[i + 1]
            i += 1
        else:
            for flag in value_flags:
                if arg.startswith(flag + "="):
                    arg, value = flag, arg[len(flag) + 1:]
                    break
        if value is not None:
            if arg == "--repo":
                repo = value
            elif arg == "--profile":
                profile_arg = value
            elif arg == "--default":
                default_arg = value
            elif arg == "--candidate":
                candidates.append(split_candidate(value))
            elif arg == "--candidates":
                candidates.extend(split_candidate(part) for part in split_list(value))
            else:
                exhausted.extend(split_list(value))
        elif arg == "--json":
            as_json = True
        elif arg == "--shell":
            as_shell = True
        else:
            print("ralph: unknown pick-driver option {!r}".format(arg), file=sys.stderr)
            print(USAGE, file=sys.stderr)
            return 2
        i += 1

    candidates = [pair for pair in candidates if pair[0]]
    efficiency = load_efficiency()
    default_driver, default_source = resolve_default_driver(
        default_arg, efficiency, candidates)
    result = pick_driver(repo, candidates, default_driver, default_source, profile_arg,
                         set(exhausted), efficiency)

    if as_shell:
        print_shell(result)
        return 0
    if as_json:
        json.dump(result, sys.stdout, indent=2, sort_keys=True, default=str)
        sys.stdout.write("\n")
        return 0
    # stdout is ONLY the name, so `$(ralph pick-driver ...)` is directly usable; the
    # reasoning goes to stderr, where an operator still sees it.
    print_human(result, sys.stderr)
    if result["driver"]:
        print(result["driver"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

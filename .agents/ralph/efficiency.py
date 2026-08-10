#!/usr/bin/env python3
"""Parse, validate and explain a declarative Ralph efficiency profile (#59).

The profile describes a LADDER of rungs (cheapest first), the credential pool
each role draws from, the window caps / avoid-windows that make a pool
ineligible, the reserves to keep for higher-value work, and which rungs each
complexity tier is allowed to use.

Since #63 the reserves are keyed by the control-plane ROLE (manager /
orchestrator), not by pool: each role is resolved to the pool it actually runs on
and its reserve lands there, stacking when two roles share a pool.

It parses, validates, explains and — since #54 step 4c — SELECTS: `select_rung`
computes the rung a complexity tier would use, enforcing the pool caps, the
avoid windows, the #28 circuit and the weekly reserves in code. This module
itself still DISPATCHES NOTHING: no caller's BUILDER/REVIEWER is touched here.
Since #54 step 4d the loops APPLY the `select` result per ticket, but only under
--efficiency / RALPH_EFFICIENCY (see ralph_efficiency_dispatch_select in
efficiency.sh); with the opt-in off nothing consults this module at all.

The per-pool usage numbers come from the read-only reader in usage-state.py
(#60): ledger token sums per window, turned into a percentage only when the
profile configures a token budget for that pool + window. A pool whose provider
publishes usage as a PERCENTAGE only (an Anthropic Pro/Max plan, where there is no
token budget to divide by) instead declares a cap of shape
{source: "provider_pct", usage_provider: "<script>"} (#68): the adapter's printed
JSON supplies the percentages, so that pool's cap and the reserves it carries bind
like any other. An adapter that fails FAILS OPEN, exactly like a missing budget.

Usage:
  python3 efficiency.py validate [--profile PATH] [--repo DIR] [--json]
  python3 efficiency.py explain --complexity <trivial|small|medium|large>
                                [--profile PATH] [--repo DIR] [--json]
  python3 efficiency.py select  --complexity <trivial|small|medium|large>
                                [--profile PATH] [--repo DIR] [--json|--shell]
                                [--exhausted-pool POOL]... [--after-rung NAME]

--after-rung (#64) turns `select` into an ESCALATION: only rungs above NAME in the
tier order are considered, so a promotion is always upwards and always bounded.
When nothing stronger is eligible the status is "exhausted" (exit 5) rather than
the bounded pause — waiting cannot add a rung to the ladder.

Boot-validation contract: a malformed or invalid profile is REJECTED to a SAFE
inert state — loud warning on stderr, "efficiency mode: OFF" on stdout, exit 0.
A missing profile prints a clean not-configured message and exits 0. Neither
ever crashes or fails the harness. Only bad CLI usage (unknown subcommand or
complexity) exits non-zero.

Test/ops seam: RALPH_EFFICIENCY_NOW overrides "now" with an ISO-8601 UTC
timestamp so avoid-window evaluation is deterministic.
"""
import datetime
import json
import os
import sys

TIERS = ("trivial", "small", "medium", "large")

# The control-plane ROLES that hold a weekly reserve (#63), in the order they are
# reported. A reserve belongs to the ROLE, not to a pool: it is applied to whatever
# pool that role currently runs on, and two roles sharing a pool STACK there.
ROLES = ("manager", "orchestrator")
ROLE_RESERVE_KEY = {"manager": "manager_pct", "orchestrator": "orchestrator_pct"}
ROLE_RESERVE_KEYS = tuple(ROLE_RESERVE_KEY[role] for role in ROLES)

STATUS_VALID = "valid"
STATUS_NOT_CONFIGURED = "not_configured"
STATUS_REJECTED = "rejected"


# ---------------------------------------------------------------------------
# Sibling helpers
# ---------------------------------------------------------------------------
def _load_sibling_module(filename, modname):
    """Import a sibling script by path. Returns None when it cannot be loaded."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    if not os.path.isfile(path):
        return None
    try:
        import importlib.util
        # Loading a script by path must not leave a __pycache__ behind in the
        # template dir — that would dirty a target repo working tree.
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location(modname, path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:  # a broken sibling must not take this module down
        return None


# The per-pool usage reader (#60). It owns the clock/window primitives this
# module delegates to below, so if it is missing every window parse fails and a
# profile using avoid windows is REJECTED to inert — the safe direction, and
# main() says so loudly.
USAGE_STATE = _load_sibling_module("usage-state.py", "ralph_usage_state")

# Optional per-pool cap keys (#60). usage-state.py names them because it is what
# consumes them; the literal fallbacks keep validation able to name them even when
# that helper is missing.
BUDGET_5H_KEY = getattr(USAGE_STATE, "BUDGET_5H_KEY", "window_5h_budget_tokens")
BUDGET_WEEKLY_KEY = getattr(USAGE_STATE, "BUDGET_WEEKLY_KEY", "window_weekly_budget_tokens")
WEEKLY_ANCHOR_KEY = getattr(USAGE_STATE, "WEEKLY_ANCHOR_KEY", "weekly_reset_anchor")
# #68: the pool's usage adapter. Optional and additive on any cap shape (it only
# changes where the percentage comes from), and REQUIRED by source="provider_pct".
USAGE_PROVIDER_KEY = getattr(USAGE_STATE, "USAGE_PROVIDER_KEY", "usage_provider")
OPTIONAL_CAP_KEYS = (BUDGET_5H_KEY, BUDGET_WEEKLY_KEY, WEEKLY_ANCHOR_KEY,
                     USAGE_PROVIDER_KEY)

CAP_SOURCE_PROVIDER = getattr(USAGE_STATE, "CAP_SOURCE_PROVIDER", "provider")
CAP_SOURCE_PROVIDER_PCT = getattr(USAGE_STATE, "CAP_SOURCE_PROVIDER_PCT", "provider_pct")
CAP_SOURCES = (CAP_SOURCE_PROVIDER, CAP_SOURCE_PROVIDER_PCT)
PCT_FIELDS = ("window_5h_pct", "window_weekly_pct")

USAGE_STATE_MISSING = (
    "⚠⚠ ralph: usage-state.py not found next to efficiency.py — per-pool usage, "
    "avoid-window evaluation and window budgets are unavailable; efficiency mode "
    "is OFF (inert).")


# ---------------------------------------------------------------------------
# Profile location + load
# ---------------------------------------------------------------------------
def resolve_profile_path(explicit, repo):
    """Return the efficiency profile path: --profile, then env, then repo default."""
    if explicit:
        return os.path.abspath(explicit)
    env_path = os.environ.get("RALPH_EFFICIENCY_PROFILE", "").strip()
    if env_path:
        return os.path.abspath(env_path)
    return os.path.join(os.path.abspath(repo), ".agents", "ralph", "efficiency.json")


def load_profile(path):
    """Load and validate a profile.

    Returns a dict: {status, path, errors, profile}. status is one of
    valid / not_configured / rejected. Never raises.
    """
    if not os.path.isfile(path):
        return {"status": STATUS_NOT_CONFIGURED, "path": path, "errors": [], "profile": None}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError) as exc:
        return {
            "status": STATUS_REJECTED,
            "path": path,
            "errors": ["not readable as JSON: {}".format(exc)],
            "profile": None,
        }
    errors = validate_profile(raw)
    if errors:
        return {"status": STATUS_REJECTED, "path": path, "errors": errors, "profile": None}
    return {"status": STATUS_VALID, "path": path, "errors": [], "profile": raw}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def _is_number(val):
    return isinstance(val, (int, float)) and not isinstance(val, bool)


def _is_pct(val):
    return _is_number(val) and 0 <= val <= 100


def _nonempty_str(val):
    return isinstance(val, str) and val.strip() != ""


def parse_hhmm(val):
    """Parse "HH:MM" into minutes-since-midnight, or None if malformed.

    Implemented in usage-state.py so the reader and the validator agree on what
    a window means; None (i.e. "malformed") when that helper is unavailable.
    """
    return USAGE_STATE.parse_hhmm(val) if USAGE_STATE else None


def parse_days(spec):
    """Parse a days spec into a set of weekday indexes (Mon=0), or None.

    Accepts "Mon-Fri", "Sat,Sun", "Mon-Wed,Sat", "*"/"all"/"daily".
    See parse_hhmm for where this lives and why.
    """
    return USAGE_STATE.parse_days(spec) if USAGE_STATE else None


def _validate_window_pcts(cap, where, errors):
    """Both window percentages of a capped shape must be numbers 0-100."""
    ok = True
    for field in PCT_FIELDS:
        if not _is_pct(cap.get(field)):
            errors.append("{}.{}: must be a number 0-100 (got {!r})".format(
                where, field, cap.get(field)))
            ok = False
    return ok


def _validate_cap(cap, where, errors):
    """Validate one cap block and return its kind.

    Kinds: "pct" (local window caps), "provider" (the provider meters it, no local
    cap), "provider_pct" (#68 — the pool's own adapter reports the percentages,
    optionally capped by window_5h_pct/window_weekly_pct), "backstop", or None when
    the block is invalid.
    """
    if not isinstance(cap, dict):
        errors.append("{}: must be an object".format(where))
        return None
    # #60's optional window budgets / weekly reset anchor and #68's usage_provider
    # may sit on ANY cap shape: they only decide where a percentage (and a reset
    # time) comes from. They never replace the cap shape itself.
    for field in (BUDGET_5H_KEY, BUDGET_WEEKLY_KEY):
        if field in cap and not (_is_number(cap[field]) and cap[field] > 0):
            errors.append("{}.{}: must be a number > 0 (tokens) (got {!r})".format(
                where, field, cap[field]))
    if WEEKLY_ANCHOR_KEY in cap and _parse_iso_utc(cap[WEEKLY_ANCHOR_KEY]) is None:
        errors.append(
            "{}.{}: must be an ISO-8601 UTC timestamp like \"2026-08-05T09:00:00Z\" "
            "(got {!r})".format(where, WEEKLY_ANCHOR_KEY, cap[WEEKLY_ANCHOR_KEY]))
    if USAGE_PROVIDER_KEY in cap and not _nonempty_str(cap[USAGE_PROVIDER_KEY]):
        errors.append(
            "{}.{}: must be a path to a script that prints "
            "{{\"window_5h_pct\", \"window_weekly_pct\", \"weekly_reset_at\"}} as JSON "
            "(got {!r})".format(where, USAGE_PROVIDER_KEY, cap[USAGE_PROVIDER_KEY]))
    keys = set(cap.keys()) - set(OPTIONAL_CAP_KEYS)
    # A source-shaped cap: bare, or (provider_pct only) carrying window caps that
    # the adapter's percentages are then measured against.
    if keys == {"source"} or keys == {"source"} | set(PCT_FIELDS):
        capped = keys != {"source"}
        source = cap.get("source")
        if source == CAP_SOURCE_PROVIDER:
            if capped:
                errors.append(
                    "{}: source \"{}\" applies no local cap, so it cannot carry {} — use "
                    "source \"{}\" with a {} to cap a provider-reported percentage".format(
                        where, CAP_SOURCE_PROVIDER, " / ".join(PCT_FIELDS),
                        CAP_SOURCE_PROVIDER_PCT, USAGE_PROVIDER_KEY))
                return None
            return "provider"
        if source == CAP_SOURCE_PROVIDER_PCT:
            ok = _validate_window_pcts(cap, where, errors) if capped else True
            if not _nonempty_str(cap.get(USAGE_PROVIDER_KEY)):
                errors.append(
                    "{}: source \"{}\" requires {} — the script whose printed JSON "
                    "supplies the percentages (that is the whole point of this shape: "
                    "the pool has no token budget to divide by)".format(
                        where, CAP_SOURCE_PROVIDER_PCT, USAGE_PROVIDER_KEY))
                ok = False
            return "provider_pct" if ok else None
        errors.append("{}.source: only {} are supported (got {!r})".format(
            where, " or ".join('"{}"'.format(s) for s in CAP_SOURCES), source))
        return None
    if keys == {"backstop"}:
        if cap.get("backstop") is not True:
            errors.append("{}.backstop: must be true".format(where))
            return None
        return "backstop"
    if keys == set(PCT_FIELDS):
        return "pct" if _validate_window_pcts(cap, where, errors) else None
    errors.append(
        "{}: unknown cap shape {} — expected "
        "{{window_5h_pct, window_weekly_pct}} or {{source: \"provider\"}} "
        "or {{source: \"provider_pct\", usage_provider: \"<script>\"}} (optionally with "
        "window_5h_pct/window_weekly_pct) or {{backstop: true}}, plus any of the "
        "optional {}".format(where, sorted(keys), ", ".join(OPTIONAL_CAP_KEYS)))
    return None


def _validate_avoid_window(win, where, errors):
    if not isinstance(win, dict):
        errors.append("{}: must be an object".format(where))
        return
    for field in ("from", "to", "tz", "days", "reason"):
        if field not in win:
            errors.append("{}.{}: missing (required)".format(where, field))
    if parse_hhmm(win.get("from")) is None:
        errors.append("{}.from: must be \"HH:MM\" 24h (got {!r})".format(where, win.get("from")))
    if parse_hhmm(win.get("to")) is None:
        errors.append("{}.to: must be \"HH:MM\" 24h (got {!r})".format(where, win.get("to")))
    tz = win.get("tz")
    if not _nonempty_str(tz) or tz.strip().upper() not in ("UTC", "Z", "+00:00"):
        errors.append(
            "{}.tz: only \"UTC\" is supported (got {!r}) — windows are compared "
            "against the current UTC time".format(where, tz))
    if parse_days(win.get("days")) is None:
        errors.append(
            "{}.days: must be a day spec like \"Mon-Fri\", \"Sat,Sun\" or \"*\" "
            "(got {!r})".format(where, win.get("days")))
    if not _nonempty_str(win.get("reason")):
        errors.append("{}.reason: must be a non-empty string".format(where))


def validate_profile(raw):
    """Return a list of human-readable schema errors ([] means valid)."""
    errors = []
    if not isinstance(raw, dict):
        return ["profile root: must be a JSON object"]

    # -- rungs -------------------------------------------------------------
    rungs = raw.get("rungs")
    names = []
    if not isinstance(rungs, list) or not rungs:
        errors.append("rungs: must be a non-empty array")
    else:
        for i, rung in enumerate(rungs):
            where = "rungs[{}]".format(i)
            if not isinstance(rung, dict):
                errors.append("{}: must be an object".format(where))
                continue
            name = rung.get("name")
            if not _nonempty_str(name):
                errors.append("{}.name: must be a non-empty string".format(where))
            else:
                if name in names:
                    errors.append("{}.name: duplicate rung name {!r}".format(where, name))
                names.append(name)
                where = "rungs[{}]({})".format(i, name)

            pools = []
            for role in ("builder", "reviewer"):
                spec = rung.get(role)
                if not isinstance(spec, dict):
                    errors.append("{}.{}: must be an object {{backend, pool}}".format(where, role))
                    continue
                if not _nonempty_str(spec.get("backend")):
                    errors.append("{}.{}.backend: must be a non-empty string".format(where, role))
                if not _nonempty_str(spec.get("pool")):
                    errors.append("{}.{}.pool: must be a non-empty string".format(where, role))
                elif spec["pool"] not in pools:
                    pools.append(spec["pool"])

            caps = rung.get("caps")
            if not isinstance(caps, dict) or not caps:
                errors.append("{}.caps: must be a non-empty object keyed by pool".format(where))
            else:
                for pool, cap in caps.items():
                    _validate_cap(cap, "{}.caps.{}".format(where, pool), errors)
                for pool in pools:
                    if pool not in caps:
                        errors.append(
                            "{}.caps: no cap for pool {!r} used by this rung".format(where, pool))

            windows = rung.get("avoid_windows", [])
            if not isinstance(windows, list):
                errors.append("{}.avoid_windows: must be an array".format(where))
            else:
                for j, win in enumerate(windows):
                    _validate_avoid_window(win, "{}.avoid_windows[{}]".format(where, j), errors)

    # -- reserves ----------------------------------------------------------
    reserves = raw.get("reserves")
    if not isinstance(reserves, dict):
        errors.append("reserves: must be an object")
    else:
        for key, val in reserves.items():
            if key in ROLE_RESERVE_KEYS:
                if not _is_pct(val):
                    errors.append("reserves.{}: must be a number 0-100 (got {!r})".format(key, val))
            elif key == "near_weekly_reset_hours":
                if not _is_number(val) or val < 0:
                    errors.append(
                        "reserves.near_weekly_reset_hours: must be a number >= 0 "
                        "(got {!r})".format(val))
            elif key.endswith("_weekly_pct"):
                # #63 retired the pool-keyed spelling: a reserve now follows the
                # ROLE onto whatever pool that role runs on.
                errors.append(
                    "reserves.{}: pool-keyed reserves were replaced by role-keyed ones "
                    "(#63) — use {} instead; the reserve then follows the role onto "
                    "whichever pool it runs on".format(key, " / ".join(ROLE_RESERVE_KEYS)))
            else:
                errors.append(
                    "reserves.{}: unknown key — expected {} or "
                    "near_weekly_reset_hours".format(key, " / ".join(ROLE_RESERVE_KEYS)))

    # -- tiers -------------------------------------------------------------
    tiers = raw.get("tiers")
    if not isinstance(tiers, dict):
        errors.append("tiers: must be an object")
    else:
        for tier in TIERS:
            if tier not in tiers:
                errors.append("tiers.{}: missing (all of {} are required)".format(
                    tier, ", ".join(TIERS)))
        for tier, allowed in tiers.items():
            if tier not in TIERS:
                errors.append("tiers.{}: unknown tier — expected one of {}".format(
                    tier, ", ".join(TIERS)))
                continue
            if not isinstance(allowed, list) or not allowed:
                errors.append("tiers.{}: must be a non-empty array of rung names".format(tier))
                continue
            for entry in allowed:
                if not _nonempty_str(entry):
                    errors.append("tiers.{}: rung names must be non-empty strings".format(tier))
                elif names and entry not in names:
                    errors.append("tiers.{}: unknown rung {!r} (rungs: {})".format(
                        tier, entry, ", ".join(names)))
    return errors


# ---------------------------------------------------------------------------
# Clock
# ---------------------------------------------------------------------------
def _parse_iso_utc(text):
    """Parse an ISO-8601 timestamp into an aware UTC datetime, or None."""
    return USAGE_STATE.parse_iso_utc(text) if USAGE_STATE else None


def now_utc():
    """Current UTC time, overridable with RALPH_EFFICIENCY_NOW (tests/ops)."""
    if USAGE_STATE:
        return USAGE_STATE.now_utc()
    return datetime.datetime.now(datetime.timezone.utc)


def window_active(win, now):
    """True when `now` (aware UTC) falls inside an avoid window."""
    return USAGE_STATE.window_active(win, now) if USAGE_STATE else False


# ---------------------------------------------------------------------------
# Usage (per credential pool), read from the ledger when it has observations
# ---------------------------------------------------------------------------
def _load_report_module():
    """Import the sibling report.py so we reuse its pricing/aggregation helpers."""
    return _load_sibling_module("report.py", "ralph_report")


def _empty_pool_usage():
    """One pool's usage slot. `*_source` records where a percentage came from."""
    return {
        "window_5h_pct": None,
        "window_weekly_pct": None,
        "window_5h_source": None,
        "window_weekly_source": None,
        "weekly_reset_at": None,
        "weekly_reset_source": None,
        "observed_5h": {"records": 0, "tokens": 0, "cost_usd": 0.0},
        "observed_weekly": {"records": 0, "tokens": 0, "cost_usd": 0.0},
        "local_5h": None,
        "local_weekly": None,
    }


def _merge_local_state(result, repo, now, profile):
    """Fold usage-state.py's normalized per-pool records into `result["pools"]`.

    Returns (local_seen, provider_seen): whether a budget-derived percentage and
    whether an adapter-reported one (#68) was found.

    Precedence, strongest first: a pool's own usage adapter (the provider's live
    numbers), then a ledger `quota` observation, then the local budget estimate. So
    an adapter percentage OVERWRITES what is already there, while a budget-derived
    one only fills a gap.
    """
    local_seen = provider_seen = False
    if profile is None or USAGE_STATE is None:
        return local_seen, provider_seen
    state = USAGE_STATE.compute_usage_state(profile, repo, now)
    result["state"] = state
    result["notes"].extend(state["notes"])
    provider_source = getattr(USAGE_STATE, "PCT_SOURCE_PROVIDER", "provider_pct")
    provider_basis = getattr(USAGE_STATE, "RESET_BASIS_PROVIDER", "usage_provider")
    for rec in state["records"]:
        entry = result["pools"].setdefault(rec["pool"], _empty_pool_usage())
        entry["local_{}".format(rec["window"])] = rec
        field = "window_{}_pct".format(rec["window"])
        from_provider = rec.get("pct_source") == provider_source
        if rec["pct"] != USAGE_STATE.UNKNOWN and (from_provider or entry[field] is None):
            entry[field] = float(rec["pct"])
            entry[field + "_source"] = provider_source if from_provider else "budget"
            if from_provider:
                provider_seen = True
            else:
                local_seen = True
        if rec["window"] != "weekly" or rec["reset_at"] == USAGE_STATE.UNKNOWN:
            continue
        if rec["reset_basis"] == provider_basis:
            entry["weekly_reset_at"] = rec["reset_at"]
            entry["weekly_reset_source"] = provider_basis
        elif entry["weekly_reset_at"] is None and rec["reset_basis"] == "weekly_anchor":
            entry["weekly_reset_at"] = rec["reset_at"]
            entry["weekly_reset_source"] = "anchor"
    return local_seen, provider_seen


def read_ledger_usage(repo, now, profile=None):
    """Per-pool usage read from <repo>/.ralph/ledger.jsonl.

    Three things come out of the ledger, and they are NOT the same thing:

      * observed spend — records/tokens/cost per pool inside the 5h and weekly
        windows, aggregated exactly like `ralph report` does (same pricing table,
        same provider->pool alias resolution).
      * LOCAL window percentages (#60) — the per-pool token sums usage-state.py
        computes for the 5h and weekly windows, divided by the per-pool token
        budget the profile configures for that window. With no budget there is no
        denominator, so the percentage stays unknown and only raw tokens are
        reported. A percentage is never fabricated.
      * quota percentages — only if a record carries a "quota" block
        {pool, window_5h_pct, window_weekly_pct, weekly_reset_at}. This is the
        closest thing to a provider-reported number the ledger can hold, so it
        WINS over the local estimate for the same pool + window.

    A fourth source does NOT come from the ledger at all: a pool whose cap is
    {source: "provider_pct", usage_provider: "<script>"} (#68) has its percentages
    reported by that adapter, which usage-state.py invokes. Those are the provider's
    OWN numbers, so they win over both of the ledger-derived views — and they are
    available even with no ledger at all, which is exactly the case a %-only plan
    (Anthropic Pro/Max) is in.

    When no source yields a percentage the caller assumes 0% (and says so).

    Returns {"ledger": path|None, "pools": {pool: {...}}, "state": {...}|None,
    "notes": [...]}.
    """
    ledger = os.path.join(os.path.abspath(repo), ".ralph", "ledger.jsonl")
    result = {"ledger": None, "pools": {}, "state": None, "notes": []}
    if not os.path.isfile(ledger):
        result["notes"].append(
            "no ledger at {} — assuming 0% used for every pool".format(ledger))
        # A usage_provider needs no ledger, so the profile-driven state is still
        # computed: without this a %-only pool could never bind anything.
        _merge_local_state(result, repo, now, profile)
        return result

    result["ledger"] = ledger
    if USAGE_STATE is None:
        result["notes"].append(
            "usage-state.py is unavailable — the ledger cannot be read; "
            "assuming 0% used for every pool")
        return result
    records, status = USAGE_STATE.read_ledger_records(ledger)
    if status != USAGE_STATE.SOURCE_LEDGER:
        result["notes"].append(
            "ledger {} is not readable — assuming 0% used for every pool".format(ledger))
        _merge_local_state(result, repo, now, profile)
        return result

    report = _load_report_module()
    pricing = report._load_pricing() if report else {"providers": {}, "aliases": {}}

    def pool_of(provider):
        if report:
            canonical = report._resolve_provider(provider, pricing)
            if canonical:
                return canonical
        return provider if _nonempty_str(provider) else "unknown"

    five_hours_ago = now - datetime.timedelta(hours=5)
    week_ago = now - datetime.timedelta(days=7)

    def bucket(pool):
        return result["pools"].setdefault(pool, _empty_pool_usage())

    quota_seen = False
    for rec in records:
        stamp = _parse_iso_utc(rec.get("timestamp", ""))

        agents = rec.get("agents", {})
        builder = agents.get("builder", {}) if isinstance(agents, dict) else {}
        provider = builder.get("provider") if isinstance(builder, dict) else None
        tokens = rec.get("tokens", {})
        total = tokens.get("total") if isinstance(tokens, dict) else None
        if provider and stamp is not None and stamp >= week_ago:
            pool = pool_of(provider)
            entry = bucket(pool)
            cost = 0.0
            if report:
                computed = report._compute_cost(
                    tokens if isinstance(tokens, dict) else {}, pool, pricing)
                if computed != "unknown":
                    cost = computed
            targets = [entry["observed_weekly"]]
            if stamp >= five_hours_ago:
                targets.append(entry["observed_5h"])
            for target in targets:
                target["records"] += 1
                target["tokens"] += total if _is_number(total) else 0
                target["cost_usd"] = round(target["cost_usd"] + cost, 6)

        quota = rec.get("quota")
        if not isinstance(quota, dict):
            continue
        pool = quota.get("pool") or quota.get("credential_pool")
        if not _nonempty_str(pool):
            continue
        entry = bucket(pool)
        entry_stamp = _parse_iso_utc(quota.get("observed_at", "")) or stamp
        previous = entry.get("_observed_at")
        if previous is not None and entry_stamp is not None and entry_stamp < previous:
            continue  # keep the most recent observation per pool
        entry["_observed_at"] = entry_stamp
        for field in ("window_5h_pct", "window_weekly_pct"):
            if _is_pct(quota.get(field)):
                entry[field] = float(quota[field])
                entry[field + "_source"] = "quota"
                quota_seen = True
        if _nonempty_str(quota.get("weekly_reset_at")):
            entry["weekly_reset_at"] = quota["weekly_reset_at"].strip()
            entry["weekly_reset_source"] = "quota"
            quota_seen = True

    for entry in result["pools"].values():
        entry.pop("_observed_at", None)

    # #60/#68: the profile-driven view of the same windows — the local
    # budget-derived percentages, plus whatever a pool's usage adapter reported.
    local_seen, provider_seen = _merge_local_state(result, repo, now, profile)

    if quota_seen:
        result["notes"].append(
            "per-pool quota usage read from the ledger {}".format(ledger))
    elif local_seen:
        result["notes"].append(
            "window usage below is the LOCAL estimate: ledger tokens vs the profile's "
            "per-pool token budget (no provider usage API was called)")
    elif provider_seen:
        pass  # the per-pool notes above already name the adapter each pct came from
    else:
        result["notes"].append(
            "ledger {} has observed spend but no quota observations "
            "(no record carries a \"quota\" block), so window usage is unknown — "
            "assuming 0% used".format(ledger))
    return result


def _pool_usage(usage, pool):
    entry = usage["pools"].get(pool)
    return _empty_pool_usage() if entry is None else entry


def _hours_to_reset(reset_at, now):
    parsed = _parse_iso_utc(reset_at or "")
    if parsed is None:
        return None
    return (parsed - now).total_seconds() / 3600.0


# ---------------------------------------------------------------------------
# Explain
# ---------------------------------------------------------------------------
def _pct_provenance(pool_usage, field):
    """Suffix naming where a window percentage came from.

    A quota observation is reported bare (it is the closest thing to a
    provider-reported number). A locally computed one says so, an adapter-reported
    one (#68) names its source, and an absent one is flagged as the assumption it is.
    """
    source = pool_usage.get(field + "_source")
    if source == "budget":
        return " (local: ledger tokens vs budget)"
    if source == CAP_SOURCE_PROVIDER_PCT:
        return " (provider-reported via the pool's usage_provider)"
    if pool_usage.get(field) is None:
        return " (assumed, no observation)"
    return ""


# ---------------------------------------------------------------------------
# Selection (#61) — the enforcement keystone
#
# select_rung(profile, complexity, usage, now, exhausted_pools) walks the tier's
# allowed rungs in order and returns the FIRST eligible one. A rung is eligible
# iff every pool it draws on is eligible, and a pool is eligible iff:
#
#   (a) no avoid window on the rung is active right now (current UTC day + time),
#   (b) its #28 quota circuit is closed — the caller passes the open pools in,
#       because the circuit semantics (and its reset handling) live exactly once,
#       in agents.sh's ralph_quota_pool_is_exhausted, and
#   (c) its window usage is under the profile's cap AND leaves the pool's weekly
#       reserve intact — unless the weekly window resets within
#       reserves.near_weekly_reset_hours, which RELAXES both weekly gates (quota
#       about to expire is quota you may as well spend). The rolling 5h cap is
#       never relaxed: it is a rate limit, not an expiring budget.
#
# Two deliberate asymmetries:
#
#   * FAIL-OPEN on unknown usage. No budget and no quota observation means no
#     percentage (usage-state.py never invents one), and a missing number must
#     never freeze the ladder: the pool stays eligible and the #28 circuit is the
#     real gate. The caps are a local estimate; the circuit is fact.
#   * The RESERVES are enforced HERE, in code, and they follow the ROLE (#63). The
#     profile supplies the numbers (validation has already rejected malformed ones),
#     but a profile that simply omits reserves.manager_pct does NOT switch that
#     reserve off — the code default below applies. Reserve policy is not bypassable
#     by profile data.
#
# When no rung of the tier is eligible the always-on backstop rung is used even if
# the tier does not list it; when even that is unavailable the result is a
# distinct BOUNDED PAUSE signal. Never an exception, never a frozen loop.
#
# This still GOVERNS NOTHING: the result is a recommendation. Nothing here exports
# BUILDER/REVIEWER and nothing is dispatched — that is #54 step 4d.
# ---------------------------------------------------------------------------
SELECT_SELECTED = "selected"
SELECT_PAUSED = "paused"
SELECT_INERT = "inert"
# Escalation only (#64): asked for a rung STRONGER than the one named by
# --after-rung, there is none left. Distinct from a PAUSE because waiting cannot
# help — the ladder itself has run out, so the caller must stop for good.
SELECT_EXHAUSTED = "exhausted"

# The share of the weekly window each control-plane ROLE keeps unspent, enforced by
# CODE when the profile does not name it. The finalized policy (#54, re-keyed by
# #63): a quarter of the week for the manager, half of it for the orchestrator —
# wherever those roles happen to run.
DEFAULT_ROLE_RESERVE_PCT = {"manager": 25, "orchestrator": 50}
DEFAULT_NEAR_WEEKLY_RESET_HOURS = 5

# The manager runs on the strongest Claude by charter, so it draws on the anthropic
# pool unless RALPH_MANAGER_POOL moves it.
DEFAULT_MANAGER_POOL = "anthropic"

# A bounded PAUSE never waits longer than the shortest window the harness models
# (the rolling 5h one) — after that there is always new information to re-evaluate.
PAUSE_MAX_SECONDS = 5 * 3600
PAUSE_MIN_SECONDS = 60


def role_reserve_pct(role, reserves):
    """(reserve pct, source) for a control-plane role.

    The profile's number when it has one, else the code default: omitting the key
    supplies no number, it does not switch the reserve off.
    """
    key = ROLE_RESERVE_KEY[role]
    value = reserves.get(key) if isinstance(reserves, dict) else None
    if _is_pct(value):
        return value, "from the profile"
    return DEFAULT_ROLE_RESERVE_PCT[role], "code default, not set in the profile"


def backend_pools(profile):
    """backend name -> credential pool, learned from the profile's own rungs."""
    mapping = {}
    for rung in profile.get("rungs", []):
        if not isinstance(rung, dict):
            continue
        for role in ("builder", "reviewer"):
            spec = rung.get(role)
            if not isinstance(spec, dict):
                continue
            backend, pool = spec.get("backend"), spec.get("pool")
            if _nonempty_str(backend) and _nonempty_str(pool):
                mapping.setdefault(backend, pool)
    return mapping


def profile_pools(profile):
    """Every credential pool the profile names, in first-seen order."""
    pools = []
    for rung in profile.get("rungs", []):
        if not isinstance(rung, dict):
            continue
        for role in ("builder", "reviewer"):
            spec = rung.get(role)
            pool = spec.get("pool") if isinstance(spec, dict) else None
            if _nonempty_str(pool) and pool not in pools:
                pools.append(pool)
        caps = rung.get("caps")
        if isinstance(caps, dict):
            for pool in caps:
                if _nonempty_str(pool) and pool not in pools:
                    pools.append(pool)
    return pools


def pool_for_backend(name, mapping, pools):
    """The pool a backend/provider name draws on, or None when nothing maps it."""
    if not _nonempty_str(name):
        return None
    if name in mapping:
        return mapping[name]
    # A normalized provider spelling (RALPH_CRON_DRIVER_PROVIDER=zai) often names the
    # pool itself rather than a backend the ladder happens to list.
    if name in pools:
        return name
    return None


# Ask agents.sh what RALPH_CRON_DRIVER currently resolves to. The resolution rules
# (and the default when nothing is set) live exactly once, in #52's
# ralph_resolve_cron_driver — this never re-implements them, it only reads the
# answer out of a throwaway shell so nothing leaks into the caller's environment.
# Three candidates come back, best first: the normalized provider spelling (which
# names a vendor directly, where the resolved backend would be the synthetic
# "ralph-cron"), the backend the resolver settled on, and the raw name it was given
# — the last one still identifies the vendor when that backend has no command
# defined in this shell, which must not cost the orchestrator its reserve.
CRON_DRIVER_PROBE = (
    '. "$1" >/dev/null 2>&1 || exit 0\n'
    'ralph_resolve_cron_driver >/dev/null 2>&1\n'
    'printf "%s\\n" "${RALPH_CRON_DRIVER_PROVIDER:-}"\n'
    'printf "%s\\n" "${RALPH_CRON_DRIVER_BACKEND:-}"\n'
    'printf "%s\\n" "${RALPH_CRON_DRIVER:-${RALPH_CRON_DRIVER_DEFAULT:-${DEFAULT_AGENT:-}}}"\n'
)


def cron_driver_candidates():
    """Names the #52 cron-driver resolver yields for the orchestrator, best first."""
    agents_sh = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agents.sh")
    if not os.path.isfile(agents_sh):
        return []
    import subprocess
    proc = None
    try:
        proc = subprocess.Popen(
            ["bash", "-c", CRON_DRIVER_PROBE, "ralph-efficiency", agents_sh],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        # Bounded: a shell that will not answer must not freeze the selection.
        out = proc.communicate(timeout=15)[0]
    except Exception:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.communicate()
        return []
    names = []
    for line in (out or "").splitlines():
        name = line.strip()
        if name and name not in names:
            names.append(name)
    return names


def resolve_role_pools(profile):
    """Which credential pool each control-plane ROLE draws on right now (#63).

    Returns {role: {pool, backend, source}}; `pool` is None when nothing maps the
    role to one of the profile's pools, in which case that role holds no reserve
    anywhere (rather than silently reserving on some arbitrary pool).
    """
    mapping = backend_pools(profile)
    pools = profile_pools(profile)
    roles = {}

    override = os.environ.get("RALPH_MANAGER_POOL", "").strip()
    roles["manager"] = {
        "pool": override or DEFAULT_MANAGER_POOL,
        "backend": None,
        "source": ("RALPH_MANAGER_POOL" if override else
                   "default {} pool (the manager runs on the strongest Claude by "
                   "charter; set RALPH_MANAGER_POOL to move it)".format(
                       DEFAULT_MANAGER_POOL)),
    }

    candidates = cron_driver_candidates()
    backend = candidates[0] if candidates else None
    pool = None
    for name in candidates:
        resolved = pool_for_backend(name, mapping, pools)
        if resolved is not None:
            backend, pool = name, resolved
            break
    if pool is not None:
        source = "RALPH_CRON_DRIVER resolves to {!r}".format(backend)
    elif backend:
        source = ("RALPH_CRON_DRIVER resolves to {!r}, which no rung maps to a "
                  "pool — no orchestrator reserve applies".format(backend))
    else:
        source = ("the cron driver could not be resolved (agents.sh unavailable) — "
                  "no orchestrator reserve applies")
    roles["orchestrator"] = {"pool": pool, "backend": backend, "source": source}
    return roles


def effective_reserves(profile, roles):
    """pool -> {pct, parts}: the SUM of the reserves of every role on that pool.

    Stacking is the point: when the manager and the orchestrator share a pool, that
    pool has to carry both of their weeks.
    """
    reserves = profile.get("reserves") or {}
    effective = {}
    for role in ROLES:
        pool = (roles.get(role) or {}).get("pool")
        if not _nonempty_str(pool):
            continue
        pct, source = role_reserve_pct(role, reserves)
        entry = effective.setdefault(pool, {"pct": 0, "parts": []})
        entry["pct"] += pct
        entry["parts"].append({"role": role, "pct": pct, "source": source})
    return effective


def _reserve_parts_label(entry):
    """Name every role stacked into one pool's reserve, and where its number came from."""
    return " + ".join("{} {}% [{}]".format(part["role"], part["pct"], part["source"])
                      for part in entry["parts"])


def near_weekly_reset_hours(reserves):
    """(hours, source) — how close to the weekly reset lifts the weekly gates."""
    value = reserves.get("near_weekly_reset_hours") if isinstance(reserves, dict) else None
    if _is_number(value) and value >= 0:
        return value, "from the profile"
    return DEFAULT_NEAR_WEEKLY_RESET_HOURS, "code default, not set in the profile"


def backstop_rung_name(profile):
    """The name of the first rung whose every pool is an uncapped backstop, or None."""
    for rung in profile.get("rungs", []):
        caps = rung.get("caps", {})
        pools = [rung[role]["pool"] for role in ("builder", "reviewer")]
        if pools and all(isinstance(caps.get(p), dict) and "backstop" in caps[p] for p in pools):
            return rung["name"]
    return None


def _evaluate_rung(rung, policy, usage, now, exhausted, in_tier):
    """Evaluate one rung: its avoid windows, then every pool it draws on."""
    checks = []
    eligible = True
    lifted_any = False  # did the near-weekly-reset relaxation lift a weekly gate?
    unblocks = []  # aware datetimes at which one of this rung's blocks could lift

    for win in rung.get("avoid_windows", []):
        active = window_active(win, now)
        checks.append({
            "kind": "avoid_window",
            "pool": None,
            "ok": not active,
            "detail": "avoid window {}-{} {} {} ({}) — {}".format(
                win["from"], win["to"], win["tz"], win["days"], win["reason"],
                "ACTIVE now" if active else "not active now"),
        })
        if active:
            eligible = False

    pools = []
    for role in ("builder", "reviewer"):
        pool = rung[role]["pool"]
        if pool not in pools:
            pools.append(pool)

    near_hours, near_source = policy["near_hours"], policy["near_source"]

    for pool in pools:
        cap = rung["caps"][pool]
        pool_usage = _pool_usage(usage, pool)
        used_weekly = pool_usage["window_weekly_pct"]
        hours = _hours_to_reset(pool_usage["weekly_reset_at"], now)
        relaxed = hours is not None and hours <= near_hours
        if hours is not None and hours > 0:
            unblocks.append(now + datetime.timedelta(hours=hours))

        # (b) The #28 circuit: observed provider exhaustion. It is the one gate
        # that also binds the backstop, and the one that makes fail-open safe.
        open_circuit = pool in exhausted
        checks.append({
            "kind": "circuit", "pool": pool, "ok": not open_circuit,
            "detail": "pool {}: #28 quota circuit is {}".format(
                pool,
                "OPEN (the provider reported exhaustion and the reset has not elapsed)"
                if open_circuit else "closed"),
        })
        if open_circuit:
            eligible = False

        if "backstop" in cap:
            checks.append({
                "kind": "cap", "pool": pool, "ok": True,
                "detail": "pool {}: backstop rung — no window cap and no reserve, always "
                          "eligible unless its circuit is open or an avoid window is "
                          "active".format(pool),
            })
            continue

        # (c) Caps. Unknown usage fails OPEN — a missing denominator must never
        # freeze the ladder. A source-shaped cap only applies a window cap when it
        # is source="provider_pct" AND declares the percentages to cap (#68); a
        # bare source cap leaves the metering to the provider.
        if "source" in cap and not all(field in cap for field in PCT_FIELDS):
            checks.append({
                "kind": "cap", "pool": pool, "ok": True,
                "detail": "pool {}: cap source={} — the provider enforces its own "
                          "limit, the harness applies none".format(pool, cap["source"]),
            })
        else:
            for field, used_label in (("window_5h_pct", "5h"), ("window_weekly_pct", "weekly")):
                limit = cap[field]
                used = pool_usage[field]
                value = used if used is not None else 0.0
                over = used is not None and value >= limit
                # Only the WEEKLY cap is lifted near the weekly reset.
                lifted = over and used_label == "weekly" and relaxed
                detail = "pool {}: {} window {:.1f}%{} vs cap {}% — {}".format(
                    pool, used_label, value, _pct_provenance(pool_usage, field),
                    limit, "OVER CAP" if over else "under cap")
                if used is None:
                    detail += " (FAIL-OPEN: no usage data for this pool)"
                if lifted:
                    lifted_any = True
                    detail += ("; RELAXED — the weekly window resets in {:.1f}h "
                               "(<= near_weekly_reset_hours={})".format(hours, near_hours))
                checks.append({
                    "kind": "cap", "pool": pool, "ok": (not over) or lifted, "detail": detail,
                })
                if over and not lifted:
                    eligible = False

        # (c) The reserve — enforced here, in code, from the profile's numbers. It
        # belongs to the control-plane ROLE, so it sits on whatever pool that role
        # runs on today, and stacks when the manager and the orchestrator share one.
        stacked = policy["effective"].get(pool)
        reserve = stacked["pct"] if stacked else None
        reserve_source = _reserve_parts_label(stacked) if stacked else None
        if reserve is None:
            checks.append({
                "kind": "reserve", "pool": pool, "ok": True,
                "detail": "pool {}: no reserve — no control-plane role runs on this "
                          "pool".format(pool),
            })
        elif used_weekly is None:
            checks.append({
                "kind": "reserve", "pool": pool, "ok": True,
                "detail": "pool {}: reserve {}% ({}) — weekly usage unknown, FAIL-OPEN "
                          "(the #28 circuit is the real gate)".format(
                              pool, reserve, reserve_source),
            })
        elif relaxed:
            # Quota that is about to expire is quota you may as well spend.
            lifted_any = lifted_any or (100.0 - used_weekly) < reserve
            checks.append({
                "kind": "reserve", "pool": pool, "ok": True,
                "detail": "pool {}: reserve {}% RELAXED — weekly quota resets in "
                          "{:.1f}h (<= near_weekly_reset_hours={}, {}); {:.1f}% of the "
                          "weekly window left".format(
                              pool, reserve, hours, near_hours, near_source,
                              100.0 - used_weekly),
            })
        else:
            remaining = 100.0 - used_weekly
            breached = remaining < reserve
            detail = "pool {}: {:.1f}% of the weekly window left{} vs reserve {}% ({}) — {}".format(
                pool, remaining, _pct_provenance(pool_usage, "window_weekly_pct"),
                reserve, reserve_source, "BELOW RESERVE" if breached else "above reserve")
            if hours is None:
                detail += "; weekly reset time unknown, no relaxation"
            checks.append({
                "kind": "reserve", "pool": pool, "ok": not breached, "detail": detail,
            })
            if breached:
                eligible = False

    return {
        "name": rung["name"],
        "builder": rung["builder"],
        "reviewer": rung["reviewer"],
        "pools": pools,
        "in_tier": in_tier,
        "eligible": eligible,
        "relaxed": lifted_any,
        "checks": checks,
        "_unblocks": unblocks,
    }


def _blocking_reasons(entry):
    """The failed checks of a rung, joined for a one-line explanation."""
    return "; ".join(check["detail"] for check in entry["checks"] if not check["ok"])


def _pause_signal(evaluated, now):
    """A BOUNDED pause: how long to wait before re-evaluating. Never a crash.

    The bound is the soonest moment a block could lift (a known weekly reset),
    capped at PAUSE_MAX_SECONDS — within the rolling 5h window there is always new
    information, so a pause never becomes an indefinite freeze.
    """
    seconds = PAUSE_MAX_SECONDS
    candidates = [moment for entry in evaluated for moment in entry["_unblocks"] if moment > now]
    if candidates:
        seconds = min(seconds, int(round((min(candidates) - now).total_seconds())))
    seconds = max(seconds, PAUSE_MIN_SECONDS)
    return {
        "seconds": seconds,
        "until": (now + datetime.timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def select_rung(profile, complexity, usage, now, exhausted_pools=(), roles=None,
                after_rung=None):
    """Pick the (builder, reviewer) rung for one complexity tier.

    Returns {status, rung_name, builder, reviewer, reason, ...}: status is
    "selected" (rung_name/builder/reviewer are set), "paused" (they are None and
    `pause` carries the bounded retry hint) or, in escalation mode only,
    "exhausted". Pure and read-only — it inspects the already-loaded profile plus
    the usage read by #60 and decides nothing else.

    `roles` overrides the resolved control-plane role -> pool map (tests/ops); by
    default it is resolved from RALPH_CRON_DRIVER / RALPH_MANAGER_POOL.

    ESCALATION (#64): `after_rung` names the rung that just failed, and restricts
    the search to the rungs ABOVE it in the tier order — the promotion is strictly
    upwards, so a run can only ever climb the ladder and the number of promotions
    is bounded by the tier's length. Eligibility is unchanged (avoid windows, the
    #28 circuit, caps and reserves all still bind), and the backstop is still the
    last resort unless it has already been used. When nothing stronger is left the
    status is "exhausted", NOT "paused": waiting does not grow the ladder.
    """
    rungs = {r["name"]: r for r in profile["rungs"]}
    tier_order = list(profile["tiers"][complexity])
    escalating = after_rung is not None
    # Everything at or below the failed rung: already tried, or cheaper than what
    # just failed. Either way it is not a promotion.
    below = tier_order[:tier_order.index(after_rung) + 1] if (
        escalating and after_rung in tier_order) else (tier_order if escalating else [])
    order = tier_order[len(below):] if escalating else tier_order
    reserves = profile.get("reserves", {})
    exhausted = set(exhausted_pools or ())

    if roles is None:
        roles = resolve_role_pools(profile)
    effective = effective_reserves(profile, roles)
    near_hours, near_source = near_weekly_reset_hours(reserves)
    policy = {"effective": effective, "near_hours": near_hours,
              "near_source": near_source}

    evaluated = []
    chosen = None
    for name in order:
        entry = _evaluate_rung(rungs[name], policy, usage, now, exhausted, True)
        evaluated.append(entry)
        if entry["eligible"] and chosen is None:
            chosen = entry

    # Nothing in the tier: fall back to the always-on backstop, even when the tier
    # does not list it. While escalating it is off the table once it has been used
    # or passed — promoting to the rung that just failed would be a loop.
    backstop_name = backstop_rung_name(profile)
    backstop_used = False
    backstop_available = backstop_name is not None and not (
        escalating and (backstop_name == after_rung or backstop_name in below))
    if chosen is None and backstop_available:
        entry = None
        for candidate in evaluated:
            if candidate["name"] == backstop_name:
                entry = candidate
                break
        if entry is None:
            entry = _evaluate_rung(rungs[backstop_name], policy, usage, now, exhausted, False)
            evaluated.append(entry)
        if entry["eligible"]:
            chosen = entry
            backstop_used = True

    result = {
        "status": SELECT_SELECTED,
        "complexity": complexity,
        "order": order,
        "rungs": evaluated,
        "backstop": backstop_used,
        "backstop_rung": backstop_name,
        "pause": None,
        "enforced": False,
        # #64: the rung this selection had to beat (None outside escalation).
        "after_rung": after_rung,
        # Which role sits on which pool, and the reserve each pool therefore carries.
        "reserves": {
            "roles": roles,
            "effective": dict((pool, entry["pct"]) for pool, entry in effective.items()),
            "stacked": effective,
            "near_weekly_reset_hours": near_hours,
            "near_weekly_reset_hours_source": near_source,
        },
    }

    if chosen is None and escalating:
        # The ladder, not the clock, is what ran out: report a terminal EXHAUSTED so
        # the caller stops with a status naming the rungs it tried. Bounded by
        # construction — `order` shrinks with every promotion.
        if after_rung not in rungs:
            detail = "it is not a rung in this profile, so nothing can be above it"
        elif not order and not backstop_available:
            detail = "there is no rung above it in tier '{}'".format(complexity)
            if backstop_name is not None:
                detail += " and the '{}' backstop rung has already been used".format(
                    backstop_name)
        else:
            blocked = "; ".join(
                "{} ({})".format(entry["name"], _blocking_reasons(entry))
                for entry in evaluated if not entry["eligible"])
            detail = ("every stronger rung in tier '{}' is ineligible right now: {}".format(
                complexity, blocked or "none evaluated"))
        result.update({
            "status": SELECT_EXHAUSTED,
            "rung_name": None,
            "builder": None,
            "reviewer": None,
            "reason": ("cannot promote above rung '{}': {} — the ladder is "
                       "EXHAUSTED".format(after_rung, detail)),
        })
    elif chosen is None:
        pause = _pause_signal(evaluated, now)
        if backstop_name is None:
            unavailable = "the profile configures no backstop rung"
        else:
            blocked = [e for e in evaluated if e["name"] == backstop_name]
            unavailable = "the '{}' backstop rung is unavailable too ({})".format(
                backstop_name, _blocking_reasons(blocked[0]) if blocked else "not evaluated")
        result.update({
            "status": SELECT_PAUSED,
            "rung_name": None,
            "builder": None,
            "reviewer": None,
            "pause": pause,
            "reason": ("no rung in tier '{}' is eligible right now and {} — bounded PAUSE: "
                       "retry in {}s (at {})".format(
                           complexity, unavailable, pause["seconds"], pause["until"])),
        })
    else:
        where = ("above '{}' in tier '{}'".format(after_rung, complexity)
                 if escalating else "in tier '{}'".format(complexity))
        if backstop_used:
            reason = ("no rung {} is eligible right now — falling back to the "
                      "'{}' backstop rung (uncapped last resort)".format(
                          where, chosen["name"]))
        else:
            blocked = [e["name"] for e in evaluated[:evaluated.index(chosen)] if not e["eligible"]]
            if blocked:
                reason = ("first eligible rung {} — {} {} skipped (see above)".format(
                    where, ", ".join(blocked), "was" if len(blocked) == 1 else "were"))
            elif escalating:
                reason = "next rung {} and every check passed".format(where)
            else:
                reason = "cheapest rung {} and every check passed".format(where)
            if chosen["relaxed"]:
                reason += (" — its weekly gate(s) only pass because the weekly window "
                           "resets soon (near-weekly-reset relaxation)")
        result.update({
            "rung_name": chosen["name"],
            "builder": chosen["builder"],
            "reviewer": chosen["reviewer"],
            "reason": reason,
        })

    for entry in evaluated:
        entry.pop("_unblocks", None)
    return result


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
INERT_LINE = "efficiency mode: OFF (inert) — builder/reviewer selection is unchanged"
GOVERNS_NOTHING = ("note: explain is read-only — nothing was dispatched here. Under "
                   "--efficiency the loops apply this same decision per ticket; without "
                   "it, --builder/--reviewer selection is unchanged.")


def warn_rejected(loaded):
    """Loudly reject a bad profile on stderr. Never raises, never exits."""
    print("", file=sys.stderr)
    print("⚠⚠ ralph: REJECTED efficiency profile {} — {} schema error(s):".format(
        loaded["path"], len(loaded["errors"])), file=sys.stderr)
    for err in loaded["errors"]:
        print("     - {}".format(err), file=sys.stderr)
    print("⚠⚠ falling back to INERT/OFF: efficiency mode does nothing, the normal "
          "--builder/--reviewer path is unaffected.", file=sys.stderr)
    print("", file=sys.stderr)


def print_not_configured(loaded):
    print("efficiency profile not configured (looked for {})".format(loaded["path"]))
    print("  copy .agents/ralph/efficiency.json.example to that path to configure one,")
    print("  or pass --profile <path>.")
    print(INERT_LINE)


def describe_profile(profile):
    ladder = " -> ".join("{}({})".format(r["name"], r["builder"]["pool"])
                         for r in profile["rungs"])
    return ladder


def cmd_validate(loaded, as_json):
    if as_json:
        payload = {"status": loaded["status"], "profile_path": loaded["path"],
                   "errors": loaded["errors"], "enforced": False}
        if loaded["status"] == STATUS_VALID:
            payload["rungs"] = [r["name"] for r in loaded["profile"]["rungs"]]
            payload["tiers"] = loaded["profile"]["tiers"]
            payload["reserves"] = loaded["profile"]["reserves"]
        if loaded["status"] == STATUS_REJECTED:
            warn_rejected(loaded)
        json.dump(payload, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0

    if loaded["status"] == STATUS_NOT_CONFIGURED:
        print_not_configured(loaded)
        return 0
    if loaded["status"] == STATUS_REJECTED:
        warn_rejected(loaded)
        print("efficiency profile: {}".format(loaded["path"]))
        print("  status: REJECTED (see the warning above)")
        print(INERT_LINE)
        return 0

    profile = loaded["profile"]
    print("efficiency profile: {}".format(loaded["path"]))
    print("  status: VALID")
    print("  ladder (cheapest first): {}".format(describe_profile(profile)))
    for rung in profile["rungs"]:
        caps = ", ".join("{}={}".format(pool, _cap_label(cap))
                         for pool, cap in sorted(rung["caps"].items()))
        print("    {}: builder={}({}) reviewer={}({}) caps[{}]{}".format(
            rung["name"], rung["builder"]["backend"], rung["builder"]["pool"],
            rung["reviewer"]["backend"], rung["reviewer"]["pool"], caps,
            " avoid_windows={}".format(len(rung.get("avoid_windows", [])))
            if rung.get("avoid_windows") else ""))
    print("  reserves: {}".format(", ".join(
        "{}={}".format(k, v) for k, v in sorted(profile["reserves"].items())) or "none"))
    for tier in TIERS:
        print("  tier {}: {}".format(tier, " -> ".join(profile["tiers"][tier])))
    print(GOVERNS_NOTHING)
    return 0


def _cap_label(cap):
    pcts = all(field in cap for field in PCT_FIELDS)
    windows = ("{}%/5h {}%/week".format(cap["window_5h_pct"], cap["window_weekly_pct"])
               if pcts else "")
    if "backstop" in cap:
        label = "backstop"
    elif "source" in cap:
        label = "{}{}".format(cap["source"], " " + windows if pcts else "")
    else:
        label = windows
    extras = []
    if USAGE_PROVIDER_KEY in cap:
        extras.append("pct from {}".format(cap[USAGE_PROVIDER_KEY]))
    if BUDGET_5H_KEY in cap:
        extras.append("{} tok/5h".format(cap[BUDGET_5H_KEY]))
    if BUDGET_WEEKLY_KEY in cap:
        extras.append("{} tok/week".format(cap[BUDGET_WEEKLY_KEY]))
    if WEEKLY_ANCHOR_KEY in cap:
        extras.append("weekly reset anchored at {}".format(cap[WEEKLY_ANCHOR_KEY]))
    return "{} usage[{}]".format(label, " ".join(extras)) if extras else label


def _local_window_line(record):
    """One line for a normalized per-pool usage record (#60/#68)."""
    if record.get("pct_source") == CAP_SOURCE_PROVIDER_PCT:
        share = "{:.1f}% reported by the usage provider {}".format(
            record["pct"], record["usage_provider"])
    elif record["budget_tokens"] is None:
        share = "no budget configured -> pct unknown"
    else:
        share = "{:.1f}% of the {}-token budget".format(
            record["pct"], record["budget_tokens"])
    line = "pool {} {} window: {} token(s) over {} record(s), {}".format(
        record["pool"], record["window"], record["used_tokens"],
        record["records"], share)
    if record["reset_at"] != "unknown":
        line += "; resets {} ({})".format(record["reset_at"], record["reset_basis"])
    else:
        line += "; reset unknown ({})".format(record["reset_basis"])
    if record["window"] == "weekly":
        line += "; near_weekly_reset={}".format(
            USAGE_STATE.shown_flag(record["near_weekly_reset"]) if USAGE_STATE
            else record["near_weekly_reset"])
    if record["in_avoid_window"]:
        line += "; a rung using this pool is inside an avoid window now"
    return line


def _reserve_summary_lines(block):
    """Human lines for the role -> pool -> reserve resolution (#63)."""
    lines = []
    for role in ROLES:
        entry = block["roles"].get(role, {})
        lines.append("  reserve: {} -> pool {} ({})".format(
            role, entry.get("pool") or "none", entry.get("source", "")))
    effective = block["effective"]
    lines.append("  reserve: effective per pool: {} (near_weekly_reset_hours={}, {})".format(
        "; ".join("{} {}% = {}".format(
            pool, effective[pool], _reserve_parts_label(block["stacked"][pool]))
            for pool in sorted(effective)) or "none",
        block["near_weekly_reset_hours"], block["near_weekly_reset_hours_source"]))
    return lines


def cmd_explain(loaded, complexity, repo, as_json, exhausted=()):
    now = now_utc()

    if loaded["status"] != STATUS_VALID:
        if loaded["status"] == STATUS_REJECTED:
            warn_rejected(loaded)
        if as_json:
            json.dump({"status": loaded["status"], "profile_path": loaded["path"],
                       "errors": loaded["errors"], "complexity": complexity,
                       "chosen": None, "enforced": False,
                       "why": "efficiency mode is OFF (inert)"},
                      sys.stdout, indent=2, sort_keys=True)
            sys.stdout.write("\n")
            return 0
        if loaded["status"] == STATUS_NOT_CONFIGURED:
            print_not_configured(loaded)
        else:
            print("efficiency profile: {}".format(loaded["path"]))
            print("  status: REJECTED (see the warning above)")
            print(INERT_LINE)
        return 0

    profile = loaded["profile"]
    usage = read_ledger_usage(repo, now, profile)
    result = select_rung(profile, complexity, usage, now, exhausted)

    if as_json:
        payload = dict(result)
        payload["selection_status"] = result["status"]
        payload["status"] = STATUS_VALID          # the PROFILE's status, as ever
        payload["chosen"] = result["rung_name"]   # explain's historical key
        payload["profile_path"] = loaded["path"]
        payload["now_utc"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        payload["usage"] = {"ledger": usage["ledger"], "notes": usage["notes"],
                            "pools": usage["pools"],
                            # The normalized per-pool records (#60), verbatim.
                            "state": usage["state"]}
        payload["enforced"] = False
        json.dump(payload, sys.stdout, indent=2, sort_keys=True, default=str)
        sys.stdout.write("\n")
        return 0

    print("efficiency explain — complexity: {}".format(complexity))
    print("  profile: {} (VALID)".format(loaded["path"]))
    print("  now (UTC): {}".format(now.strftime("%Y-%m-%dT%H:%M:%SZ")))
    for note in usage["notes"]:
        print("  usage: {}".format(note))
    for line in _reserve_summary_lines(result["reserves"]):
        print(line)
    print("  tier {} allows (in order): {}".format(
        complexity, " -> ".join(result["order"])))
    print("")
    for i, rung in enumerate(result["rungs"], start=1):
        print("  {}. {}{}  builder={}({}) reviewer={}({})".format(
            i, rung["name"], "" if rung["in_tier"] else " [backstop, outside the tier order]",
            rung["builder"]["backend"], rung["builder"]["pool"],
            rung["reviewer"]["backend"], rung["reviewer"]["pool"]))
        for check in rung["checks"]:
            print("     [{}] {}".format("ok" if check["ok"] else "no", check["detail"]))
        for pool in rung["pools"]:
            pool_usage = _pool_usage(usage, pool)
            observed = pool_usage["observed_weekly"]
            if observed["records"]:
                print("     [--] pool {}: ledger shows {} record(s), {} token(s), "
                      "${:.6f} in the last 7d".format(
                          pool, observed["records"], observed["tokens"], observed["cost_usd"]))
            for window in ("5h", "weekly"):
                local = pool_usage.get("local_{}".format(window))
                if local:
                    print("     [--] {}".format(_local_window_line(local)))
        print("     => {}".format("ELIGIBLE" if rung["eligible"] else "NOT ELIGIBLE"))
        print("")
    print("CHOSEN: {}".format(result["rung_name"] or "none"))
    print("WHY: {}".format(result["reason"]))
    if result["status"] == SELECT_PAUSED:
        print("PAUSE: bounded — retry in {}s (at {})".format(
            result["pause"]["seconds"], result["pause"]["until"]))
    print(GOVERNS_NOTHING)
    return 0


# ---------------------------------------------------------------------------
# select
#
# Exit code is a STATUS, never a crash: 0 = a rung was selected, EXIT_PAUSED = the
# bounded pause, EXIT_INERT = efficiency is off (no profile / rejected profile), in
# which case the caller keeps its normal --builder/--reviewer path.
# ---------------------------------------------------------------------------
EXIT_PAUSED = 3
EXIT_INERT = 4
# #64: --after-rung was asked for a promotion and the ladder has nothing stronger
# left. Terminal for the caller — unlike a PAUSE, retrying later changes nothing.
EXIT_EXHAUSTED = 5

SELECT_GOVERNS_NOTHING = (
    "note: this CLI seam only reports the decision — nothing was dispatched here. "
    "Under --efficiency the loops apply it to the ticket they are about to dispatch; "
    "without it, --builder/--reviewer selection is unchanged.")


def _shell_assignments(pairs):
    """Emit `KEY=value` lines that a shell can safely `eval`."""
    import shlex
    for key, value in pairs:
        print("{}={}".format(key, shlex.quote("" if value is None else str(value))))


def _select_shell_payload(result, loaded, now):
    return [
        ("RALPH_EFFICIENCY_SELECT_STATUS", result["status"]),
        ("RALPH_EFFICIENCY_SELECT_COMPLEXITY", result.get("complexity")),
        ("RALPH_EFFICIENCY_SELECT_RUNG", result.get("rung_name")),
        ("RALPH_EFFICIENCY_SELECT_BUILDER",
         (result.get("builder") or {}).get("backend")),
        ("RALPH_EFFICIENCY_SELECT_BUILDER_POOL",
         (result.get("builder") or {}).get("pool")),
        ("RALPH_EFFICIENCY_SELECT_REVIEWER",
         (result.get("reviewer") or {}).get("backend")),
        ("RALPH_EFFICIENCY_SELECT_REVIEWER_POOL",
         (result.get("reviewer") or {}).get("pool")),
        ("RALPH_EFFICIENCY_SELECT_BACKSTOP", "1" if result.get("backstop") else ""),
        ("RALPH_EFFICIENCY_SELECT_AFTER_RUNG", result.get("after_rung")),
        ("RALPH_EFFICIENCY_SELECT_PAUSE_SECONDS",
         (result.get("pause") or {}).get("seconds")),
        ("RALPH_EFFICIENCY_SELECT_PAUSE_UNTIL", (result.get("pause") or {}).get("until")),
        ("RALPH_EFFICIENCY_SELECT_REASON", result.get("reason")),
        ("RALPH_EFFICIENCY_SELECT_PROFILE", loaded["path"]),
        ("RALPH_EFFICIENCY_SELECT_NOW", now.strftime("%Y-%m-%dT%H:%M:%SZ")),
    ]


def cmd_select(loaded, complexity, repo, as_json, as_shell, exhausted, after_rung=None):
    now = now_utc()

    if loaded["status"] != STATUS_VALID:
        # Reject-to-safe (4a): a bad or missing profile makes efficiency inert.
        # There is no partial enforcement — the caller keeps its own selection.
        if loaded["status"] == STATUS_REJECTED:
            warn_rejected(loaded)
        inert = {"status": SELECT_INERT, "complexity": complexity, "rung_name": None,
                 "builder": None, "reviewer": None, "pause": None, "backstop": False,
                 "enforced": False,
                 "reason": "efficiency mode is OFF (inert): profile {}".format(
                     loaded["status"])}
        if as_shell:
            _shell_assignments(_select_shell_payload(inert, loaded, now))
            return EXIT_INERT
        if as_json:
            payload = dict(inert)
            payload["profile_status"] = loaded["status"]
            payload["profile_path"] = loaded["path"]
            payload["errors"] = loaded["errors"]
            json.dump(payload, sys.stdout, indent=2, sort_keys=True, default=str)
            sys.stdout.write("\n")
            return EXIT_INERT
        if loaded["status"] == STATUS_NOT_CONFIGURED:
            print_not_configured(loaded)
        else:
            print("efficiency profile: {}".format(loaded["path"]))
            print("  status: REJECTED (see the warning above)")
            print(INERT_LINE)
        return EXIT_INERT

    usage = read_ledger_usage(repo, now, loaded["profile"])
    result = select_rung(loaded["profile"], complexity, usage, now, exhausted,
                         after_rung=after_rung)
    code = {SELECT_SELECTED: 0, SELECT_EXHAUSTED: EXIT_EXHAUSTED}.get(
        result["status"], EXIT_PAUSED)

    if as_shell:
        _shell_assignments(_select_shell_payload(result, loaded, now))
        return code
    if as_json:
        payload = dict(result)
        payload["profile_status"] = loaded["status"]
        payload["profile_path"] = loaded["path"]
        payload["now_utc"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        payload["usage"] = {"ledger": usage["ledger"], "notes": usage["notes"],
                            "pools": usage["pools"], "state": usage["state"]}
        payload["exhausted_pools"] = sorted(exhausted)
        json.dump(payload, sys.stdout, indent=2, sort_keys=True, default=str)
        sys.stdout.write("\n")
        return code

    print("efficiency select — complexity: {}{}".format(
        complexity, "" if after_rung is None else
        " (escalating above rung '{}')".format(after_rung)))
    print("  profile: {} (VALID)".format(loaded["path"]))
    print("  now (UTC): {}".format(now.strftime("%Y-%m-%dT%H:%M:%SZ")))
    for line in _reserve_summary_lines(result["reserves"]):
        print(line)
    if exhausted:
        print("  #28 open quota circuits: {}".format(", ".join(sorted(exhausted))))
    if result["status"] == SELECT_PAUSED:
        print("PAUSE: bounded — retry in {}s (at {})".format(
            result["pause"]["seconds"], result["pause"]["until"]))
    elif result["status"] == SELECT_EXHAUSTED:
        print("EXHAUSTED: no rung stronger than '{}' is available".format(after_rung))
    else:
        print("SELECTED: {}{}".format(
            result["rung_name"], " (backstop)" if result["backstop"] else ""))
        print("  builder:  {} (pool {})".format(
            result["builder"]["backend"], result["builder"]["pool"]))
        print("  reviewer: {} (pool {})".format(
            result["reviewer"]["backend"], result["reviewer"]["pool"]))
    print("REASON: {}".format(result["reason"]))
    print(SELECT_GOVERNS_NOTHING)
    return code


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
USAGE = (
    "Usage: efficiency.py validate [--profile PATH] [--repo DIR] [--json]\n"
    "       efficiency.py explain --complexity <{tiers}> "
    "[--profile PATH] [--repo DIR] [--json]\n"
    "       efficiency.py select --complexity <{tiers}> "
    "[--profile PATH] [--repo DIR] [--json|--shell]\n"
    "                            [--exhausted-pool POOL]... [--after-rung NAME]".format(
        tiers="|".join(TIERS))
)


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    command = argv[0]
    if command not in ("validate", "explain", "select"):
        print("ralph: unknown efficiency command {!r}".format(command), file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    profile_arg = None
    repo = os.getcwd()
    complexity = None
    as_json = False
    as_shell = False
    # Pools whose #28 circuit the CALLER found open. agents.sh owns that decision
    # (ralph_quota_pool_is_exhausted); this module never re-derives it.
    exhausted = []
    # #64: the rung a failed run is escalating ABOVE. None = ordinary selection.
    after_rung = None
    rest = argv[1:]
    i = 0
    while i < len(rest):
        arg = rest[i]
        if arg == "--json":
            as_json = True
        elif arg == "--shell":
            as_shell = True
        elif arg in ("--profile", "--repo", "--complexity", "--exhausted-pool",
                     "--after-rung"):
            if i + 1 >= len(rest):
                print("ralph: {} needs a value".format(arg), file=sys.stderr)
                return 2
            value = rest[i + 1]
            i += 1
            if arg == "--profile":
                profile_arg = value
            elif arg == "--repo":
                repo = value
            elif arg == "--exhausted-pool":
                exhausted.append(value)
            elif arg == "--after-rung":
                after_rung = value
            else:
                complexity = value
        elif arg.startswith("--profile="):
            profile_arg = arg.split("=", 1)[1]
        elif arg.startswith("--repo="):
            repo = arg.split("=", 1)[1]
        elif arg.startswith("--complexity="):
            complexity = arg.split("=", 1)[1]
        elif arg.startswith("--exhausted-pool="):
            exhausted.append(arg.split("=", 1)[1])
        elif arg.startswith("--after-rung="):
            after_rung = arg.split("=", 1)[1]
        else:
            print("ralph: unknown efficiency option {!r}".format(arg), file=sys.stderr)
            print(USAGE, file=sys.stderr)
            return 2
        i += 1

    if USAGE_STATE is None:
        # The reader owns the clock/window primitives; without it nothing here can
        # be evaluated honestly, so fall back to inert exactly like a rejection.
        print(USAGE_STATE_MISSING, file=sys.stderr)
        if as_shell:
            _shell_assignments([("RALPH_EFFICIENCY_SELECT_STATUS", SELECT_INERT),
                                ("RALPH_EFFICIENCY_SELECT_REASON", USAGE_STATE_MISSING)])
        else:
            print(INERT_LINE)
        return EXIT_INERT if command == "select" else 0

    path = resolve_profile_path(profile_arg, repo)
    loaded = load_profile(path)

    if command == "validate":
        return cmd_validate(loaded, as_json)

    if not complexity:
        print("ralph: {} needs --complexity <{}>".format(command, "|".join(TIERS)),
              file=sys.stderr)
        return 2
    if complexity not in TIERS:
        print("ralph: unknown complexity {!r} — expected one of {}".format(
            complexity, ", ".join(TIERS)), file=sys.stderr)
        return 2
    if command == "select":
        return cmd_select(loaded, complexity, repo, as_json, as_shell, exhausted,
                          after_rung)
    if after_rung is not None:
        print("ralph: --after-rung applies to `select` only", file=sys.stderr)
        return 2
    return cmd_explain(loaded, complexity, repo, as_json, exhausted)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""Parse, validate and explain a declarative Ralph efficiency profile (#59).

The profile describes a LADDER of rungs (cheapest first), the credential pool
each role draws from, the window caps / avoid-windows that make a pool
ineligible, the reserves to keep for higher-value work, and which rungs each
complexity tier is allowed to use.

This slice GOVERNS NOTHING. It parses, validates and explains — it never selects
a backend, never enforces a reserve and never dispatches. Wiring it into
builder/reviewer selection is a later slice (#54 step 4c).

Usage:
  python3 efficiency.py validate [--profile PATH] [--repo DIR] [--json]
  python3 efficiency.py explain --complexity <trivial|small|medium|large>
                                [--profile PATH] [--repo DIR] [--json]

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
DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
ALL_DAYS_WORDS = ("*", "all", "any", "daily", "everyday")

STATUS_VALID = "valid"
STATUS_NOT_CONFIGURED = "not_configured"
STATUS_REJECTED = "rejected"


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
    """Parse "HH:MM" into minutes-since-midnight, or None if malformed."""
    if not isinstance(val, str):
        return None
    parts = val.strip().split(":")
    if len(parts) != 2:
        return None
    try:
        hour = int(parts[0])
        minute = int(parts[1])
    except ValueError:
        return None
    if not (0 <= hour <= 24 and 0 <= minute <= 59):
        return None
    if hour == 24 and minute != 0:
        return None
    return hour * 60 + minute


def parse_days(spec):
    """Parse a days spec into a set of weekday indexes (Mon=0), or None.

    Accepts "Mon-Fri", "Sat,Sun", "Mon-Wed,Sat", "*"/"all"/"daily".
    Ranges wrap around the week ("Sat-Mon" = Sat, Sun, Mon).
    """
    if not _nonempty_str(spec):
        return None
    text = spec.strip().lower()
    if text in ALL_DAYS_WORDS:
        return set(range(7))
    days = set()
    for part in text.split(","):
        part = part.strip()
        if not part:
            return None
        if "-" in part:
            start_name, _, end_name = part.partition("-")
            start_name = start_name.strip()[:3]
            end_name = end_name.strip()[:3]
            if start_name not in DAY_NAMES or end_name not in DAY_NAMES:
                return None
            start = DAY_NAMES.index(start_name)
            end = DAY_NAMES.index(end_name)
            idx = start
            days.add(idx)
            while idx != end:
                idx = (idx + 1) % 7
                days.add(idx)
        else:
            name = part[:3]
            if name not in DAY_NAMES:
                return None
            days.add(DAY_NAMES.index(name))
    return days or None


def _validate_cap(cap, where, errors):
    """Validate one cap block and return its kind (pct/provider/backstop/None)."""
    if not isinstance(cap, dict):
        errors.append("{}: must be an object".format(where))
        return None
    keys = set(cap.keys())
    if keys == {"source"}:
        if cap.get("source") != "provider":
            errors.append("{}.source: only \"provider\" is supported (got {!r})".format(
                where, cap.get("source")))
            return None
        return "provider"
    if keys == {"backstop"}:
        if cap.get("backstop") is not True:
            errors.append("{}.backstop: must be true".format(where))
            return None
        return "backstop"
    if keys == {"window_5h_pct", "window_weekly_pct"}:
        ok = True
        for field in ("window_5h_pct", "window_weekly_pct"):
            if not _is_pct(cap.get(field)):
                errors.append("{}.{}: must be a number 0-100 (got {!r})".format(
                    where, field, cap.get(field)))
                ok = False
        return "pct" if ok else None
    errors.append(
        "{}: unknown cap shape {} — expected "
        "{{window_5h_pct, window_weekly_pct}} or {{source: \"provider\"}} "
        "or {{backstop: true}}".format(where, sorted(keys)))
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
            if key.endswith("_weekly_pct"):
                if not _is_pct(val):
                    errors.append("reserves.{}: must be a number 0-100 (got {!r})".format(key, val))
            elif key == "near_weekly_reset_hours":
                if not _is_number(val) or val < 0:
                    errors.append(
                        "reserves.near_weekly_reset_hours: must be a number >= 0 "
                        "(got {!r})".format(val))
            else:
                errors.append(
                    "reserves.{}: unknown key — expected <pool>_weekly_pct or "
                    "near_weekly_reset_hours".format(key))

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
    if not _nonempty_str(text):
        return None
    value = text.strip()
    if value.endswith("Z") or value.endswith("z"):
        value = value[:-1] + "+00:00"
    try:
        parsed = datetime.datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone(datetime.timezone.utc)


def now_utc():
    """Current UTC time, overridable with RALPH_EFFICIENCY_NOW (tests/ops)."""
    override = os.environ.get("RALPH_EFFICIENCY_NOW", "")
    if override.strip():
        parsed = _parse_iso_utc(override)
        if parsed is not None:
            return parsed
        print("ralph: ignoring unparseable RALPH_EFFICIENCY_NOW={!r}".format(override),
              file=sys.stderr)
    return datetime.datetime.now(datetime.timezone.utc)


def window_active(win, now):
    """True when `now` (aware UTC) falls inside an avoid window."""
    start = parse_hhmm(win.get("from"))
    end = parse_hhmm(win.get("to"))
    days = parse_days(win.get("days"))
    if start is None or end is None or days is None or start == end:
        return False
    minutes = now.hour * 60 + now.minute
    weekday = now.weekday()
    if start < end:
        return weekday in days and start <= minutes < end
    # Overnight window: [from, midnight) on a matching day, then [midnight, to)
    # on the day after a matching day.
    if weekday in days and minutes >= start:
        return True
    return ((weekday - 1) % 7) in days and minutes < end


# ---------------------------------------------------------------------------
# Usage (per credential pool), read from the ledger when it has observations
# ---------------------------------------------------------------------------
def _load_report_module():
    """Import the sibling report.py so we reuse its pricing/aggregation helpers."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "report.py")
    if not os.path.isfile(path):
        return None
    try:
        import importlib.util
        # Loading report.py by path must not leave a __pycache__ behind in the
        # template dir — that would dirty a target repo working tree.
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location("ralph_report", path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:  # a broken report.py must not take explain down
        return None


def read_ledger_usage(repo, now):
    """Per-pool usage read from <repo>/.ralph/ledger.jsonl.

    Two things come out of the ledger, and they are NOT the same thing:

      * observed spend — records/tokens/cost per pool inside the 5h and weekly
        windows, aggregated exactly like `ralph report` does (same pricing table,
        same provider->pool alias resolution).
      * quota percentages — only if a record carries a "quota" block
        {pool, window_5h_pct, window_weekly_pct, weekly_reset_at}. The ledger has
        no quota denominator of its own, so without such a block the percentage
        is UNKNOWN and the caller assumes 0% (and says so).

    Returns {"ledger": path|None, "pools": {pool: {...}}, "notes": [...]}.
    """
    ledger = os.path.join(os.path.abspath(repo), ".ralph", "ledger.jsonl")
    result = {"ledger": None, "pools": {}, "notes": []}
    if not os.path.isfile(ledger):
        result["notes"].append(
            "no ledger at {} — assuming 0% used for every pool".format(ledger))
        return result

    result["ledger"] = ledger
    records = []
    try:
        with open(ledger, "r", encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(rec, dict):
                    records.append(rec)
    except OSError:
        result["notes"].append(
            "ledger {} is not readable — assuming 0% used for every pool".format(ledger))
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
        return result["pools"].setdefault(pool, {
            "window_5h_pct": None,
            "window_weekly_pct": None,
            "weekly_reset_at": None,
            "observed_5h": {"records": 0, "tokens": 0, "cost_usd": 0.0},
            "observed_weekly": {"records": 0, "tokens": 0, "cost_usd": 0.0},
        })

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
                quota_seen = True
        if _nonempty_str(quota.get("weekly_reset_at")):
            entry["weekly_reset_at"] = quota["weekly_reset_at"].strip()
            quota_seen = True

    for entry in result["pools"].values():
        entry.pop("_observed_at", None)

    if quota_seen:
        result["notes"].append(
            "per-pool quota usage read from the ledger {}".format(ledger))
    else:
        result["notes"].append(
            "ledger {} has observed spend but no quota observations "
            "(no record carries a \"quota\" block), so window usage is unknown — "
            "assuming 0% used".format(ledger))
    return result


def _pool_usage(usage, pool):
    entry = usage["pools"].get(pool)
    if entry is None:
        return {
            "window_5h_pct": None,
            "window_weekly_pct": None,
            "weekly_reset_at": None,
            "observed_5h": {"records": 0, "tokens": 0, "cost_usd": 0.0},
            "observed_weekly": {"records": 0, "tokens": 0, "cost_usd": 0.0},
        }
    return entry


def _hours_to_reset(reset_at, now):
    parsed = _parse_iso_utc(reset_at or "")
    if parsed is None:
        return None
    return (parsed - now).total_seconds() / 3600.0


# ---------------------------------------------------------------------------
# Explain
# ---------------------------------------------------------------------------
def evaluate(profile, complexity, usage, now):
    """Evaluate every rung of a tier and pick the first fully eligible one."""
    rungs = {r["name"]: r for r in profile["rungs"]}
    order = profile["tiers"][complexity]
    reserves = profile.get("reserves", {})
    near_reset_hours = reserves.get("near_weekly_reset_hours")

    evaluated = []
    chosen = None
    chosen_at = None
    for name in order:
        rung = rungs[name]
        checks = []
        eligible = True

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

        for pool in pools:
            cap = rung["caps"][pool]
            pool_usage = _pool_usage(usage, pool)
            used_5h = pool_usage["window_5h_pct"]
            used_weekly = pool_usage["window_weekly_pct"]
            assumed = " (assumed, no observation)"
            used_5h_val = used_5h if used_5h is not None else 0.0
            used_weekly_val = used_weekly if used_weekly is not None else 0.0

            if "backstop" in cap:
                checks.append({
                    "kind": "cap", "pool": pool, "ok": True,
                    "detail": "pool {}: backstop rung — no window cap, always eligible".format(pool),
                })
            elif "source" in cap:
                checks.append({
                    "kind": "cap", "pool": pool, "ok": True,
                    "detail": "pool {}: cap source=provider — the provider enforces its own "
                              "limit, the harness applies none".format(pool),
                })
            else:
                for field, used, used_label in (
                    ("window_5h_pct", used_5h, "5h"),
                    ("window_weekly_pct", used_weekly, "weekly"),
                ):
                    limit = cap[field]
                    value = used if used is not None else 0.0
                    over = value >= limit
                    checks.append({
                        "kind": "cap", "pool": pool, "ok": not over,
                        "detail": "pool {}: {} window {:.1f}%{} vs cap {}% — {}".format(
                            pool, used_label, value,
                            "" if used is not None else assumed,
                            limit, "OVER CAP" if over else "under cap"),
                    })
                    if over:
                        eligible = False

            reserve_key = "{}_weekly_pct".format(pool)
            reserve = reserves.get(reserve_key)
            if reserve is None:
                checks.append({
                    "kind": "reserve", "pool": pool, "ok": True,
                    "detail": "pool {}: no reserve configured ({} unset)".format(pool, reserve_key),
                })
            else:
                remaining = 100.0 - used_weekly_val
                hours = _hours_to_reset(pool_usage["weekly_reset_at"], now)
                relaxed = (
                    _is_number(near_reset_hours)
                    and hours is not None
                    and hours <= near_reset_hours
                )
                breached = remaining < reserve
                if relaxed:
                    checks.append({
                        "kind": "reserve", "pool": pool, "ok": True,
                        "detail": "pool {}: reserve {}% RELAXED — weekly quota resets in "
                                  "{:.1f}h (<= near_weekly_reset_hours={})".format(
                                      pool, reserve, hours, near_reset_hours),
                    })
                else:
                    detail = "pool {}: {:.1f}% of the weekly window left{} vs reserve {}% — {}".format(
                        pool, remaining,
                        "" if used_weekly is not None else assumed,
                        reserve, "BELOW RESERVE" if breached else "above reserve")
                    if hours is None:
                        detail += "; weekly reset time unknown, no relaxation"
                    checks.append({
                        "kind": "reserve", "pool": pool, "ok": not breached, "detail": detail,
                    })
                    if breached:
                        eligible = False

        evaluated.append({
            "name": name,
            "builder": rung["builder"],
            "reviewer": rung["reviewer"],
            "pools": pools,
            "eligible": eligible,
            "checks": checks,
        })
        if eligible and chosen is None:
            chosen = name
            chosen_at = len(evaluated) - 1

    if chosen is None:
        why = ("no rung in tier '{}' is eligible right now — every allowed rung is "
               "blocked by a cap, an active avoid window or a reserve".format(complexity))
    else:
        blocked = [r["name"] for r in evaluated[:chosen_at] if not r["eligible"]]
        if blocked:
            why = ("first eligible rung in tier '{}' — {} {} skipped (see above)".format(
                complexity, ", ".join(blocked), "was" if len(blocked) == 1 else "were"))
        else:
            why = ("cheapest rung in tier '{}' and every check passed".format(complexity))

    return {"complexity": complexity, "order": list(order), "rungs": evaluated,
            "chosen": chosen, "why": why}


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
INERT_LINE = "efficiency mode: OFF (inert) — builder/reviewer selection is unchanged"
GOVERNS_NOTHING = ("note: this slice parses and explains only — efficiency mode governs "
                   "nothing yet, nothing was dispatched, and --builder/--reviewer "
                   "selection is unchanged.")


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
    if "backstop" in cap:
        return "backstop"
    if "source" in cap:
        return "provider"
    return "{}%/5h {}%/week".format(cap["window_5h_pct"], cap["window_weekly_pct"])


def cmd_explain(loaded, complexity, repo, as_json):
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
    usage = read_ledger_usage(repo, now)
    result = evaluate(profile, complexity, usage, now)

    if as_json:
        payload = dict(result)
        payload["status"] = STATUS_VALID
        payload["profile_path"] = loaded["path"]
        payload["now_utc"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        payload["usage"] = {"ledger": usage["ledger"], "notes": usage["notes"],
                            "pools": usage["pools"]}
        payload["enforced"] = False
        json.dump(payload, sys.stdout, indent=2, sort_keys=True, default=str)
        sys.stdout.write("\n")
        return 0

    print("efficiency explain — complexity: {}".format(complexity))
    print("  profile: {} (VALID)".format(loaded["path"]))
    print("  now (UTC): {}".format(now.strftime("%Y-%m-%dT%H:%M:%SZ")))
    for note in usage["notes"]:
        print("  usage: {}".format(note))
    print("  tier {} allows (in order): {}".format(
        complexity, " -> ".join(result["order"])))
    print("")
    for i, rung in enumerate(result["rungs"], start=1):
        print("  {}. {}  builder={}({}) reviewer={}({})".format(
            i, rung["name"], rung["builder"]["backend"], rung["builder"]["pool"],
            rung["reviewer"]["backend"], rung["reviewer"]["pool"]))
        for check in rung["checks"]:
            print("     [{}] {}".format("ok" if check["ok"] else "no", check["detail"]))
        for pool in rung["pools"]:
            observed = _pool_usage(usage, pool)["observed_weekly"]
            if observed["records"]:
                print("     [--] pool {}: ledger shows {} record(s), {} token(s), "
                      "${:.6f} in the last 7d".format(
                          pool, observed["records"], observed["tokens"], observed["cost_usd"]))
        print("     => {}".format("ELIGIBLE" if rung["eligible"] else "NOT ELIGIBLE"))
        print("")
    print("CHOSEN: {}".format(result["chosen"] or "none"))
    print("WHY: {}".format(result["why"]))
    print(GOVERNS_NOTHING)
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
USAGE = (
    "Usage: efficiency.py validate [--profile PATH] [--repo DIR] [--json]\n"
    "       efficiency.py explain --complexity <{}> "
    "[--profile PATH] [--repo DIR] [--json]".format("|".join(TIERS))
)


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    command = argv[0]
    if command not in ("validate", "explain"):
        print("ralph: unknown efficiency command {!r}".format(command), file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    profile_arg = None
    repo = os.getcwd()
    complexity = None
    as_json = False
    rest = argv[1:]
    i = 0
    while i < len(rest):
        arg = rest[i]
        if arg == "--json":
            as_json = True
        elif arg in ("--profile", "--repo", "--complexity"):
            if i + 1 >= len(rest):
                print("ralph: {} needs a value".format(arg), file=sys.stderr)
                return 2
            value = rest[i + 1]
            i += 1
            if arg == "--profile":
                profile_arg = value
            elif arg == "--repo":
                repo = value
            else:
                complexity = value
        elif arg.startswith("--profile="):
            profile_arg = arg.split("=", 1)[1]
        elif arg.startswith("--repo="):
            repo = arg.split("=", 1)[1]
        elif arg.startswith("--complexity="):
            complexity = arg.split("=", 1)[1]
        else:
            print("ralph: unknown efficiency option {!r}".format(arg), file=sys.stderr)
            print(USAGE, file=sys.stderr)
            return 2
        i += 1

    path = resolve_profile_path(profile_arg, repo)
    loaded = load_profile(path)

    if command == "validate":
        return cmd_validate(loaded, as_json)

    if not complexity:
        print("ralph: explain needs --complexity <{}>".format("|".join(TIERS)), file=sys.stderr)
        return 2
    if complexity not in TIERS:
        print("ralph: unknown complexity {!r} — expected one of {}".format(
            complexity, ", ".join(TIERS)), file=sys.stderr)
        return 2
    return cmd_explain(loaded, complexity, repo, as_json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

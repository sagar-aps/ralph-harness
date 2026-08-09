#!/usr/bin/env python3
"""Per-credential-pool usage state, read from .ralph/ledger.jsonl (#60).

This is the read-only usage READER that `ralph explain` (#59) consumes and that a
later slice (#54 step 4c) will consult before it dispatches. It is a LOCAL
ESTIMATE: it calls no provider usage API. Everything it reports comes from the
ledger the harness itself wrote (#55) plus the operator's efficiency profile.

What it computes, per pool referenced by the profile's rungs:

  * used_tokens inside the rolling 5h window and inside the current weekly
    window, summed from each ledger line's own timestamp;
  * pct — from one of two sources, never invented:
      - a per-pool USAGE PROVIDER (#68): a cap of shape
        {source: "provider_pct", usage_provider: "<script>"} names a script this
        reader invokes; its printed JSON
        {window_5h_pct, window_weekly_pct, weekly_reset_at} IS the percentage.
        That is the only way a pool whose provider publishes usage as a
        PERCENTAGE ONLY (an Anthropic Pro/Max plan) can bind its cap and the
        reserves it carries, because such a plan has no token budget to divide
        by. A script that fails, times out or prints unparseable output FAILS
        OPEN: pct stays "unknown" and the #28 circuit is the gate;
      - otherwise the LEDGER path, which needs a per-pool token budget for that
        window (`window_5h_budget_tokens` / `window_weekly_budget_tokens` on the
        rung's cap block). With no budget there is no denominator, so pct is
        "unknown" and the raw token count is still reported. A percentage is
        NEVER fabricated: the #28 hard circuit remains the real backstop;
  * reset proximity — for 5h, when the oldest in-window record rolls off; for
    weekly, the next occurrence of the profile's `weekly_reset_anchor` (and
    whether that is "near" per reserves.near_weekly_reset_hours). With no
    anchor configured the weekly window is a rolling 7d and the reset is
    "unknown";
  * in_avoid_window — whether a rung drawing on the pool is inside one of its
    `avoid_windows` right now (current UTC day + time).

Read-only: it opens the ledger and the profile for reading and writes nothing. The
one thing it EXECUTES is a pool's own `usage_provider` adapter, which the operator
put in their own profile and which is expected to print JSON and change nothing.
It never enforces a cap or a reserve and never selects a backend.

Usage:
  python3 usage-state.py --repo DIR [--profile PATH] [--json]

Test/ops seam: RALPH_EFFICIENCY_NOW overrides "now" with an ISO-8601 UTC
timestamp, so windows and avoid-window evaluation are deterministic.
"""
import datetime
import json
import math
import os
import sys

FIVE_HOURS = datetime.timedelta(hours=5)
ONE_WEEK = datetime.timedelta(days=7)

DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
ALL_DAYS_WORDS = ("*", "all", "any", "daily", "everyday")

# Optional per-pool keys #60 adds to a cap block, named here because this is what
# consumes them (efficiency.py validates against these same names). They are
# additive: a cap still has to declare one of the #59 shapes.
BUDGET_5H_KEY = "window_5h_budget_tokens"
BUDGET_WEEKLY_KEY = "window_weekly_budget_tokens"
WEEKLY_ANCHOR_KEY = "weekly_reset_anchor"

# #68: the pool's own usage adapter — a script printing the provider's PERCENTAGES.
# It is what makes a %-only plan's cap and reserves bindable without a token budget.
USAGE_PROVIDER_KEY = "usage_provider"
CAP_SOURCE_PROVIDER = "provider"
CAP_SOURCE_PROVIDER_PCT = "provider_pct"

# The fields a usage adapter prints. The first two are the percentages; the third
# is what makes the weekly reset (and the near-reset relaxation) knowable.
PROVIDER_PCT_FIELDS = ("window_5h_pct", "window_weekly_pct")
PROVIDER_RESET_FIELD = "weekly_reset_at"

# A usage adapter that will not answer must not freeze the reader: it is killed and
# treated exactly like a failure (fail-open, pct unknown). RALPH_USAGE_PROVIDER_TIMEOUT
# moves the bound (tests/ops — an adapter behind a slow network); it is never unbounded.
USAGE_PROVIDER_TIMEOUT_SECONDS = 20
USAGE_PROVIDER_TIMEOUT_ENV = "RALPH_USAGE_PROVIDER_TIMEOUT"

UNKNOWN = "unknown"

SOURCE_LEDGER = "ledger"
SOURCE_NONE = "none"
SOURCE_UNREADABLE = "ledger-unreadable"

# Where a record's pct came from — None when there is none.
PCT_SOURCE_BUDGET = "budget"
PCT_SOURCE_PROVIDER = "provider_pct"

# reset_basis when the weekly reset was reported by a usage adapter.
RESET_BASIS_PROVIDER = "usage_provider"


# ---------------------------------------------------------------------------
# Small shared primitives (efficiency.py delegates to these)
# ---------------------------------------------------------------------------
def is_number(val):
    return isinstance(val, (int, float)) and not isinstance(val, bool)


def nonempty_str(val):
    return isinstance(val, str) and val.strip() != ""


def parse_iso_utc(text):
    """Parse an ISO-8601 timestamp into an aware UTC datetime, or None."""
    if not nonempty_str(text):
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


def iso_z(moment):
    """Format an aware datetime as ...Z, or return "unknown" for None."""
    if moment is None:
        return UNKNOWN
    return moment.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_utc():
    """Current UTC time, overridable with RALPH_EFFICIENCY_NOW (tests/ops)."""
    override = os.environ.get("RALPH_EFFICIENCY_NOW", "")
    if override.strip():
        parsed = parse_iso_utc(override)
        if parsed is not None:
            return parsed
        print("ralph: ignoring unparseable RALPH_EFFICIENCY_NOW={!r}".format(override),
              file=sys.stderr)
    return datetime.datetime.now(datetime.timezone.utc)


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
    if not nonempty_str(spec):
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


def window_active(win, now):
    """True when `now` (aware UTC) falls inside an avoid window."""
    if not isinstance(win, dict):
        return False
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
# Ledger
# ---------------------------------------------------------------------------
def ledger_path(repo):
    return os.path.join(os.path.abspath(repo), ".ralph", "ledger.jsonl")


def read_ledger_records(path):
    """Read a JSONL ledger into a list of dicts.

    Returns (records, status) where status is one of the SOURCE_* constants.
    Malformed lines are skipped, never fatal — the ledger is append-only
    bookkeeping and a half-written last line must not take a reader down.
    """
    if not os.path.isfile(path):
        return [], SOURCE_NONE
    records = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
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
        return [], SOURCE_UNREADABLE
    return records, SOURCE_LEDGER


# ---------------------------------------------------------------------------
# Profile projection (pools, backends, budgets, anchors)
# ---------------------------------------------------------------------------
def profile_rungs(profile):
    rungs = profile.get("rungs") if isinstance(profile, dict) else None
    return [r for r in rungs if isinstance(r, dict)] if isinstance(rungs, list) else []


def rung_pools(rung):
    """The distinct pools a rung draws on, builder first."""
    pools = []
    for role in ("builder", "reviewer"):
        spec = rung.get(role)
        if isinstance(spec, dict) and nonempty_str(spec.get("pool")):
            pool = spec["pool"].strip()
            if pool not in pools:
                pools.append(pool)
    return pools


def profile_pools(profile):
    """Every pool referenced by the profile's rungs, in ladder order."""
    pools = []
    for rung in profile_rungs(profile):
        for pool in rung_pools(rung):
            if pool not in pools:
                pools.append(pool)
    return pools


def backend_pool_map(profile):
    """backend name -> pool, as declared by the rungs (first declaration wins)."""
    mapping = {}
    for rung in profile_rungs(profile):
        for role in ("builder", "reviewer"):
            spec = rung.get(role)
            if not isinstance(spec, dict):
                continue
            backend = spec.get("backend")
            pool = spec.get("pool")
            if nonempty_str(backend) and nonempty_str(pool):
                mapping.setdefault(backend.strip().lower(), pool.strip())
    return mapping


def pool_cap_value(profile, pool, key):
    """First value declared for `key` on `pool`'s cap block, cheapest rung first.

    Returns (value, conflicts) where conflicts lists the other distinct values
    seen for the same pool — the caller surfaces them as a note rather than
    silently picking one.
    """
    seen = []
    for rung in profile_rungs(profile):
        caps = rung.get("caps")
        if not isinstance(caps, dict):
            continue
        cap = caps.get(pool)
        if not isinstance(cap, dict) or key not in cap:
            continue
        value = cap[key]
        if value not in seen:
            seen.append(value)
    if not seen:
        return None, []
    return seen[0], seen[1:]


def pool_budget(profile, pool, window):
    key = BUDGET_5H_KEY if window == "5h" else BUDGET_WEEKLY_KEY
    value, conflicts = pool_cap_value(profile, pool, key)
    if not is_number(value) or value <= 0:
        return None, conflicts
    return value, conflicts


def pool_weekly_anchor(profile, pool):
    value, conflicts = pool_cap_value(profile, pool, WEEKLY_ANCHOR_KEY)
    return parse_iso_utc(value) if value is not None else None, conflicts


def pool_usage_provider(profile, pool):
    """(adapter path, conflicts) — the pool's `usage_provider` script, or None.

    Declared on the cap block, exactly like the token budgets. A cap of shape
    {source: "provider_pct", ...} always carries one (efficiency.py's validator
    requires it); any other shape MAY carry one, in which case the adapter's
    percentages simply replace the budget-derived ones.
    """
    value, conflicts = pool_cap_value(profile, pool, USAGE_PROVIDER_KEY)
    return (value.strip() if nonempty_str(value) else None), conflicts


# ---------------------------------------------------------------------------
# Usage providers (#68) — a pool's own adapter for provider-reported percentages
# ---------------------------------------------------------------------------
def is_pct(val):
    return is_number(val) and 0 <= val <= 100


def usage_provider_timeout():
    """Seconds to allow an adapter, from RALPH_USAGE_PROVIDER_TIMEOUT or the default."""
    raw = os.environ.get(USAGE_PROVIDER_TIMEOUT_ENV, "").strip()
    if raw:
        try:
            value = float(raw)
        except ValueError:
            value = 0
        if value > 0:
            return value
        print("ralph: ignoring unusable {}={!r}".format(USAGE_PROVIDER_TIMEOUT_ENV, raw),
              file=sys.stderr)
    return USAGE_PROVIDER_TIMEOUT_SECONDS


def resolve_usage_provider(script, repo):
    """Absolute path of a pool's adapter; a relative one is relative to the repo."""
    if os.path.isabs(script):
        return os.path.normpath(script)
    return os.path.normpath(os.path.join(os.path.abspath(repo), script))


def _empty_provider_usage(script, path):
    return {"usage_provider": script, "path": path, "window_5h_pct": None,
            "window_weekly_pct": None, "weekly_reset_at": None, "error": None}


def _kill_process_group(proc):
    """Kill a timed-out adapter AND anything it spawned, then reap it.

    Killing only the script itself is not enough: a grandchild (`sleep`, a curl the
    adapter left running) inherits the stdout pipe, so the read would keep blocking
    long past the timeout. The adapter is started in its own session, so the whole
    group can be signalled at once.
    """
    import signal
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except OSError:
        proc.kill()
    try:
        proc.communicate(timeout=5)
    except Exception:  # already gone, or a pipe still held: either way, move on
        pass


def run_usage_provider(script, pool, repo):
    """Invoke a pool's usage adapter and normalize the JSON it prints.

    The contract (documented in usage_provider.example.sh): exit 0 and print ONE
    JSON object {window_5h_pct, window_weekly_pct, weekly_reset_at} on stdout.
    Argv is <pool> <repo>, and the same two values are also passed as
    RALPH_USAGE_PROVIDER_POOL / RALPH_USAGE_PROVIDER_REPO.

    Returns the normalized record; `error` is a human string when the adapter
    could not be used at all. EVERY failure mode — missing file, non-zero exit,
    timeout, unparseable or out-of-range output — leaves the percentage(s) None
    so the caller FAILS OPEN and defers to the #28 circuit. Never raises.
    """
    path = resolve_usage_provider(script, repo)
    out = _empty_provider_usage(script, path)
    if not os.path.isfile(path):
        out["error"] = "no such script"
        return out
    timeout = usage_provider_timeout()

    import subprocess
    env = dict(os.environ)
    env["RALPH_USAGE_PROVIDER_POOL"] = pool
    env["RALPH_USAGE_PROVIDER_REPO"] = os.path.abspath(repo)
    # An executable script runs on its own shebang; anything else is handed to
    # bash, so a non-chmod +x adapter still works instead of silently failing open.
    argv = ([path] if os.access(path, os.X_OK) else ["bash", path]) + [pool, os.path.abspath(repo)]
    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=os.path.abspath(repo), env=env, universal_newlines=True,
                                start_new_session=True)
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_process_group(proc)
        out["error"] = "timed out after {:g}s".format(timeout)
        return out
    except OSError as exc:
        out["error"] = "could not be executed: {}".format(exc)
        return out
    if proc.returncode != 0:
        detail = (stderr or "").strip().splitlines()
        out["error"] = "exited {}{}".format(
            proc.returncode, ": " + detail[-1] if detail else "")
        return out

    try:
        payload = json.loads(stdout)
    except ValueError:
        out["error"] = "printed unparseable output (expected one JSON object)"
        return out
    if not isinstance(payload, dict):
        out["error"] = "printed {} — expected a JSON object".format(type(payload).__name__)
        return out

    bad = []
    for field in PROVIDER_PCT_FIELDS:
        if field not in payload or payload[field] is None:
            continue
        if is_pct(payload[field]):
            out[field] = float(payload[field])
        else:
            bad.append("{}={!r} is not a number 0-100".format(field, payload[field]))
    reset = payload.get(PROVIDER_RESET_FIELD)
    if reset is not None:
        parsed = parse_iso_utc(reset) if nonempty_str(reset) else None
        if parsed is None:
            bad.append("{}={!r} is not an ISO-8601 UTC timestamp".format(
                PROVIDER_RESET_FIELD, reset))
        else:
            out[PROVIDER_RESET_FIELD] = parsed

    if all(out[field] is None for field in PROVIDER_PCT_FIELDS):
        out["error"] = "reported no usable percentage" + ("; " + "; ".join(bad) if bad else "")
    elif bad:
        # Partial answers are kept: an adapter that knows the 5h window but not the
        # week must not cost us the number it does know.
        out["partial"] = "; ".join(bad)
    return out


def collect_provider_usage(profile, repo, pools, notes):
    """Run the usage adapter of every pool that declares one. Never raises."""
    collected = {}
    for pool in pools:
        script, conflicts = pool_usage_provider(profile, pool)
        if conflicts:
            notes.append("pool {}: conflicting {} values in the profile; using the "
                         "cheapest rung's".format(pool, USAGE_PROVIDER_KEY))
        if script is None:
            continue
        result = run_usage_provider(script, pool, repo)
        collected[pool] = result
        if result["error"]:
            notes.append(
                "pool {}: usage provider {} FAILED OPEN — {}; pct stays unknown (no "
                "percentage is invented; the #28 quota circuit remains the real "
                "gate)".format(pool, script, result["error"]))
            continue
        notes.append(
            "pool {}: window percentage(s) reported by the usage provider {} — no "
            "token budget needed".format(pool, script))
        if result.get("partial"):
            notes.append("pool {}: usage provider {} — {} (that field falls back to "
                         "the ledger/budget path)".format(pool, script, result["partial"]))
    return collected


# ---------------------------------------------------------------------------
# Windows
# ---------------------------------------------------------------------------
def weekly_window(anchor, now):
    """The current weekly window as (start, next_reset, basis).

    With an anchor, weeks repeat from it, so the window is
    [anchor + k*7d, anchor + (k+1)*7d) containing `now`. Without one there is no
    denominator for a week boundary, so the window is a rolling 7d and the next
    reset is unknown.
    """
    if anchor is None:
        return now - ONE_WEEK, None, "rolling_7d"
    periods = math.floor((now - anchor).total_seconds() / ONE_WEEK.total_seconds())
    start = anchor + periods * ONE_WEEK
    return start, start + ONE_WEEK, "weekly_anchor"


def resolve_pool(provider, backends, pools, resolver):
    """Map a ledger line's backend/provider name onto a profile pool.

    Precedence: the profile's own backend->pool declaration, then the pool name
    itself, then the pricing table's provider aliases (so a ledger written
    before the profile named that backend still lands in the right pool).
    Returns None when the provider cannot be attributed to a profile pool.
    """
    if not nonempty_str(provider):
        return None
    name = provider.strip()
    mapped = backends.get(name.lower())
    if mapped:
        return mapped
    if name in pools:
        return name
    if resolver is not None:
        canonical = resolver(name)
        if canonical and canonical in pools:
            return canonical
    return None


# ---------------------------------------------------------------------------
# The usage state
# ---------------------------------------------------------------------------
def _load_report_resolver():
    """Provider-alias resolver borrowed from report.py, or None if unavailable."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "report.py")
    if not os.path.isfile(path):
        return None
    try:
        import importlib.util
        # Loading report.py by path must not leave a __pycache__ behind in the
        # template dir — that would dirty a target repo working tree.
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location("ralph_report_for_usage", path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        pricing = module._load_pricing()
        return lambda name: module._resolve_provider(name, pricing)
    except Exception:  # a broken report.py must not take the reader down
        return None


def _line_tokens(rec):
    """(tokens, unknown) for one ledger line — the round total, never guessed."""
    tokens = rec.get("tokens")
    if not isinstance(tokens, dict):
        return 0, True
    total = tokens.get("total")
    if is_number(total):
        return int(total), False
    return 0, True


def _agent_provider(rec, role):
    agents = rec.get("agents")
    if not isinstance(agents, dict):
        return None
    agent = agents.get(role)
    if not isinstance(agent, dict):
        return None
    provider = agent.get("provider")
    return provider if nonempty_str(provider) else None


def rung_avoid_state(profile, now):
    """Per-rung avoid-window evaluation against the current UTC day + time."""
    states = []
    for rung in profile_rungs(profile):
        windows = rung.get("avoid_windows")
        windows = windows if isinstance(windows, list) else []
        described = []
        for win in windows:
            if not isinstance(win, dict):
                continue
            described.append({
                "from": win.get("from"),
                "to": win.get("to"),
                "tz": win.get("tz"),
                "days": win.get("days"),
                "reason": win.get("reason"),
                "active": window_active(win, now),
            })
        states.append({
            "rung": rung.get("name"),
            "pools": rung_pools(rung),
            "avoid_windows": described,
            "in_avoid_window": any(w["active"] for w in described),
        })
    return states


def compute_usage_state(profile, repo, now):
    """Normalized per-pool usage records for every pool the profile references.

    Returns {now_utc, ledger, source, pools, rungs, records, notes}. Never
    raises on a malformed ledger, and never writes anything.
    """
    pools = profile_pools(profile)
    backends = backend_pool_map(profile)
    resolver = _load_report_resolver()
    path = ledger_path(repo)
    records, source = read_ledger_records(path)
    notes = []

    if source == SOURCE_NONE:
        notes.append("no ledger at {} — no local usage observations".format(path))
    elif source == SOURCE_UNREADABLE:
        notes.append("ledger {} is not readable — no local usage observations".format(path))

    # Per-pool observations: (timestamp, tokens, tokens_unknown).
    observations = {pool: [] for pool in pools}
    unattributed = {}
    undated = 0
    mixed_rounds = 0
    for rec in records:
        stamp = parse_iso_utc(rec.get("timestamp", ""))
        builder_provider = _agent_provider(rec, "builder")
        reviewer_provider = _agent_provider(rec, "reviewer")
        # A ledger line carries ONE token total for the whole round (builder +
        # reviewer sidecars are summed by round-usage.sh), so there is no honest
        # per-role split. Attribute the round to the builder's pool, exactly as
        # `ralph report` attributes its cost, and count the rounds whose reviewer
        # drew on a different pool so the skew is visible instead of silent.
        pool = resolve_pool(builder_provider, backends, pools, resolver)
        if pool is None:
            if nonempty_str(builder_provider):
                unattributed[builder_provider] = unattributed.get(builder_provider, 0) + 1
            continue
        if stamp is None:
            undated += 1
            continue
        reviewer_pool = resolve_pool(reviewer_provider, backends, pools, resolver)
        if reviewer_pool is not None and reviewer_pool != pool:
            mixed_rounds += 1
        tokens, unknown = _line_tokens(rec)
        observations[pool].append((stamp, tokens, unknown))

    if undated:
        notes.append("{} ledger line(s) have no usable timestamp and were skipped".format(undated))
    if unattributed:
        notes.append("ledger provider(s) not mapped to any profile pool: {}".format(
            ", ".join("{} ({} line(s))".format(name, count)
                      for name, count in sorted(unattributed.items()))))
    if mixed_rounds:
        notes.append(
            "{} round(s) used a different pool for the reviewer than the builder; the "
            "ledger has no per-role token split, so each round is attributed to its "
            "builder's pool".format(mixed_rounds))

    avoid = rung_avoid_state(profile, now)
    pool_in_window = {}
    for state in avoid:
        for pool in state["pools"]:
            pool_in_window[pool] = pool_in_window.get(pool, False) or state["in_avoid_window"]

    reserves = profile.get("reserves") if isinstance(profile, dict) else {}
    reserves = reserves if isinstance(reserves, dict) else {}
    near_hours = reserves.get("near_weekly_reset_hours")

    # #68: the pools whose provider publishes percentages instead of tokens. One
    # adapter invocation per pool, before the per-window loop.
    provider_usage = collect_provider_usage(profile, repo, pools, notes)

    out = []
    for pool in pools:
        anchor, anchor_conflicts = pool_weekly_anchor(profile, pool)
        if anchor_conflicts:
            notes.append("pool {}: conflicting {} values in the profile; using the "
                         "cheapest rung's".format(pool, WEEKLY_ANCHOR_KEY))
        week_start, week_reset, week_basis = weekly_window(anchor, now)
        provider = provider_usage.get(pool) or {}
        # A provider-reported weekly reset is the real one, so it wins over the
        # anchor. The token WINDOW itself is left alone: the ledger sums stay
        # comparable, and for such a pool the percentage no longer comes from them.
        if provider.get(PROVIDER_RESET_FIELD) is not None:
            week_reset, week_basis = provider[PROVIDER_RESET_FIELD], RESET_BASIS_PROVIDER
        for window, start in (("5h", now - FIVE_HOURS), ("weekly", week_start)):
            budget, budget_conflicts = pool_budget(profile, pool, window)
            if budget_conflicts:
                notes.append("pool {}: conflicting {} window budgets in the profile; "
                             "using the cheapest rung's".format(pool, window))
            in_window = [obs for obs in observations.get(pool, [])
                         if start <= obs[0] <= now]
            used = sum(obs[1] for obs in in_window)
            unknown_lines = sum(1 for obs in in_window if obs[2])

            if window == "5h":
                # The 5h window rolls: usage drops when its oldest record ages out.
                if in_window:
                    reset = min(obs[0] for obs in in_window) + FIVE_HOURS
                    reset_basis = "oldest_record_rolloff"
                else:
                    reset = None
                    reset_basis = "no_records_in_window"
            else:
                reset, reset_basis = week_reset, week_basis

            hours = None if reset is None else round((reset - now).total_seconds() / 3600.0, 3)
            # "Near the weekly reset" only means something for the weekly window,
            # and only when the profile anchors it AND sets the threshold.
            if window == "weekly" and reset is not None and is_number(near_hours):
                near = hours <= near_hours
            else:
                near = UNKNOWN

            # The adapter's percentage IS the percentage: it is what the provider
            # reports, so it needs no denominator and beats the local estimate.
            provider_pct = provider.get("window_{}_pct".format(window))
            if provider_pct is not None:
                pct, pct_source = round(float(provider_pct), 1), PCT_SOURCE_PROVIDER
            elif budget is None or source != SOURCE_LEDGER:
                pct, pct_source = UNKNOWN, None
            else:
                pct, pct_source = round(100.0 * used / budget, 1), PCT_SOURCE_BUDGET

            out.append({
                "pool": pool,
                "window": window,
                "used_tokens": used,
                "records": len(in_window),
                "unknown_token_records": unknown_lines,
                "window_start": iso_z(start),
                "budget_tokens": budget,
                "pct": pct,
                "pct_source": pct_source,
                "usage_provider": provider.get("usage_provider"),
                "reset_at": iso_z(reset),
                "reset_in_hours": hours,
                "reset_basis": reset_basis,
                "near_weekly_reset": near,
                "in_avoid_window": bool(pool_in_window.get(pool, False)),
                "source": source,
            })

    if source == SOURCE_LEDGER:
        budgeted = sorted({r["pool"] for r in out if r["budget_tokens"] is not None})
        if budgeted:
            notes.append("per-pool window usage computed locally from the ledger vs the "
                         "profile's token budget for: {}".format(", ".join(budgeted)))
        # A pool whose percentage came from its usage provider needs no budget, so
        # it is not missing anything.
        unbudgeted = sorted({r["pool"] for r in out if r["budget_tokens"] is None
                             and r["pct_source"] != PCT_SOURCE_PROVIDER})
        if unbudgeted:
            notes.append("no window token budget configured for: {} — pct is unknown "
                         "(raw token counts are still reported; add {} / {} to the "
                         "pool's cap block to get a percentage)".format(
                             ", ".join(unbudgeted), BUDGET_5H_KEY, BUDGET_WEEKLY_KEY))

    return {
        "now_utc": iso_z(now),
        "ledger": path if source != SOURCE_NONE else None,
        "source": source,
        "pools": pools,
        "rungs": avoid,
        "records": out,
        "notes": notes,
    }


def shown_flag(value):
    """Render a tri-state (True / False / "unknown") for humans."""
    if value is True:
        return "yes"
    if value is False:
        return "no"
    return UNKNOWN


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
USAGE = "Usage: usage-state.py --repo DIR [--profile PATH] [--json]"


def _load_efficiency_module():
    """Load the sibling efficiency.py for profile loading/validation.

    Lazy and by path (never a module-level import): efficiency.py imports THIS
    module at load time, so importing it back at load time would be circular.
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "efficiency.py")
    if not os.path.isfile(path):
        return None
    try:
        import importlib.util
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location("ralph_efficiency_for_usage", path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:
        return None


def _print_human(state):
    print("usage state (local estimate from the ledger — no provider API was called)")
    print("  now (UTC): {}".format(state["now_utc"]))
    print("  ledger: {}".format(state["ledger"] or "none"))
    for note in state["notes"]:
        print("  note: {}".format(note))
    for rung in state["rungs"]:
        for win in rung["avoid_windows"]:
            print("  rung {}: avoid window {}-{} {} {} ({}) — {}".format(
                rung["rung"], win["from"], win["to"], win["tz"], win["days"], win["reason"],
                "ACTIVE now" if win["active"] else "not active now"))
    if not state["records"]:
        print("  (no pools referenced by the profile)")
        return
    print("")
    for rec in state["records"]:
        pct = rec["pct"]
        pct_text = UNKNOWN if pct == UNKNOWN else "{:.1f}%".format(pct)
        if rec["pct_source"] == PCT_SOURCE_PROVIDER:
            pct_text += " (from the usage provider {})".format(rec["usage_provider"])
        budget = rec["budget_tokens"]
        print("  pool {} [{}]: used {} token(s) over {} record(s); budget {}; pct {}".format(
            rec["pool"], rec["window"], rec["used_tokens"], rec["records"],
            budget if budget is not None else "unset", pct_text))
        print("      reset {} ({}); near_weekly_reset {}; in_avoid_window {}; source {}".format(
            rec["reset_at"], rec["reset_basis"], shown_flag(rec["near_weekly_reset"]),
            shown_flag(rec["in_avoid_window"]), rec["source"]))
        if rec["unknown_token_records"]:
            print("      note: {} record(s) in this window report unknown tokens and "
                  "count as 0".format(rec["unknown_token_records"]))


def main(argv):
    if argv and argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0

    repo = os.getcwd()
    profile_arg = None
    as_json = False
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--json":
            as_json = True
        elif arg in ("--repo", "--profile"):
            if i + 1 >= len(argv):
                print("ralph: {} needs a value".format(arg), file=sys.stderr)
                return 2
            value = argv[i + 1]
            i += 1
            if arg == "--repo":
                repo = value
            else:
                profile_arg = value
        elif arg.startswith("--repo="):
            repo = arg.split("=", 1)[1]
        elif arg.startswith("--profile="):
            profile_arg = arg.split("=", 1)[1]
        else:
            print("ralph: unknown usage-state option {!r}".format(arg), file=sys.stderr)
            print(USAGE, file=sys.stderr)
            return 2
        i += 1

    efficiency = _load_efficiency_module()
    if efficiency is None:
        print("ralph: efficiency.py not found next to usage-state.py — cannot resolve "
              "the pools to report on.", file=sys.stderr)
        return 1

    path = efficiency.resolve_profile_path(profile_arg, repo)
    loaded = efficiency.load_profile(path)
    if loaded["status"] != efficiency.STATUS_VALID:
        # Same safe contract as `ralph explain`: a bad profile is reported and
        # inert, never fatal.
        if loaded["status"] == efficiency.STATUS_REJECTED:
            efficiency.warn_rejected(loaded)
        if as_json:
            json.dump({"status": loaded["status"], "profile_path": loaded["path"],
                       "errors": loaded["errors"], "records": [], "pools": []},
                      sys.stdout, indent=2, sort_keys=True)
            sys.stdout.write("\n")
            return 0
        if loaded["status"] == efficiency.STATUS_NOT_CONFIGURED:
            efficiency.print_not_configured(loaded)
        else:
            print("efficiency profile: {}".format(loaded["path"]))
            print("  status: REJECTED (see the warning above)")
            print(efficiency.INERT_LINE)
        return 0

    state = compute_usage_state(loaded["profile"], repo, now_utc())
    if as_json:
        payload = dict(state)
        payload["status"] = efficiency.STATUS_VALID
        payload["profile_path"] = loaded["path"]
        json.dump(payload, sys.stdout, indent=2, sort_keys=True, default=str)
        sys.stdout.write("\n")
        return 0
    print("efficiency profile: {} (VALID)".format(loaded["path"]))
    _print_human(state)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

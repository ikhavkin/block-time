#!/usr/bin/env python3
"""energy_week.py — put your Linear "Energy Δ" ratings on the week's calendar as a Markdown page.

Reads the week's calendar events from Reclaim (which mirrors Google Calendar) and the Linear issues
of the same week, matches events to issues (Linear URL or identifier in the event, or the calendar
attachment the "＋" button adds to the issue), and writes a Markdown file meant for Obsidian: a
summary table, an hour-by-day grid with ⚡ values, per-day lists and the rated/unrated tasks.

Stdlib only, Python 3.9+. Credentials come from the environment, never from arguments:
  LINEAR_API_KEY   Linear → Settings → Security & access → Personal API keys
  RECLAIM_TOKEN    app.reclaim.ai/settings/developer

Examples
  energy_week.py --team HOME --print                        # current ISO week, to stdout
  energy_week.py --team HOME --week 2026-W37 --out ~/Obsidian/notes/Energy/2026-W37.md
  energy_week.py --team HOME --cycle current                # the team's active Linear cycle → ./<week>.md
  energy_week.py --from-json tools/fixtures/energy_week_sample.json --print   # offline / tests
Environment: LINEAR_TEAM is the default for --team; ENERGY_OUT_DIR is the default output folder (else the
current directory). --tz picks the grid's zone (default: the system zone).
"""
from __future__ import annotations

import argparse
import base64
import http.client
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

LINEAR_GQL = "https://api.linear.app/graphql"
RECLAIM_API = "https://api.app.reclaim.ai/api"
DEFAULT_GROUP = "Energy Δ"
DEFAULT_OUT_DIR = "."   # overridden by $ENERGY_OUT_DIR; a personal vault path is no default for other users

Issue = Dict[str, Any]
Event = Dict[str, Any]


class ToolError(Exception):
    pass


# ---- dates ---------------------------------------------------------------------------------------

def iso_week_range(week: str) -> Tuple[dt.date, dt.date]:
    """'2026-W38' → (Monday, next Monday)."""
    m = re.fullmatch(r"(\d{4})-W(\d{1,2})", week.strip().upper())
    if not m:
        raise ToolError(f"week must look like 2026-W38, got {week!r}")
    try:
        monday = dt.date.fromisocalendar(int(m.group(1)), int(m.group(2)), 1)
    except ValueError as exc:
        raise ToolError(f"{week}: {exc}") from None
    return monday, monday + dt.timedelta(days=7)


def week_label(start: dt.date) -> str:
    y, w, _ = start.isocalendar()
    return f"{y}-W{w:02d}"


def parse_when(value: str, tz: Optional[dt.tzinfo] = None) -> dt.datetime:
    """ISO timestamps from Linear (…Z) and Reclaim (…-07:00 or Z) → aware datetime. A date-only value
    (all-day event) is midnight in `tz` (system zone when None), not UTC, so it stays on its day."""
    v = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        d = dt.datetime.combine(dt.date.fromisoformat(v), dt.time())
        return d.replace(tzinfo=tz) if tz else d.astimezone()
    d = dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d


# ---- energy labels --------------------------------------------------------------------------------

def energy_value(name: str) -> Optional[int]:
    m = re.fullmatch(r"([+-]?)(\d{1,2})", name.strip().replace("−", "-").replace("–", "-"))
    if not m:
        return None
    n = int(m.group(2)) * (-1 if m.group(1) == "-" else 1)
    return n if -10 <= n <= 10 else None


def energy_text(n: Optional[int]) -> str:
    if n is None:
        return ""
    return f"+{n}" if n > 0 else (f"−{abs(n)}" if n < 0 else "0")


def issue_energy(issue: Issue, group: str) -> Optional[int]:
    for label in issue.get("labels", {}).get("nodes", []):
        parent = label.get("parent") or {}
        if parent.get("name") == group:
            return energy_value(label.get("name", ""))
    return None


# ---- fetching --------------------------------------------------------------------------------------

def _http_json(url: str, headers: Dict[str, str], body: Optional[bytes] = None, timeout: int = 30) -> Any:
    req = urllib.request.Request(url, data=body, headers={"User-Agent": "energy-week/1.0", **headers},
                                 method="POST" if body else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise ToolError(f"{urlsplit(url).netloc} rejected the credentials (HTTP 401)") from None
        raise ToolError(f"HTTP {exc.code} from {url}: {exc.read()[:200]!r}") from None
    except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:  # incl. timeouts, IncompleteRead
        raise ToolError(f"network error for {url}: {getattr(exc, 'reason', exc)}") from None
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise ToolError(f"non-JSON response from {url}: {raw[:120]!r}") from None


ISSUES_QUERY = """
query($team:String!, $start:DateTimeOrDuration!, $end:DateTimeOrDuration!, $after:String) {
  issues(first: 100, after: $after, filter: {
    team: { key: { eq: $team } },
    or: [
      { completedAt: { gte: $start, lt: $end } },
      { cycle: { startsAt: { lt: $end }, endsAt: { gt: $start } } }
    ]
  }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier title url estimate completedAt
      state { name type }
      cycle { number startsAt endsAt }
      labels { nodes { name parent { name } } }
      attachments { nodes { url title } }
    }
  }
}
"""

CYCLE_QUERY = """
query($team:String!) {
  teams(filter: { key: { eq: $team } }) { nodes {
    activeCycle { number startsAt endsAt }
    cycles(first: 50) { nodes { number startsAt endsAt } }
  } }
}
"""


def linear_post(query: str, variables: Dict[str, Any], key: str) -> Dict[str, Any]:
    data = _http_json(LINEAR_GQL, {"Authorization": key, "Content-Type": "application/json"},
                      json.dumps({"query": query, "variables": variables}).encode("utf-8"))
    if data.get("errors"):
        raise ToolError("Linear: " + "; ".join(e.get("message", "?") for e in data["errors"]))
    return data["data"]


def _midnight(day: dt.date, tz: Optional[dt.tzinfo]) -> dt.datetime:
    """Local midnight of `day` in the report zone (system zone when tz is None), as an aware datetime."""
    naive = dt.datetime.combine(day, dt.time())
    return naive.replace(tzinfo=tz) if tz else naive.astimezone()


def _utc_iso(d: dt.datetime) -> str:
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_issues(team: str, start: dt.date, end: dt.date, key: str, tz: Optional[dt.tzinfo] = None) -> List[Issue]:
    out: List[Issue] = []
    after = None
    while True:
        d = linear_post(ISSUES_QUERY, {"team": team, "start": _utc_iso(_midnight(start, tz)),
                                       "end": _utc_iso(_midnight(end, tz)), "after": after}, key)
        page = d["issues"]
        out.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            return out
        after = page["pageInfo"]["endCursor"]


def cycle_range(team: str, which: str, key: str) -> Tuple[dt.date, dt.date]:
    if which != "current" and not which.isdigit():
        raise ToolError(f"--cycle must be 'current' or a cycle number, got {which!r}")
    d = linear_post(CYCLE_QUERY, {"team": team}, key)
    nodes = d["teams"]["nodes"]
    if not nodes:
        raise ToolError(f"Linear team {team} not found")
    t = nodes[0]
    if which == "current":
        c = t["activeCycle"]
        if not c:
            raise ToolError("no active cycle")
    else:
        want = int(which)
        c = next((x for x in t["cycles"]["nodes"] if x["number"] == want), None)
        if not c:
            raise ToolError(f"cycle {want} not found")
    return parse_when(c["startsAt"]).date(), parse_when(c["endsAt"]).date()


def fetch_events(start: dt.date, end: dt.date, token: str) -> List[Event]:
    url = f"{RECLAIM_API}/events?start={start.isoformat()}&end={end.isoformat()}&sourceDetails=true"
    data = _http_json(url, {"Authorization": f"Bearer {token}"})
    if not isinstance(data, list):
        raise ToolError("Reclaim returned an unexpected shape for /api/events")
    return data


# ---- matching --------------------------------------------------------------------------------------

def decode_eid(url: str) -> Optional[str]:
    """Google Calendar event link → the event id (first token of the base64 'eid' payload)."""
    m = re.search(r"[?&]eid=([A-Za-z0-9_\-=]+)", url)
    if not m:
        return None
    raw = m.group(1).replace("-", "+").replace("_", "/")
    raw += "=" * (-len(raw) % 4)
    try:
        return base64.b64decode(raw).decode("utf-8").split(" ")[0] or None
    except Exception:
        return None


def match_events(events: Iterable[Event], issues: Iterable[Issue]) -> Dict[str, str]:
    """event key → issue identifier, via description/title identifier, Linear URL, or attachment eid."""
    by_id: Dict[str, Issue] = {i["identifier"].upper(): i for i in issues}
    keys = sorted({i.split("-")[0] for i in by_id}, key=len, reverse=True)
    id_re = re.compile(r"\b((?:" + "|".join(map(re.escape, keys)) + r")-\d+)\b") if keys else None
    url_re = re.compile(r"linear\.app/[^/\s]+/issue/([A-Za-z][A-Za-z0-9]{0,7}-\d+)")
    by_event_id: Dict[str, str] = {}
    for ident, issue in by_id.items():
        for att in issue.get("attachments", {}).get("nodes", []):
            eid = decode_eid(att.get("url", "") or "")
            if eid:
                by_event_id[eid] = ident
    out: Dict[str, str] = {}
    for ev in events:
        text = f"{ev.get('title', '')}\n{ev.get('description', '') or ''}"
        ident = None
        m = url_re.search(text)
        if m:
            ident = m.group(1).upper()
        elif id_re:
            m2 = id_re.search(text)
            if m2:
                ident = m2.group(1).upper()
        if not ident:
            ident = by_event_id.get(str(ev.get("eventId", "")))
        if ident and ident in by_id:
            out[str(ev.get("key") or ev.get("eventId"))] = ident
    return out


# ---- rendering -------------------------------------------------------------------------------------

def _local(d: dt.datetime, tz: Optional[dt.tzinfo]) -> dt.datetime:
    return d.astimezone(tz)  # tz=None → the system zone, resolved per instant (DST-correct)


def _short(text: str, n: int) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    text = text if len(text) <= n else text[: n - 1] + "…"
    return text.replace("|", "\\|")  # escape after truncating so a cut never leaves a bare backslash


def _all_day(s: dt.datetime, e: dt.datetime) -> bool:
    return s.time() == dt.time() and e.time() == dt.time() and e.date() > s.date()


def _rows(s: dt.datetime, e: dt.datetime) -> range:
    """Grid rows (hours of the start day) an event occupies; ends on a later day are clamped to 24:00."""
    end_h = (e.hour + (1 if e.minute or e.second else 0)) if e.date() == s.date() else 24
    return range(s.hour, min(max(end_h, s.hour + 1), 24))


def render(start: dt.date, end: dt.date, events: List[Event], issues: List[Issue], matches: Dict[str, str],
           group: str, tz: Optional[dt.tzinfo], generated: Optional[dt.datetime] = None) -> str:
    by_id = {i["identifier"].upper(): i for i in issues}
    days = [start + dt.timedelta(days=n) for n in range((end - start).days)]
    per_day: Dict[dt.date, List[Tuple[dt.datetime, dt.datetime, Event, Optional[str]]]] = defaultdict(list)
    for ev in events:
        if not ev.get("eventStart") or not ev.get("eventEnd"):
            continue
        s, e = _local(parse_when(ev["eventStart"], tz), tz), _local(parse_when(ev["eventEnd"], tz), tz)
        if s.date() < start or s.date() >= end:
            continue
        per_day[s.date()].append((s, e, ev, matches.get(str(ev.get("key") or ev.get("eventId")))))
    for lst in per_day.values():
        lst.sort(key=lambda x: x[0])

    def energy_of(ident: Optional[str]) -> Optional[int]:
        return issue_energy(by_id[ident], group) if ident and ident in by_id else None

    lines: List[str] = []
    gen = (generated or dt.datetime.now().astimezone(tz)).strftime("%Y-%m-%d %H:%M")
    label = week_label(start)
    lines += ["---", f"week: {label}", f"range: {start.isoformat()}/{(end - dt.timedelta(days=1)).isoformat()}",
              f"generated: {gen}", f"energy_group: {group}", "tags: [energy, weekly]", "---", "",
              f"# Energy week {label} ({start:%b %-d} – {end - dt.timedelta(days=1):%b %-d, %Y})", ""]

    # summary
    lines += ["## Summary", "", "| Day | Blocks | Task blocks | Rated | Avg Δ | Sum Δ |", "|---|---:|---:|---:|---:|---:|"]
    total_rated: List[int] = []
    for day in days:
        items = per_day.get(day, [])
        tasks = [x for x in items if x[3]]
        rated = [energy_of(x[3]) for x in tasks]
        rated = [r for r in rated if r is not None]
        total_rated += rated
        avg = f"{sum(rated) / len(rated):+.1f}" if rated else "–"
        s = f"{sum(rated):+d}" if rated else "–"
        lines.append(f"| {day:%a %-d} | {len(items)} | {len(tasks)} | {len(rated)} | {avg} | {s} |")
    avg_all = f"{sum(total_rated) / len(total_rated):+.1f}" if total_rated else "–"
    lines += [f"| **Week** | {sum(len(v) for v in per_day.values())} | {sum(1 for v in per_day.values() for x in v if x[3])} | "
              f"{len(total_rated)} | {avg_all} | {(f'{sum(total_rated):+d}' if total_rated else '–')} |", ""]

    # grid
    hours_present = [h for v in per_day.values() for s, e, _, _ in v if not _all_day(s, e) for h in (s.hour, _rows(s, e)[-1])]
    first = min([7] + hours_present) if hours_present else 7
    last = max([21] + hours_present) if hours_present else 21
    lines += ["## Calendar", "", "| | " + " | ".join(f"{d:%a %-d}" for d in days) + " |", "|---|" + "---|" * len(days)]
    for h in range(first, last + 1):
        cells = []
        for day in days:
            parts = []
            for s, e, ev, ident in per_day.get(day, []):
                if not _all_day(s, e) and h in _rows(s, e):
                    if ident:
                        en = energy_of(ident)
                        parts.append(f"**{ident}**" + (f" ⚡{energy_text(en)}" if en is not None else " ⚡·"))
                    else:
                        parts.append(_short(str(ev.get("title", "")), 16))
            cells.append("<br>".join(dict.fromkeys(parts)))
        lines.append(f"| {h:02d}:00 | " + " | ".join(cells) + " |")
    lines.append("")

    # days
    lines += ["## Days", ""]
    for day in days:
        lines.append(f"### {day:%A, %b %-d}")
        items = per_day.get(day, [])
        if not items:
            lines.append("- (no events)")
        for s, e, ev, ident in items:
            span = "all day" if _all_day(s, e) else f"{s:%H:%M}–{e:%H:%M}"
            if ident and ident in by_id:
                iss = by_id[ident]
                en = energy_of(ident)
                est = f" ({iss['estimate']})" if iss.get("estimate") else ""
                mark = f" ⚡{energy_text(en)}" if en is not None else " ⚡ unrated"
                lines.append(f"- {span} **[{ident}]({iss['url']})** {iss['title']}{est}{mark}")
            else:
                lines.append(f"- {span} {ev.get('title', '')}")
        lines.append("")

    # tasks
    rated_issues = [(i, issue_energy(i, group)) for i in issues]
    done = [i for i in issues if (i.get("state") or {}).get("type") == "completed"]
    unrated = [i for i in done if issue_energy(i, group) is None]
    lines += ["## Rated tasks", ""]
    any_rated = False
    for i, en in sorted(rated_issues, key=lambda x: (x[1] is None, -(x[1] or 0))):
        if en is None:
            continue
        any_rated = True
        lines.append(f"- ⚡{energy_text(en)} **[{i['identifier']}]({i['url']})** {i['title']}")
    if not any_rated:
        lines.append("- none yet")
    lines += ["", "## Completed but unrated", ""]
    for i in unrated:
        lines.append(f"- [{i['identifier']}]({i['url']}) {i['title']} — add a label from *{group}*")
    if not unrated:
        lines.append("- none")
    lines.append("")
    return "\n".join(lines)


# ---- main ------------------------------------------------------------------------------------------

def main(argv: Optional[List[str]] = None) -> int:
    out_dir = os.environ.get("ENERGY_OUT_DIR") or DEFAULT_OUT_DIR
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split("Examples")[1] if "Examples" in __doc__ else None)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--week", help="ISO week like 2026-W38 (default: the current week)")
    g.add_argument("--cycle", help="Linear cycle: 'current' or a number; the cycle's dates become the range")
    ap.add_argument("--team", default=os.environ.get("LINEAR_TEAM"), help="Linear team key, e.g. HOME (or env LINEAR_TEAM)")
    ap.add_argument("--group", default=DEFAULT_GROUP, help=f"label group with the energy values (default '{DEFAULT_GROUP}')")
    ap.add_argument("--out", help=f"output file (default {out_dir}/<week>.md; ENERGY_OUT_DIR changes the folder)")
    ap.add_argument("--print", action="store_true", help="write to stdout instead of a file")
    ap.add_argument("--from-json", metavar="FILE", help="use {issues:[…], events:[…]} from FILE instead of the APIs")
    ap.add_argument("--dump-json", metavar="FILE", help="save the fetched issues and events to FILE")
    ap.add_argument("--tz", help="IANA time zone for the grid (default: the system zone)")
    args = ap.parse_args(argv)

    if args.tz:
        try:
            from zoneinfo import ZoneInfo
            tz: Optional[dt.tzinfo] = ZoneInfo(args.tz)
        except Exception:
            print(f"unknown time zone {args.tz}", file=sys.stderr)
            return 2
    else:
        tz = None  # system zone; astimezone(None) resolves the offset per instant, so DST is right for any week

    try:
        if args.from_json:
            data = json.loads(Path(args.from_json).read_text(encoding="utf-8"))
            issues, events = data["issues"], data["events"]
            if args.cycle:
                raise ToolError("--cycle needs the Linear API; use --week with --from-json")
            if args.week:
                start, end = iso_week_range(args.week)
            elif data.get("range"):
                start, end = dt.date.fromisoformat(data["range"][0]), dt.date.fromisoformat(data["range"][1])
            else:
                start, end = iso_week_range(week_label(dt.date.today()))
        else:
            key = os.environ.get("LINEAR_API_KEY")
            token = os.environ.get("RECLAIM_TOKEN")
            if not key or not token:
                raise ToolError("set LINEAR_API_KEY and RECLAIM_TOKEN in the environment (or use --from-json)")
            if not args.team:
                raise ToolError("pass --team or set LINEAR_TEAM (the Linear team key, e.g. HOME)")
            if args.cycle:
                start, end = cycle_range(args.team, args.cycle, key)
            else:
                start, end = iso_week_range(args.week or week_label(dt.date.today()))
            issues = fetch_issues(args.team, start, end, key, tz)
            events = fetch_events(start, end, token)
            if args.dump_json:
                Path(args.dump_json).write_text(json.dumps({"range": [start.isoformat(), end.isoformat()],
                                                            "issues": issues, "events": events}, indent=2), encoding="utf-8")
        matches = match_events(events, issues)
        md = render(start, end, events, issues, matches, args.group, tz)
    except ToolError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.print:
        sys.stdout.write(md)
        return 0
    out = Path(args.out).expanduser() if args.out else Path(out_dir).expanduser() / f"{week_label(start)}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md, encoding="utf-8")
    print(f"wrote {out} ({len(events)} events, {len(matches)} matched to {len(issues)} issues)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

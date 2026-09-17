import base64
import datetime as dt
import io
import json
import os
import re
import socket
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))
import energy_week as ew  # noqa: E402

FIX = Path(__file__).parent / "fixtures" / "energy_week_sample.json"
LA = ZoneInfo("America/Los_Angeles")


def load():
    d = json.loads(FIX.read_text(encoding="utf-8"))
    return d["issues"], d["events"], dt.date.fromisoformat(d["range"][0]), dt.date.fromisoformat(d["range"][1])


class Dates(unittest.TestCase):
    def test_iso_week(self):
        self.assertEqual(ew.iso_week_range("2026-W38"), (dt.date(2026, 9, 14), dt.date(2026, 9, 21)))
        self.assertEqual(ew.iso_week_range("2026-w1"), (dt.date(2025, 12, 29), dt.date(2026, 1, 5)))
        with self.assertRaises(ew.ToolError):
            ew.iso_week_range("2026-09-14")
        self.assertEqual(ew.week_label(dt.date(2026, 9, 16)), "2026-W38")

    def test_parse_when(self):
        z = ew.parse_when("2026-09-16T18:30:00.000Z")
        self.assertEqual(z.astimezone(LA).hour, 11)
        off = ew.parse_when("2026-09-16T11:30:00-07:00")
        self.assertEqual(off, z)


class Energy(unittest.TestCase):
    def test_values(self):
        self.assertEqual(ew.energy_value("-5"), -5)
        self.assertEqual(ew.energy_value("+2"), 2)
        self.assertEqual(ew.energy_value("−3"), -3)
        self.assertEqual(ew.energy_value("0"), 0)
        self.assertIsNone(ew.energy_value("Energy Δ"))
        self.assertIsNone(ew.energy_value("+42"))
        self.assertEqual(ew.energy_text(2), "+2")
        self.assertEqual(ew.energy_text(-3), "−3")
        self.assertEqual(ew.energy_text(0), "0")
        self.assertEqual(ew.energy_text(None), "")

    def test_issue_energy_only_from_group(self):
        issues, _, _, _ = load()
        by = {i["identifier"]: i for i in issues}
        self.assertEqual(ew.issue_energy(by["HOME-24"], "Energy Δ"), -2)
        self.assertEqual(ew.issue_energy(by["HOME-21"], "Energy Δ"), 1)
        self.assertIsNone(ew.issue_energy(by["HOME-25"], "Energy Δ"))
        self.assertIsNone(ew.issue_energy(by["HOME-24"], "Mood"))


class Matching(unittest.TestCase):
    def test_decode_eid(self):
        eid = base64.urlsafe_b64encode(b"abc123 someone@example.com").decode().rstrip("=")
        self.assertEqual(ew.decode_eid(f"https://www.google.com/calendar/event?eid={eid}"), "abc123")
        self.assertIsNone(ew.decode_eid("https://linear.app/x/issue/HOME-1"))
        self.assertIsNone(ew.decode_eid("https://www.google.com/calendar/event?eid=%%%"))

    def test_match_paths(self):
        issues, events, _, _ = load()
        m = ew.match_events(events, issues)
        self.assertEqual(m["1000001/evResume"], "HOME-24")   # Markdown URL in description
        self.assertEqual(m["1000001/evDani"], "HOME-25")     # plain URL
        self.assertEqual(m["1000001/evMich"], "HOME-21")     # identifier in title
        self.assertEqual(m["1000001/evPickup"], "HOME-26")   # calendar attachment eid on the issue
        self.assertNotIn("1000001/evQuarter", m)             # Q3-2026 is not a HOME identifier
        self.assertNotIn("1000001/r1_20260916T153000Z", m)

    def test_match_without_issues(self):
        self.assertEqual(ew.match_events([{"key": "k", "title": "HOME-1 x"}], []), {})


class Rendering(unittest.TestCase):
    def test_render(self):
        issues, events, start, end = load()
        md = ew.render(start, end, events, issues, ew.match_events(events, issues), "Energy Δ", LA,
                       generated=dt.datetime(2026, 9, 20, 12, 0, tzinfo=LA))
        self.assertIn("week: 2026-W38", md)
        self.assertIn("# Energy week 2026-W38 (Sep 14 – Sep 20, 2026)", md)
        # summary: Wed has HOME-24 (-2), HOME-25 (unrated), HOME-26 (+3), Get up; Fri has HOME-21 (+1)
        self.assertIn("| Wed 16 | 4 | 3 | 2 | +0.5 | +1 |", md)
        self.assertIn("| Fri 18 | 1 | 1 | 1 | +1.0 | +1 |", md)
        self.assertIn("| **Week** | 6 | 4 | 3 | +0.7 | +2 |", md)
        # grid: 11:00 row on Wednesday shows HOME-24 with -2; 13:00 shows both HOME-25 (unrated) and HOME-26 (+3)
        row11 = next(l for l in md.splitlines() if l.startswith("| 11:00 |"))
        self.assertIn("**HOME-24** ⚡−2", row11)
        row13 = next(l for l in md.splitlines() if l.startswith("| 13:00 |"))
        self.assertIn("**HOME-25** ⚡·", row13)
        self.assertIn("**HOME-26** ⚡+3", row13)
        # the event outside the week and the grid range is ignored
        self.assertNotIn("Outside the week", md)
        # day list and tasks sections
        self.assertIn("- 11:30–13:00 **[HOME-24](https://linear.app/acme/issue/HOME-24/update-resume)** Update resume (3) ⚡−2", md)
        self.assertIn("- 13:00–13:30 **[HOME-25]", md)
        self.assertIn("⚡ unrated", md)
        self.assertIn("## Completed but unrated", md)
        self.assertIn("- [HOME-25](https://linear.app/acme/issue/HOME-25/connect) Reply to recruiter — add a label from *Energy Δ*", md)
        self.assertIn("- ⚡+3 **[HOME-26]", md)
        # grid hours: earliest event 08:30 on Wed → first row 07:00 by default, last 21:00
        self.assertIn("| 07:00 |", md)
        self.assertIn("| 21:00 |", md)
        self.assertNotIn("| 22:00 |", md)

    def test_empty_week(self):
        md = ew.render(dt.date(2026, 9, 21), dt.date(2026, 9, 28), [], [], {}, "Energy Δ", LA,
                       generated=dt.datetime(2026, 9, 21, tzinfo=LA))
        self.assertIn("| **Week** | 0 | 0 | 0 | – | – |", md)
        self.assertIn("- (no events)", md)
        self.assertIn("- none yet", md)


class Cli(unittest.TestCase):
    def test_from_json_print(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = ew.main(["--from-json", str(FIX), "--print", "--tz", "America/Los_Angeles"])
        self.assertEqual(rc, 0)
        self.assertIn("# Energy week 2026-W38", buf.getvalue())

    def test_cycle_needs_api(self):
        with redirect_stdout(io.StringIO()):
            rc = ew.main(["--from-json", str(FIX), "--cycle", "current", "--print"])
        self.assertEqual(rc, 1)

    def test_missing_credentials(self):
        import os
        old = {k: os.environ.pop(k, None) for k in ("LINEAR_API_KEY", "RECLAIM_TOKEN")}
        try:
            with redirect_stdout(io.StringIO()):
                rc = ew.main(["--week", "2026-W38", "--print"])
            self.assertEqual(rc, 1)
        finally:
            for k, v in old.items():
                if v is not None:
                    os.environ[k] = v


# ---- helpers for the review-fix tests ------------------------------------------------------------

START, END = dt.date(2026, 9, 14), dt.date(2026, 9, 21)
GEN = dt.datetime(2026, 9, 20, 12, 0, tzinfo=LA)


def _event(key, title, start, end, description=""):
    return {"key": key, "eventId": key.split("/")[-1], "title": title, "eventStart": start, "eventEnd": end,
            "description": description}


def _grid_rows(md):
    return [l for l in md.splitlines() if l.startswith("| ") and l[2:4].isdigit()]


@contextmanager
def _env(**changes):
    """Temporarily set (str) or unset (None) environment variables."""
    old = {k: os.environ.get(k) for k in changes}
    for k, v in changes.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@contextmanager
def _system_zone(name):
    """Run with the process zone set to `name`: what tz=None (no --tz) resolves against."""
    if not hasattr(time, "tzset"):
        raise unittest.SkipTest("time.tzset is POSIX only")
    try:
        with _env(TZ=name):
            time.tzset()
            yield
    finally:
        time.tzset()


class SystemZone(unittest.TestCase):
    """tz=None must follow the system zone per instant, not the UTC offset in force when the tool runs."""

    def test_local_resolves_dst_per_instant(self):
        with _system_zone("America/Los_Angeles"):
            self.assertEqual(ew._local(ew.parse_when("2026-11-02T17:00:00Z"), None).hour, 9)   # PST
            self.assertEqual(ew._local(ew.parse_when("2026-07-06T16:00:00Z"), None).hour, 9)   # PDT
            self.assertEqual(ew._midnight(dt.date(2026, 11, 2), None).utcoffset(), dt.timedelta(hours=-8))
            self.assertEqual(ew._midnight(dt.date(2026, 7, 6), None).utcoffset(), dt.timedelta(hours=-7))

    def test_main_without_tz_keeps_the_local_hour_across_dst(self):
        tmp = Path(tempfile.mkdtemp())
        weeks = {"nov": ("2026-11-02", "2026-11-09", "2026-11-02T09:00:00-08:00", "2026-11-02T10:00:00-08:00"),
                 "jul": ("2026-07-06", "2026-07-13", "2026-07-06T09:00:00-07:00", "2026-07-06T10:00:00-07:00")}
        with _system_zone("America/Los_Angeles"):
            # whichever DST state the test runs in, one of the two weeks is on the other side of the change
            for name, (a, b, s, e) in weeks.items():
                p = tmp / f"{name}.json"
                p.write_text(json.dumps({"range": [a, b], "issues": [], "events": [_event("c/x", "Block " + name, s, e)]}),
                             encoding="utf-8")
                buf = io.StringIO()
                with redirect_stdout(buf):
                    rc = ew.main(["--from-json", str(p), "--print"])
                self.assertEqual(rc, 0)
                md = buf.getvalue()
                self.assertIn("Block " + name, next(l for l in md.splitlines() if l.startswith("| 09:00 |")), name)
                self.assertIn(f"- 09:00–10:00 Block {name}", md)
            # the September fixture renders the same with and without --tz (bar the generation time)
            outs = []
            for extra in ([], ["--tz", "America/Los_Angeles"]):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    self.assertEqual(ew.main(["--from-json", str(FIX), "--print", *extra]), 0)
                outs.append("\n".join(l for l in buf.getvalue().splitlines() if not l.startswith("generated:")))
            self.assertEqual(outs[0], outs[1])


class GridHours(unittest.TestCase):
    def _md(self, *events):
        return ew.render(START, END, list(events), [], {}, "Energy Δ", LA, generated=GEN)

    def test_rows(self):
        def rows(s, e):
            return list(ew._rows(ew._local(ew.parse_when(s), LA), ew._local(ew.parse_when(e), LA)))
        self.assertEqual(rows("2026-09-16T22:00:00-07:00", "2026-09-17T00:00:00-07:00"), [22, 23])
        self.assertEqual(rows("2026-09-16T23:30:00-07:00", "2026-09-17T00:30:00-07:00"), [23])
        self.assertEqual(rows("2026-09-16T20:00:00-07:00", "2026-09-17T02:00:00-07:00"), [20, 21, 22, 23])
        self.assertEqual(rows("2026-09-16T09:00:00-07:00", "2026-09-17T12:00:00-07:00"), list(range(9, 24)))
        self.assertEqual(rows("2026-09-16T11:30:00-07:00", "2026-09-16T13:00:00-07:00"), [11, 12])
        self.assertEqual(rows("2026-09-16T13:00:00-07:00", "2026-09-16T13:30:00-07:00"), [13])
        self.assertEqual(rows("2026-09-16T13:00:00-07:00", "2026-09-16T13:00:00-07:00"), [13])

    def test_event_ending_at_midnight(self):
        rows = _grid_rows(self._md(_event("c/a", "Late block", "2026-09-16T22:00:00-07:00", "2026-09-17T00:00:00-07:00")))
        self.assertEqual(rows[0][:8], "| 07:00 ")          # a midnight end must not pull the grid to 00:00
        self.assertEqual([r[:8] for r in rows if "Late block" in r], ["| 22:00 ", "| 23:00 "])

    def test_event_ending_past_midnight(self):
        rows = _grid_rows(self._md(_event("c/b", "Long night", "2026-09-16T20:00:00-07:00", "2026-09-17T02:00:00-07:00")))
        self.assertEqual(rows[0][:8], "| 07:00 ")
        self.assertEqual([r[:8] for r in rows if "Long night" in r], ["| 20:00 ", "| 21:00 ", "| 22:00 ", "| 23:00 "])

    def test_all_day_event(self):
        md = self._md(_event("c/c", "Holiday", "2026-09-16T00:00:00-07:00", "2026-09-17T00:00:00-07:00"))
        rows = _grid_rows(md)
        self.assertEqual(rows[0][:8], "| 07:00 ")
        self.assertFalse(any("Holiday" in r for r in rows))     # in no hour row
        self.assertIn("- all day Holiday", md)
        self.assertIn("| Wed 16 | 1 | 0 | 0 | – | – |", md)     # still counted as a block

    def test_real_midnight_event_expands_grid(self):
        rows = _grid_rows(self._md(_event("c/d", "Night shift", "2026-09-16T00:00:00-07:00", "2026-09-16T01:00:00-07:00")))
        self.assertEqual(rows[0][:8], "| 00:00 ")
        self.assertIn("Night shift", rows[0])

    def test_pipe_in_title_keeps_the_column_count(self):
        md = self._md(_event("c/p", "Review A | B", "2026-09-16T10:00:00-07:00", "2026-09-16T11:00:00-07:00"))
        lines = md.splitlines()
        header = next(l for l in lines if l.startswith("| | Mon"))
        row = next(l for l in lines if l.startswith("| 10:00 |"))
        self.assertIn("Review A \\| B", row)
        self.assertEqual(row.replace("\\|", "").count("|"), header.count("|"))
        self.assertEqual(ew._short("Fourteen char |x", 16), "Fourteen char \\|x")
        self.assertEqual(ew._short("abcdefghijklmn|pqr", 16), "abcdefghijklmn\\|…")   # escaped after truncating
        self.assertEqual(ew._short("abcdefghijklmno|pq", 16), "abcdefghijklmno…")


class LinearWindow(unittest.TestCase):
    def _bounds(self, tz):
        captured = {}
        orig = ew.linear_post

        def fake(query, variables, key):
            captured.update(variables)
            return {"issues": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []}}
        ew.linear_post = fake
        try:
            ew.fetch_issues("HOME", START, END, "k", tz)
        finally:
            ew.linear_post = orig
        return captured["start"], captured["end"]

    def test_window_is_local_midnight_sent_as_utc(self):
        start, end = self._bounds(LA)
        self.assertEqual((start, end), ("2026-09-14T07:00:00Z", "2026-09-21T07:00:00Z"))
        lo, hi = ew.parse_when(start), ew.parse_when(end)
        self.assertTrue(lo <= ew.parse_when("2026-09-21T03:00:00Z") < hi)     # Sun 20 Sep 20:00 PDT: this week
        self.assertFalse(lo <= ew.parse_when("2026-09-14T03:00:00Z") < hi)    # Sun 13 Sep 20:00 PDT: last week

    def test_default_zone_is_the_system_zone(self):
        with _system_zone("America/Los_Angeles"):
            self.assertEqual(self._bounds(None), ("2026-09-14T07:00:00Z", "2026-09-21T07:00:00Z"))
        with _system_zone("UTC"):
            self.assertEqual(self._bounds(None), ("2026-09-14T00:00:00Z", "2026-09-21T00:00:00Z"))


class Robustness(unittest.TestCase):
    def _http(self, fake):
        orig = urllib.request.urlopen
        urllib.request.urlopen = fake
        try:
            return ew._http_json("https://api.app.reclaim.ai/api/events", {})
        finally:
            urllib.request.urlopen = orig

    def test_401_names_the_host(self):
        def fake(req, timeout=None):
            raise urllib.error.HTTPError("u", 401, "err", {}, io.BytesIO(b""))
        with self.assertRaises(ew.ToolError) as cm:
            self._http(fake)
        self.assertIn("api.app.reclaim.ai rejected the credentials", str(cm.exception))

    def test_read_timeout_is_a_tool_error(self):
        def fake(req, timeout=None):
            raise socket.timeout("timed out")
        with self.assertRaises(ew.ToolError) as cm:
            self._http(fake)
        self.assertIn("timed out", str(cm.exception))

    def test_non_json_body_is_a_tool_error(self):
        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b"<html>gateway</html>"
        with self.assertRaises(ew.ToolError) as cm:
            self._http(lambda req, timeout=None: Resp())
        self.assertIn("non-JSON response", str(cm.exception))

    def test_invalid_week_number(self):
        with self.assertRaises(ew.ToolError):
            ew.iso_week_range("2025-W53")           # 2025 has 52 ISO weeks
        with self.assertRaises(ew.ToolError):
            ew.iso_week_range("2026-W0")
        self.assertEqual(ew.iso_week_range("2026-W53")[0], dt.date(2026, 12, 28))   # 2026 does have 53
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            rc = ew.main(["--from-json", str(FIX), "--week", "2025-W53", "--print"])
        self.assertEqual(rc, 1)
        self.assertIn("2025-W53", err.getvalue())

    def test_non_numeric_cycle_is_rejected_before_any_request(self):
        orig = ew.linear_post

        def never(*args):
            raise AssertionError("linear_post must not be called")
        ew.linear_post = never
        try:
            for bad in ("abc", "3.0", "-1", ""):
                with self.assertRaises(ew.ToolError):
                    ew.cycle_range("HOME", bad, "k")
        finally:
            ew.linear_post = orig


class Defaults(unittest.TestCase):
    def test_team_is_required_on_the_api_path(self):
        with _env(LINEAR_API_KEY="x", RECLAIM_TOKEN="y", LINEAR_TEAM=None):
            err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(err):
                rc = ew.main(["--week", "2026-W38", "--print"])
            self.assertEqual(rc, 1)
            self.assertIn("--team", err.getvalue())
        orig = ew.fetch_issues

        def reached(team, *args, **kwargs):
            raise ew.ToolError(f"reached the API for {team}")
        ew.fetch_issues = reached
        try:
            with _env(LINEAR_API_KEY="x", RECLAIM_TOKEN="y", LINEAR_TEAM="HOME"):
                err = io.StringIO()
                with redirect_stdout(io.StringIO()), redirect_stderr(err):
                    rc = ew.main(["--week", "2026-W38", "--print"])
                self.assertEqual(rc, 1)
                self.assertIn("reached the API for HOME", err.getvalue())
        finally:
            ew.fetch_issues = orig
        with _env(LINEAR_TEAM=None), redirect_stdout(io.StringIO()):    # --from-json never needs a team
            self.assertEqual(ew.main(["--from-json", str(FIX), "--print", "--tz", "America/Los_Angeles"]), 0)

    def test_output_folder_from_env(self):
        d = tempfile.mkdtemp()
        with _env(ENERGY_OUT_DIR=d), redirect_stdout(io.StringIO()):
            self.assertEqual(ew.main(["--from-json", str(FIX), "--tz", "America/Los_Angeles"]), 0)
        self.assertTrue((Path(d) / "2026-W38.md").is_file())

    def test_fixture_carries_no_real_address(self):
        d = json.loads(FIX.read_text(encoding="utf-8"))
        urls = [att["url"] for i in d["issues"] for att in i["attachments"]["nodes"]]
        self.assertTrue(urls)
        for url in urls:
            m = re.search(r"[?&]eid=([A-Za-z0-9_\-=]+)", url)
            raw = m.group(1) + "=" * (-len(m.group(1)) % 4)
            payload = base64.urlsafe_b64decode(raw).decode("utf-8")
            self.assertTrue(payload.endswith(" someone@example.com"), payload)


class AllDayInputs(unittest.TestCase):
    def test_date_only_is_local_midnight(self):
        d = ew.parse_when("2026-09-16", LA)
        self.assertEqual((d.year, d.month, d.day, d.hour), (2026, 9, 16, 0))
        self.assertEqual(d.tzinfo, LA)
        self.assertEqual(ew.parse_when("2026-09-16T18:30:00Z").astimezone(LA).day, 16)

    def test_date_only_event_renders_as_all_day_on_its_day(self):
        ev = [{"key": "k1", "eventId": "k1", "title": "Conference", "eventStart": "2026-09-16", "eventEnd": "2026-09-17", "description": ""}]
        md = ew.render(dt.date(2026, 9, 14), dt.date(2026, 9, 21), ev, [], {}, "Energy Δ", LA,
                       generated=dt.datetime(2026, 9, 20, tzinfo=LA))
        self.assertIn("### Wednesday, Sep 16", md)
        wed = md.split("### Wednesday, Sep 16")[1].split("###")[0]
        self.assertIn("Conference", wed)
        tue = md.split("### Tuesday, Sep 15")[1].split("###")[0]
        self.assertNotIn("Conference", tue)

    def test_http_exception_is_tool_error(self):
        import http.client
        from unittest import mock
        with mock.patch("urllib.request.urlopen", side_effect=http.client.IncompleteRead(b"x")):
            with self.assertRaises(ew.ToolError):
                ew._http_json("https://example.invalid/api", {})


if __name__ == "__main__":
    unittest.main()

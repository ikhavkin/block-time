# Task → Google Calendar block

One click from a task to a calendar block. Two userscripts (also packaged as one Chrome extension)
open a Google Calendar "new event" page prefilled with the task's title, a link back to it and a
duration, so a scheduler like Reclaim picks the event up like any other. Pick the slot, press Save.

| Where | What you get |
|---|---|
| **Linear** issue page | "📅 Block time" next to the *Activity* heading, or **Option+B**. Title `HOME-24 Update resume`, Linear URL in the description, duration from the T-shirt estimate (XS 30m, S 1h, M 2h, L 4h, XL 8h). |
| **Reclaim** Planner, task rows | "📅 Block" (or "📅" in icon views) after *Mark Done / Start Task* for Linear, Google Tasks, Todoist and Reclaim tasks. Duration from the row's `4h` / `30m` when shown. |
| **Reclaim** Planner, calendar events | "↗" on events that belong to a task, opening the Linear issue, Google Task or Todoist task. Resolved from an ID in the title or from the event description through Reclaim's own API. |
| **Reclaim** Planner, other events | "＋" on hover: link an existing Linear issue (`26`, `home-26`, or a pasted URL) or create one titled like the event. The calendar link is attached to the issue; the issue lands in the active cycle when the block is inside it. |
| **Reclaim** Planner, Linear-linked events | "⚡" badge showing the issue's energy label (a Linear label group such as *Energy Δ* with −5 … +5). Click it to pick a value from the calendar; the group's labels are mutually exclusive, so one value per issue. Read only when a Linear key is already stored. |

## Install

**Userscript (Tampermonkey, Violentmonkey, Greasemonkey)** — open the link, the manager offers to install; updates come from the same URL.

- Linear: [linear-block-time.user.js](https://raw.githubusercontent.com/ikhavkin/block-time/main/dist/linear-block-time.user.js)
- Reclaim: [reclaim-block-time.user.js](https://raw.githubusercontent.com/ikhavkin/block-time/main/dist/reclaim-block-time.user.js)

Copies installed from Greasy Fork update only from Greasy Fork, because it strips `@updateURL` / `@downloadURL`.

Chrome 138+ blocks userscript managers until you enable **Allow User Scripts** on the manager's card in
`chrome://extensions` (Details), then reload the Linear / Reclaim tab. Tampermonkey shows the same hint on its dashboard.

**Chrome extension (no manager)** — `chrome://extensions` → Developer mode → *Load unpacked* → the
`linear-block-ext/` folder. Content scripts always run. After reloading the extension, reload the
open Linear / Reclaim tabs too: an orphaned tab keeps working on default settings and cannot save.

If a userscript and the extension are both installed, the first copy to run owns the page (and its
settings store); the other one stays idle, so nothing is doubled.

**Bookmarklet** (Linear only, no extension, works on iPhone Safari) — `dist/linear-block-time.bookmarklet.js`, one line to paste as a bookmark URL.

## Settings

Everything is detected from the page: the Linear workspace slug and team keys from the Linear issue
links Reclaim shows. Override them, choose a project for created issues, or change the durations via
the script manager's menu ("Task → Calendar block: settings…") or **Shift+click** any of the buttons.
Team keys are comma- or space-separated; the slug accepts a pasted linear.app URL. Saving settings on
the Reclaim page resolves the event links again.
The Linear personal API key (only needed for "＋") is asked once and kept in the script manager's
or extension's private storage; Shift+click "＋" (or the menu) forgets it. The bare bookmarklet has no
key and no "＋".

## Weekly energy report (`tools/energy_week.py`)

Puts the week's ⚡ ratings on the calendar as a Markdown page for Obsidian: a summary table
(blocks, rated tasks, average and sum per day), an hour-by-day grid with `HOME-24 ⚡−2` cells,
per-day lists with links, and the completed-but-unrated tasks to go back and rate.

```
export LINEAR_API_KEY=…   # Linear → Settings → Security & access → Personal API keys
export RECLAIM_TOKEN=…    # app.reclaim.ai/settings/developer
tools/energy_week.py --team HOME --out ~/Obsidian/notes/Energy/2026-W38.md   # current ISO week
tools/energy_week.py --team HOME --week 2026-W37 --print                     # a past week, to stdout
tools/energy_week.py --team HOME --cycle current                             # the team's active Linear cycle → ./<week>.md
tools/energy_week.py --from-json tools/fixtures/energy_week_sample.json --print   # offline demo
```

`LINEAR_TEAM` and `ENERGY_OUT_DIR` in the environment are the defaults for `--team` and for the output
folder (`<folder>/<week>.md`); `--tz` picks the grid's zone (default: the system zone). Events are matched
to issues by a Linear URL or identifier in the event, or by the calendar attachment the "＋" button adds
to the issue. Stdlib only, Python 3.9+; `npm run test:py` runs its tests.

## Why not let Reclaim do it

Reclaim's Planner shows Linear, Todoist and Google tasks as a lightweight task list (Mark Done,
Start timer, Log work) that its scheduler never books, and its API refuses writes from the browser.
A prefilled Calendar event is the shortest reliable path onto the calendar.

## Development

```
npm install
npm run check    # tsc
npm test         # node --test: pure functions, plus the Reclaim script in a fake DOM (test/fakedom.ts)
npm run test:py  # python -m unittest (needs Python 3.9+)
npm run build    # dist/*.user.js, linear-block-ext/, dist/*.bookmarklet.js
npm run verify   # what CI runs: check + test + test:py + build
```

Sources are in `src/` (TypeScript, bundled by esbuild, unminified so Greasy Fork can read them).
`src/*.entry.ts` are the userscript/extension entry points; `src/linear.ts` and `src/reclaim.ts`
export `main()` plus the pure helpers the tests and the bookmarklet import.
Commit `dist/` and `linear-block-ext/`: the raw links and the unpacked extension point at them.
Bump `version` in `package.json` whenever `dist/` changes: managers only update when `@version` grows.

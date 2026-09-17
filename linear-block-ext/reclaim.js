"use strict";
(() => {
  // src/shared.ts
  var DEFAULT_SETTINGS = {
    workspaceSlug: "",
    teamKeys: [],
    projectName: "",
    durationByEstimate: { XS: 30, S: 60, M: 120, L: 240, XL: 480 },
    defaultMinutes: 60,
    energyGroup: "Energy Δ"
  };
  var SETTINGS_KEY = "tcb-settings";
  function hasGm() {
    return typeof GM_getValue === "function" && typeof GM_setValue === "function";
  }
  function gmApi() {
    return typeof GM === "object" && GM !== null && typeof GM.getValue === "function" && typeof GM.setValue === "function" ? GM : null;
  }
  function extStorage() {
    try {
      const c = globalThis.chrome;
      return c && c.storage && c.storage.local ? c.storage.local : null;
    } catch {
      return null;
    }
  }
  function makeStore() {
    if (hasGm()) {
      return {
        kind: "gm",
        async get(k) {
          const v = GM_getValue(k, null);
          return typeof v === "string" ? v : null;
        },
        async set(k, v) {
          GM_setValue(k, v);
        },
        async remove(k) {
          if (typeof GM_deleteValue === "function") GM_deleteValue(k);
          else GM_setValue(k, null);
        }
      };
    }
    const gm = gmApi();
    if (gm) {
      return {
        kind: "gm",
        async get(k) {
          const v = await gm.getValue(k, null);
          return typeof v === "string" ? v : null;
        },
        async set(k, v) {
          await gm.setValue(k, v);
        },
        async remove(k) {
          await gm.deleteValue(k);
        }
      };
    }
    const ext = extStorage();
    if (ext) {
      const unavailable = (e) => new Error(`extension storage unavailable, reload this tab (${e instanceof Error ? e.message : String(e)})`);
      return {
        kind: "extension",
        async get(k) {
          try {
            const o = await ext.get(k);
            const v = o[k];
            return typeof v === "string" ? v : null;
          } catch {
            return null;
          }
        },
        async set(k, v) {
          try {
            await ext.set({ [k]: v });
          } catch (e) {
            throw unavailable(e);
          }
        },
        async remove(k) {
          try {
            await ext.remove(k);
          } catch (e) {
            throw unavailable(e);
          }
        }
      };
    }
    return {
      kind: "local",
      async get(k) {
        try {
          return localStorage.getItem(k);
        } catch {
          return null;
        }
      },
      async set(k, v) {
        try {
          localStorage.setItem(k, v);
        } catch {
        }
      },
      async remove(k) {
        try {
          localStorage.removeItem(k);
        } catch {
        }
      }
    };
  }
  function parseSettings(raw) {
    if (!raw) return { ...DEFAULT_SETTINGS, durationByEstimate: { ...DEFAULT_SETTINGS.durationByEstimate } };
    let o = null;
    try {
      o = JSON.parse(raw);
    } catch {
    }
    const s = o && typeof o === "object" ? o : {};
    const out = { ...DEFAULT_SETTINGS, durationByEstimate: { ...DEFAULT_SETTINGS.durationByEstimate } };
    if (typeof s.workspaceSlug === "string") out.workspaceSlug = normalizeSlug(s.workspaceSlug) ?? "";
    if (Array.isArray(s.teamKeys)) out.teamKeys = normalizeTeamKeys(s.teamKeys.map(String));
    if (typeof s.projectName === "string") out.projectName = s.projectName.trim();
    const d = parseDurations(s.durationByEstimate);
    if (d && Object.keys(d).length) out.durationByEstimate = d;
    const dm = Number(s.defaultMinutes);
    if (Number.isFinite(dm) && dm > 0) out.defaultMinutes = Math.round(dm);
    if (typeof s.energyGroup === "string") out.energyGroup = s.energyGroup.trim();
    return out;
  }
  function normalizeTeamKeys(keys) {
    const out = [];
    for (const k of keys) {
      const u = k.trim().toUpperCase();
      if (/^[A-Z][A-Z0-9]{0,7}$/.test(u) && !out.includes(u)) out.push(u);
    }
    return out;
  }
  function splitTeamKeys(input) {
    const entered = input.split(/[,\s]+/).filter(Boolean);
    const kept = normalizeTeamKeys(entered);
    const dropped = entered.filter((k) => !kept.includes(k.toUpperCase()));
    return { kept, dropped };
  }
  function normalizeSlug(input) {
    const raw = input.trim().replace(/^(https?:\/\/)?(www\.)?linear\.app\//i, "").split(/[/?#]/)[0] ?? "";
    return !raw || /^[a-z0-9][a-z0-9-]*$/i.test(raw) ? raw.toLowerCase() : null;
  }
  function parseDurations(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const d = {};
    for (const [k, v] of Object.entries(o)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n > 0) d[k.toUpperCase()] = Math.round(n);
    }
    return d;
  }
  async function loadSettings(store) {
    return parseSettings(await store.get(SETTINGS_KEY));
  }
  async function saveSettings(store, s) {
    await store.set(SETTINGS_KEY, JSON.stringify(s));
  }
  async function editSettings(store, current) {
    const keys = window.prompt("Linear team keys, comma- or space-separated (empty = detect from the page):", current.teamKeys.join(", "));
    if (keys === null) return null;
    const { kept, dropped } = splitTeamKeys(keys);
    const slug = window.prompt("Linear workspace slug (the part after linear.app/, or paste any linear.app URL; empty = detect):", current.workspaceSlug);
    if (slug === null) return null;
    const ws = normalizeSlug(slug);
    if (ws === null) {
      toast(`"${slug.trim()}" is not a Linear workspace slug (letters, digits, dashes); settings unchanged`, 6e3);
      return null;
    }
    const project = window.prompt("Linear project for issues created from calendar events (empty = none):", current.projectName);
    if (project === null) return null;
    const durations = window.prompt(
      "Block length per estimate, as JSON minutes:",
      JSON.stringify(current.durationByEstimate)
    );
    if (durations === null) return null;
    let dur;
    try {
      dur = JSON.parse(durations);
    } catch {
      toast('Durations: not valid JSON (use {"XS":30,"S":60,...}); settings unchanged', 6e3);
      return null;
    }
    const d = parseDurations(dur);
    if (!d) {
      toast('Durations must be a JSON object like {"XS":30,"S":60}; settings unchanged', 6e3);
      return null;
    }
    if (!Object.keys(d).length) {
      toast("Durations: no valid minute values; settings unchanged", 6e3);
      return null;
    }
    const group = window.prompt("Linear label group for energy values (⚡ badge on calendar events; empty = off):", current.energyGroup);
    if (group === null) return null;
    if (dropped.length) toast(`Ignored team keys: ${dropped.join(", ")} (letters/digits, max 8)`, 6e3);
    const next = { ...current, teamKeys: kept, workspaceSlug: ws, projectName: project.trim(), durationByEstimate: d, energyGroup: group.trim() };
    await saveSettings(store, next);
    return next;
  }
  function registerMenu(label, fn) {
    if (typeof GM_registerMenuCommand === "function") {
      try {
        GM_registerMenuCommand(label, fn);
      } catch {
      }
      return;
    }
    const gm = gmApi();
    if (gm && typeof gm.registerMenuCommand === "function") {
      try {
        gm.registerMenuCommand(label, fn);
      } catch {
      }
    }
  }
  function issueIdRegex(teamKeys) {
    const keys = normalizeTeamKeys([...teamKeys]);
    if (!keys.length) return null;
    return new RegExp("\\b((?:" + keys.join("|") + ")-\\d+)\\b");
  }
  function normalizeIssueId(answer, teamKeys) {
    const s = answer.trim();
    if (!s) return null;
    const defaultTeam = normalizeTeamKeys([...teamKeys])[0];
    if (/^\d+$/.test(s)) return defaultTeam ? `${defaultTeam}-${s}` : null;
    const u = s.match(/\/issue\/([A-Za-z][A-Za-z0-9]{0,7}-\d+)/);
    if (u && u[1]) return u[1].toUpperCase();
    const generic = s.toUpperCase().match(/^([A-Z][A-Z0-9]{0,7}-\d+)$/);
    if (generic && generic[1]) return generic[1];
    return s;
  }
  function fmtLocal(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
  }
  function nextHalfHour(now = /* @__PURE__ */ new Date()) {
    const d = new Date(now.getTime());
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
    return d;
  }
  function calendarTemplateUrl(spec) {
    const end = new Date(spec.start.getTime() + Math.max(5, spec.minutes) * 6e4);
    const q = new URLSearchParams({
      action: "TEMPLATE",
      text: spec.title,
      details: spec.details,
      dates: `${fmtLocal(spec.start)}/${fmtLocal(end)}`,
      // fmtLocal() emits wall-clock times; pin them to the browser's zone so Google does not
      // reinterpret them in the calendar's configured zone.
      ctz: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
    return `https://calendar.google.com/calendar/render?${q}`;
  }
  function openInNewTab(url) {
    window.open(url, "_blank", "noopener");
  }
  function toast(msg, ms = 4e3) {
    const el = document.createElement("div");
    el.textContent = msg;
    Object.assign(el.style, {
      position: "fixed",
      left: "50%",
      bottom: "24px",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      background: "#222",
      color: "#fff",
      padding: "10px 16px",
      borderRadius: "8px",
      font: "500 13px system-ui",
      boxShadow: "0 2px 12px #0006",
      maxWidth: "70vw"
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
  function run(p) {
    p.catch((e) => toast(`Task → Calendar block: ${e instanceof Error ? e.message : String(e)}`, 6e3));
  }
  function isolateClicks(el, types = ["pointerdown", "mousedown", "click"]) {
    for (const t of types) el.addEventListener(t, (e) => e.stopPropagation());
  }
  function energyValue(name) {
    const m = name.trim().replace(/[−–]/g, "-").match(/^([+-]?)(\d{1,2})$/);
    if (!m) return null;
    const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
    return n >= -10 && n <= 10 ? n : null;
  }
  function energyText(n) {
    return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
  }

  // src/reclaim.ts
  var ROW = '[class*="TaskListItem_root"]';
  var TITLE = '[class*="TaskListItem_task__title"]';
  var SUFFIX = '[class*="linkSuffix"]';
  var ACTIONS = '[class*="metadata__left"]';
  var CHIP = "[data-event-key]";
  var CHIP_HEADER = '[class*="CalendarEventDetails_content__header"]';
  var ROW_BTN = "tcb-block-btn";
  var LINK_CLASS = "tcb-ev-link";
  var ADD_CLASS = "tcb-ev-add";
  var ENERGY_CLASS = "tcb-ev-energy";
  var ENERGY_MENU = "tcb-ev-energy-menu";
  var STORE_KEY = "tcb-ev-links-v2";
  var API_KEY = "tcb-linear-api-key";
  var RECLAIM_API = "https://api.app.reclaim.ai/api";
  var LINEAR_GQL = "https://api.linear.app/graphql";
  var URL_RE = /https:\/\/(?:linear\.app|tasks\.google\.com|(?:app\.)?todoist\.com)\/[^\s"'<>()[\]\\]+/;
  function rowTitle(row) {
    const t = row.querySelector(TITLE);
    if (!t) return null;
    const suffix = row.querySelector(SUFFIX);
    const parts = [(t.textContent || "").trim()];
    if (suffix && !t.contains(suffix)) parts.push((suffix.textContent || "").trim());
    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ");
  }
  function minutesFromText(text, fallback) {
    const segs = text.split(/[•\n]/).map((s) => s.trim()).reverse();
    for (const s of segs) {
      const m = s.match(/^(?:(\d+(?:\.\d+)?)h)?\s?(?:(\d+)m)?$/);
      if (m && (m[1] || m[2])) {
        const v = Math.round(Number(m[1] || 0) * 60) + Number(m[2] || 0);
        return v > 0 ? v : fallback;
      }
    }
    return fallback;
  }
  function sourceLabel(href) {
    if (!href) return "Reclaim task";
    if (href.includes("linear.app")) return "Linear";
    if (href.includes("tasks.google.com")) return "Google Tasks";
    if (href.includes("todoist.com")) return "Todoist";
    return "Task";
  }
  function seriesKey(key) {
    return key.replace(/_\d{8}(?:T\d{6}Z)?$/, "");
  }
  function linkLabel(url) {
    if (url.includes("linear.app")) return "Open in Linear";
    if (url.includes("tasks.google.com")) return "Open in Google Tasks";
    return "Open in Todoist";
  }
  function detectTeamKeys(root = document) {
    const found = [];
    for (const a of root.querySelectorAll('a[href^="https://linear.app/"]')) {
      const m = a.href.match(/\/issue\/([A-Za-z][A-Za-z0-9]{0,7})-\d+/);
      if (m && m[1]) found.push(m[1]);
    }
    return normalizeTeamKeys(found);
  }
  function detectWorkspaceSlug(root = document) {
    for (const a of root.querySelectorAll('a[href^="https://linear.app/"]')) {
      const m = a.href.match(/^https:\/\/linear\.app\/([^/]+)\/issue\//);
      if (m && m[1]) return m[1];
    }
    return "";
  }
  var transient = (status) => status === 401 || status === 408 || status === 429 || status >= 500;
  function main() {
    const html = document.documentElement;
    if (html.dataset["tcbReclaim"]) {
      console.info("task-calendar-block: another copy is already active on this page");
      return;
    }
    html.dataset["tcbReclaim"] = "1";
    const store = makeStore();
    let settings = null;
    const getSettings = async () => {
      if (settings) return settings;
      try {
        settings = await loadSettings(store);
      } catch {
        return parseSettings(null);
      }
      return settings;
    };
    const teamKeys = (s) => s.teamKeys.length ? s.teamKeys : detectTeamKeys();
    const slug = (s) => s.workspaceSlug || detectWorkspaceSlug();
    async function openSettings() {
      const next = await editSettings(store, await getSettings());
      if (next) {
        settings = next;
        forgetLinks();
        toast("Settings saved");
      }
    }
    registerMenu("Task → Calendar block: settings…", () => run(openSettings()));
    registerMenu("Task → Calendar block: forget Linear API key", () => run(forgetApiKey()));
    function mountRows() {
      for (const row of document.querySelectorAll(ROW)) {
        if (row.querySelector("." + ROW_BTN)) continue;
        const actions = row.querySelector(ACTIONS);
        if (!actions) continue;
        const buttons = [...actions.querySelectorAll("button")];
        const ref = buttons.find((b) => (b.textContent || "").trim() === "Start Task") ?? buttons[buttons.length - 1];
        const iconMode = !buttons.some((b) => (b.textContent || "").trim());
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = ROW_BTN;
        btn.textContent = iconMode ? "📅" : "📅 Block";
        btn.title = "Open a prefilled Google Calendar event for this task. Shift+click: settings";
        Object.assign(btn.style, {
          font: ref ? getComputedStyle(ref).font : "500 13px Poppins, system-ui",
          padding: ref ? getComputedStyle(ref).padding : "4px 8px",
          color: "inherit",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          opacity: "0.85"
        });
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            run(openSettings());
            return;
          }
          run((async () => {
            const s = await getSettings();
            const title = rowTitle(row);
            if (!title) return;
            const a = row.querySelector("a[href]");
            const href = a ? a.href : "";
            openInNewTab(calendarTemplateUrl({
              title,
              details: `${sourceLabel(href)}: ${title}${href ? "\n" + href : ""}`,
              start: nextHalfHour(),
              // innerText keeps the block boundaries as line breaks (see minutesFromText); textContent
              // would glue the title, "📅" and "4h" into one segment.
              minutes: minutesFromText(row.innerText || row.textContent || "", s.defaultMinutes)
            }));
          })());
        });
        actions.appendChild(btn);
      }
    }
    setInterval(mountRows, 700);
    let stored = {};
    try {
      stored = JSON.parse(sessionStorage.getItem(STORE_KEY) || "{}");
    } catch {
    }
    const cache = /* @__PURE__ */ new Map();
    const retryAt = /* @__PURE__ */ new Map();
    function remember(k, url) {
      stored[k] = url;
      try {
        sessionStorage.setItem(STORE_KEY, JSON.stringify(stored));
      } catch {
      }
      return url;
    }
    function forgetLinks() {
      stored = {};
      try {
        sessionStorage.removeItem(STORE_KEY);
      } catch {
      }
      cache.clear();
      retryAt.clear();
      for (const chip of document.querySelectorAll(CHIP)) {
        chip.querySelectorAll("." + LINK_CLASS + ", ." + ADD_CLASS).forEach((n) => n.remove());
        delete chip.dataset["tcbSeen"];
        delete chip.dataset["tcbAdd"];
      }
      forgetEnergy();
    }
    function chipTitle(chip) {
      return ((chip.querySelector(CHIP_HEADER) || chip).textContent || "").trim();
    }
    async function resolveLink(chip) {
      const key = chip.getAttribute("data-event-key");
      if (!key) return null;
      const k = seriesKey(key);
      if (k in stored) return stored[k] ?? null;
      const inflight = cache.get(k);
      if (inflight) return inflight;
      const s = await getSettings();
      if (k in stored) return stored[k] ?? null;
      const again = cache.get(k);
      if (again) return again;
      const idRe = issueIdRegex(teamKeys(s));
      const idMatch = idRe ? chipTitle(chip).match(idRe) : null;
      let p;
      if (idMatch && idMatch[1] && slug(s)) {
        p = Promise.resolve(remember(k, `https://linear.app/${slug(s)}/issue/${idMatch[1]}`));
      } else {
        const [cal, ...rest] = key.split("/");
        const url = `${RECLAIM_API}/events/${cal}/${encodeURIComponent(rest.join("/"))}`;
        p = fetch(url, { credentials: "include" }).then((r) => {
          if (r.ok) return r.text();
          if (transient(r.status)) throw new Error("transient " + r.status);
          return "";
        }).then((body) => {
          retryAt.delete(k);
          const m = body.match(URL_RE);
          return remember(k, m ? m[0] : null);
        }).catch(() => {
          cache.delete(k);
          const n = (retryAt.get(k)?.n ?? 0) + 1;
          retryAt.set(k, { n, t: Date.now() + Math.min(3e5, 5e3 * 2 ** (n - 1)) });
          return null;
        });
      }
      cache.set(k, p);
      return p;
    }
    function decorate(chip, url) {
      if (chip.querySelector("." + LINK_CLASS)) return;
      const a = document.createElement("a");
      a.className = LINK_CLASS;
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "↗";
      a.title = linkLabel(url);
      Object.assign(a.style, {
        position: "absolute",
        top: "1px",
        right: "3px",
        zIndex: "5",
        lineHeight: "14px",
        font: "700 11px system-ui",
        textDecoration: "none",
        color: "inherit",
        background: "rgba(255,255,255,0.75)",
        borderRadius: "4px",
        padding: "0 4px",
        opacity: "0.9"
      });
      isolateClicks(a);
      if (getComputedStyle(chip).position === "static") chip.style.position = "relative";
      chip.appendChild(a);
      mountEnergy(chip, url);
    }
    function mountEventLinks() {
      for (const chip of document.querySelectorAll(CHIP)) {
        if (chip.dataset["tcbSeen"]) continue;
        const k = seriesKey(chip.getAttribute("data-event-key") || "");
        const r = retryAt.get(k);
        if (r && Date.now() < r.t) continue;
        chip.dataset["tcbSeen"] = "1";
        void resolveLink(chip).then((url) => {
          if (url) decorate(chip, url);
          else if (k && !(k in stored)) delete chip.dataset["tcbSeen"];
        }).catch(() => {
          delete chip.dataset["tcbSeen"];
        });
      }
    }
    setInterval(mountEventLinks, 1e3);
    const pending = /* @__PURE__ */ new Set();
    let credentialId = null;
    const style = document.createElement("style");
    style.textContent = `.${ADD_CLASS}{opacity:0;transition:opacity .15s}${CHIP}:hover .${ADD_CLASS}{opacity:.95}`;
    document.head.appendChild(style);
    async function forgetApiKey() {
      await store.remove(API_KEY);
      toast('Linear API key forgotten; the next "＋" asks for one');
    }
    async function apiKey(interactive = true) {
      let k = await store.get(API_KEY);
      if (!k) {
        if (!interactive) return null;
        const where = store.kind === "extension" ? "Kept in the extension's own storage (chrome.storage.local)." : store.kind === "gm" ? "Kept in the script manager's private storage." : "Note: without a userscript manager or extension it is kept in app.reclaim.ai localStorage, readable by Reclaim's own scripts.";
        k = (window.prompt(`Linear personal API key (Linear → Settings → Security & access → Personal API keys). ${where} Shift+click "＋" forgets it.`) || "").trim();
        if (!k) return null;
        if (!/^[\x21-\x7e]+$/.test(k)) {
          toast("That does not look like a Linear API key (ASCII, no spaces or line breaks); nothing saved", 6e3);
          return null;
        }
        await store.set(API_KEY, k);
      }
      return k;
    }
    async function gql(query, variables, opts = {}) {
      const key = await apiKey(opts.interactive !== false);
      if (!key) throw new Error("No Linear API key");
      const r = await fetch(LINEAR_GQL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body: JSON.stringify({ query, variables })
      });
      const rejected = async () => {
        try {
          await store.remove(API_KEY);
        } catch {
        }
        throw new Error("Linear rejected the API key; it was cleared, try again");
      };
      if (r.status === 401) return rejected();
      const text = await r.text();
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {
      }
      if (!j || typeof j !== "object") throw new Error(`Linear HTTP ${r.status}`);
      const errs = Array.isArray(j.errors) ? j.errors : [];
      if (errs.some((e) => e.extensions?.type === "authentication error")) return rejected();
      if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
      if (j.error) throw new Error(String(j.error));
      if (!j.data) throw new Error("Linear returned no data");
      return j.data;
    }
    async function eventInfo(chip) {
      const key = chip.getAttribute("data-event-key") || "";
      const [cal, ...rest] = key.split("/");
      const id = rest.join("/");
      const ev = await fetch(`${RECLAIM_API}/events/${cal}/${encodeURIComponent(id)}`, { credentials: "include" }).then((r) => r.ok ? r.json() : null).catch(() => null);
      let htmlLink = null;
      try {
        if (!credentialId) {
          const me = await fetch(`${RECLAIM_API}/users/current`, { credentials: "include" }).then((r) => r.text());
          const m = me.match(/"credentialId":(\d+)/);
          credentialId = m && m[1] ? m[1] : null;
        }
        if (credentialId) {
          const raw = await fetch(`${RECLAIM_API}/events/raw-google/${credentialId}/${cal}/${encodeURIComponent(id)}`, { credentials: "include" }).then((r) => r.ok ? r.json() : null);
          htmlLink = raw?.rawData?.htmlLink ?? null;
        }
      } catch {
      }
      const title = ev?.title || chipTitle(chip);
      const when = ev?.eventStart ? new Date(ev.eventStart) : null;
      return { key, title, when, htmlLink };
    }
    async function linkOrCreate(chip, issueId) {
      const s = await getSettings();
      const info = await eventInfo(chip);
      let issue;
      if (issueId) {
        const d = await gql("query($id:String!){ issue(id:$id){ id identifier url title } }", { id: issueId });
        if (!d.issue) throw new Error(`Issue ${issueId} not found`);
        issue = d.issue;
      } else {
        const team = teamKeys(s)[0];
        if (!team) throw new Error("No Linear team key known: set one in settings (Shift+click 📅 Block)");
        const meta = await gql(`query($team:String!,$project:String!,$withProject:Boolean!){
        teams(filter:{key:{eq:$team}}){ nodes{ id activeCycle{ id startsAt endsAt } } }
        projects(filter:{name:{eq:$project}}) @include(if:$withProject){ nodes{ id } }
        viewer{ id } }`, { team, project: s.projectName || "-", withProject: Boolean(s.projectName) });
        const t = meta.teams.nodes[0];
        if (!t) throw new Error(`Linear team ${team} not found`);
        const input = { teamId: t.id, title: info.title, priority: 3, assigneeId: meta.viewer.id };
        const cyc = t.activeCycle;
        if (cyc && (!info.when || info.when >= new Date(cyc.startsAt) && info.when < new Date(cyc.endsAt))) input["cycleId"] = cyc.id;
        const project = meta.projects?.nodes[0];
        if (project) input["projectId"] = project.id;
        if (info.when) input["description"] = `Calendar block: ${info.when.toLocaleString()}`;
        const d = await gql(
          "mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier url title } } }",
          { input }
        );
        if (!d.issueCreate.issue) throw new Error("Linear did not create the issue");
        issue = d.issueCreate.issue;
      }
      let attached = null;
      if (info.htmlLink) {
        const label = `Calendar: ${info.title}${info.when ? ", " + info.when.toLocaleString() : ""}`;
        attached = await gql(
          "mutation($issueId:String!,$url:String!,$title:String!){ attachmentLinkURL(issueId:$issueId,url:$url,title:$title){ success } }",
          { issueId: issue.id, url: info.htmlLink, title: label }
        ).then(() => true).catch(() => false);
      }
      const sk = seriesKey(info.key);
      remember(sk, issue.url);
      for (const c of document.querySelectorAll(CHIP)) {
        if (seriesKey(c.getAttribute("data-event-key") || "") !== sk) continue;
        c.querySelectorAll("." + ADD_CLASS).forEach((n) => n.remove());
        decorate(c, issue.url);
      }
      return { issue, attached };
    }
    function addButton(chip) {
      if (chip.querySelector("." + ADD_CLASS) || chip.querySelector("." + LINK_CLASS)) return;
      if (pending.has(seriesKey(chip.getAttribute("data-event-key") || ""))) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = ADD_CLASS;
      b.textContent = "＋";
      b.title = "Link or create a Linear issue for this event. Shift+click: forget the stored API key";
      Object.assign(b.style, {
        position: "absolute",
        top: "1px",
        right: "3px",
        zIndex: "5",
        lineHeight: "14px",
        border: "none",
        font: "700 12px system-ui",
        color: "inherit",
        background: "rgba(255,255,255,0.75)",
        borderRadius: "4px",
        padding: "0 4px",
        cursor: "pointer"
      });
      isolateClicks(b, ["pointerdown", "mousedown"]);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.shiftKey) {
          run(forgetApiKey());
          return;
        }
        const k = seriesKey(chip.getAttribute("data-event-key") || "");
        if (pending.has(k)) return;
        const cur = stored[k];
        if (cur) {
          b.remove();
          decorate(chip, cur);
          return;
        }
        run((async () => {
          const s = await getSettings();
          const keys = teamKeys(s);
          const example = keys[0] ? `${keys[0]}-26` : "ABC-26";
          const answer = window.prompt(`Linear issue ID to link (e.g. ${example}), or leave empty to create a new issue titled:
"${chipTitle(chip)}"`, "");
          if (answer === null) return;
          const id = normalizeIssueId(answer, keys);
          if (answer.trim() && !id) {
            toast("Enter a full issue ID like ABC-26 (no default team is known)");
            return;
          }
          pending.add(k);
          b.textContent = "…";
          try {
            const { issue, attached } = await linkOrCreate(chip, id);
            const note = attached === false ? " (calendar link NOT attached)" : attached === null ? " (no calendar link available)" : "";
            toast(`${id ? "Linked" : "Created"} ${issue.identifier} ${issue.title}${note}`);
          } catch (err) {
            b.textContent = "＋";
            toast(`Linear: ${err instanceof Error ? err.message : String(err)}`, 6e3);
          } finally {
            pending.delete(k);
          }
        })());
      });
      if (getComputedStyle(chip).position === "static") chip.style.position = "relative";
      chip.appendChild(b);
    }
    let groupLabels = null;
    const issueCache = /* @__PURE__ */ new Map();
    const energyRetryAt = /* @__PURE__ */ new Map();
    const ISSUE_URL_RE = /linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]{0,7}-\d+)/;
    const energyStyle = document.createElement("style");
    energyStyle.textContent = `.${ENERGY_MENU}{position:fixed;z-index:2147483647;display:flex;gap:2px;padding:4px;border-radius:8px;background:#fff;box-shadow:0 2px 12px #0005}.${ENERGY_MENU} button{border:1px solid #8884;border-radius:6px;background:#fff;font:600 12px system-ui;padding:2px 6px;cursor:pointer;color:#222}.${ENERGY_MENU} button:hover{background:#eee}`;
    document.head.appendChild(energyStyle);
    function loadGroupLabels(group) {
      if (!groupLabels || groupLabels.group !== group) {
        const p = gql(
          "query($group:String!){ issueLabels(filter:{parent:{name:{eq:$group}}}, first:50){ nodes{ id name } } }",
          { group }
        ).then((d) => d.issueLabels.nodes.map((l) => ({ id: l.id, name: l.name, value: energyValue(l.name) })).filter((l) => l.value !== null).sort((a, b) => a.value - b.value)).catch((e) => {
          if (groupLabels?.p === p) groupLabels = null;
          throw e;
        });
        groupLabels = { group, p };
      }
      return groupLabels.p;
    }
    function loadIssueLabels(identifier, group, interactive = true) {
      let p = issueCache.get(identifier);
      if (!p) {
        p = gql(
          "query($id:String!){ issue(id:$id){ id labels(first:50){ nodes{ id name parent{ name } } } } }",
          { id: identifier },
          { interactive }
        ).then((d) => {
          energyRetryAt.delete(identifier);
          if (!d.issue) return null;
          const mine = d.issue.labels.nodes.filter((l) => l.parent?.name === group);
          return { id: d.issue.id, groupLabelIds: mine.map((l) => l.id), value: mine[0] ? energyValue(mine[0].name) : null };
        }).catch((e) => {
          issueCache.delete(identifier);
          const n = (energyRetryAt.get(identifier)?.n ?? 0) + 1;
          energyRetryAt.set(identifier, { n, t: Date.now() + Math.min(3e5, 5e3 * 2 ** (n - 1)) });
          throw e;
        });
        issueCache.set(identifier, p);
      }
      return p;
    }
    function paintBadge(b, value) {
      b.textContent = value === null ? "⚡" : `⚡${energyText(value)}`;
      b.style.opacity = value === null ? "0.6" : "1";
      b.title = value === null ? "Set energy change for this task" : `Energy change ${energyText(value)} (click to change)`;
    }
    const updating = /* @__PURE__ */ new Map();
    function serial(id, job) {
      const next = (updating.get(id) ?? Promise.resolve()).catch(() => void 0).then(job);
      updating.set(id, next);
      return next;
    }
    function setEnergy(identifier, group, value) {
      return serial(identifier, async () => {
        issueCache.delete(identifier);
        const [labels, current] = await Promise.all([loadGroupLabels(group), loadIssueLabels(identifier, group)]);
        if (!current) throw new Error(`Issue ${identifier} not found`);
        const target = labels.find((l) => l.value === value);
        if (!target) throw new Error(`No "${energyText(value)}" label in group ${group}`);
        const removedLabelIds = current.groupLabelIds.filter((id) => id !== target.id);
        await gql(
          "mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }",
          { id: current.id, input: { addedLabelIds: [target.id], removedLabelIds } }
        );
        issueCache.set(identifier, Promise.resolve({ id: current.id, groupLabelIds: [target.id], value }));
      });
    }
    function closeMenus() {
      document.querySelectorAll("." + ENERGY_MENU).forEach((m) => m.remove());
    }
    function forgetEnergy() {
      groupLabels = null;
      issueCache.clear();
      energyRetryAt.clear();
      closeMenus();
      document.querySelectorAll("." + ENERGY_CLASS).forEach((n) => n.remove());
    }
    document.addEventListener("pointerdown", (e) => {
      if (!(e.target instanceof Element) || !e.target.closest("." + ENERGY_MENU)) closeMenus();
    }, true);
    document.addEventListener("scroll", closeMenus, true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenus();
    }, true);
    async function openPicker(chip, badge, identifier, group) {
      closeMenus();
      const labels = await loadGroupLabels(group);
      if (!labels.length) {
        toast(`Label group "${group}" has no numeric labels`);
        return;
      }
      const menu = document.createElement("div");
      menu.className = ENERGY_MENU;
      for (const l of labels) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = energyText(l.value);
        b.title = l.name;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          closeMenus();
          const prev = issueCache.get(identifier);
          paintBadge(badge, l.value);
          run(setEnergy(identifier, group, l.value).then(
            () => {
              for (const other of document.querySelectorAll(`.${ENERGY_CLASS}[data-issue="${identifier}"]`)) paintBadge(other, l.value);
            },
            (err) => {
              const back = issueCache.get(identifier) ?? prev ?? Promise.resolve(null);
              void back.then((c) => paintBadge(badge, c?.value ?? null), () => paintBadge(badge, null));
              throw err;
            }
          ));
        });
        menu.appendChild(b);
      }
      isolateClicks(menu);
      closeMenus();
      menu.style.position = "fixed";
      document.body.appendChild(menu);
      const r = badge.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      const top = r.bottom + 4 + m.height > innerHeight ? r.top - 4 - m.height : r.bottom + 4;
      const left = Math.max(4, Math.min(r.right - m.width, innerWidth - m.width - 4));
      Object.assign(menu.style, { left: `${left}px`, top: `${Math.max(4, top)}px` });
    }
    function mountEnergy(chip, url) {
      const m = url.match(ISSUE_URL_RE);
      if (!m || !m[1] || chip.querySelector("." + ENERGY_CLASS)) return;
      const identifier = m[1].toUpperCase();
      const b = document.createElement("button");
      b.type = "button";
      b.className = ENERGY_CLASS;
      b.dataset["issue"] = identifier;
      Object.assign(b.style, {
        position: "absolute",
        top: "1px",
        right: "22px",
        zIndex: "5",
        lineHeight: "14px",
        border: "none",
        font: "700 11px system-ui",
        color: "inherit",
        background: "rgba(255,255,255,0.75)",
        borderRadius: "4px",
        padding: "0 4px",
        cursor: "pointer"
      });
      paintBadge(b, null);
      isolateClicks(b, ["pointerdown", "mousedown"]);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        run((async () => {
          const s = await getSettings();
          if (!s.energyGroup) {
            toast("Energy badge is off: set a label group in settings (Shift+click 📅 Block)");
            return;
          }
          await openPicker(chip, b, identifier, s.energyGroup);
        })());
      });
      chip.appendChild(b);
      run((async () => {
        const s = await getSettings();
        if (!s.energyGroup) {
          b.remove();
          return;
        }
        const r = energyRetryAt.get(identifier);
        if (r && Date.now() < r.t) return;
        if (!await store.get(API_KEY)) return;
        const cur = await loadIssueLabels(identifier, s.energyGroup, false).catch(() => null);
        if (cur) paintBadge(b, cur.value);
      })());
    }
    setInterval(() => {
      for (const chip of document.querySelectorAll(CHIP)) {
        if (chip.dataset["tcbAdd"]) continue;
        const k = seriesKey(chip.getAttribute("data-event-key") || "");
        if (!(k in stored)) continue;
        if (pending.has(k)) continue;
        chip.dataset["tcbAdd"] = "1";
        const url = stored[k];
        if (url) decorate(chip, url);
        else addButton(chip);
      }
    }, 1200);
  }

  // src/reclaim.entry.ts
  if (typeof document !== "undefined" && typeof location !== "undefined" && location.hostname === "app.reclaim.ai") main();
})();

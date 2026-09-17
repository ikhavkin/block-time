// ==UserScript==
// @name         Linear → Google Calendar block
// @namespace    https://github.com/ikhavkin/block-time
// @version      2.1.0
// @description  On a Linear issue page, press Option+B or click "📅 Block time" next to Activity to open a prefilled Google Calendar event: "<ID> <title>", Linear URL in the description, duration from the T-shirt estimate.
// @author       Ihor Khavkin
// @license      MIT
// @homepageURL  https://github.com/ikhavkin/block-time
// @supportURL   https://github.com/ikhavkin/block-time/issues
// @updateURL    https://raw.githubusercontent.com/ikhavkin/block-time/main/dist/linear-block-time.user.js
// @downloadURL  https://raw.githubusercontent.com/ikhavkin/block-time/main/dist/linear-block-time.user.js
// @match        https://linear.app/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.registerMenuCommand
// ==/UserScript==
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
  function leafWithText(selector, text, root = document) {
    for (const n of root.querySelectorAll(selector)) {
      if (n.children.length === 0 && (n.textContent || "").trim() === text) return n;
    }
    return null;
  }

  // src/linear.ts
  var ISSUE_RE = /\/issue\/([A-Z][A-Z0-9]{0,7}-\d+)(?:\/([^/?#]*))?/;
  var BTN_ID = "tcb-block-btn";
  function issueFromPath(pathname) {
    const m = pathname.match(ISSUE_RE);
    return m && m[1] ? { id: m[1], slug: m[2] || "" } : null;
  }
  function issueTitle(issue, docTitle) {
    const t = docTitle.trim();
    if (t.startsWith(issue.id + " ")) return t.slice(issue.id.length + 1).trim();
    if (issue.slug) {
      const words = issue.slug.split("-").filter(Boolean).join(" ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
    return t || issue.id;
  }
  function estimateMinutes(settings, root = document) {
    const heading = leafWithText("div,span,h2,h3,p", "Properties", root);
    const scope = heading?.nextElementSibling ?? null;
    if (!scope) return settings.defaultMinutes;
    for (const n of scope.querySelectorAll("div,span,button")) {
      const t = (n.textContent || "").trim().toUpperCase();
      const m = settings.durationByEstimate[t];
      if (m) return m;
    }
    return settings.defaultMinutes;
  }
  function main() {
    const html = document.documentElement;
    if (html.dataset["tcbLinear"]) {
      console.info("task-calendar-block: another copy is already active on this page");
      return;
    }
    html.dataset["tcbLinear"] = "1";
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
    async function openCalendar() {
      const issue = issueFromPath(location.pathname);
      if (!issue) {
        toast("Not on a Linear issue page.");
        return;
      }
      const s = await getSettings();
      const url = `https://linear.app${location.pathname}`;
      openInNewTab(calendarTemplateUrl({
        title: `${issue.id} ${issueTitle(issue, document.title)}`,
        details: `Linear: ${issue.id}
${url}`,
        start: nextHalfHour(),
        minutes: estimateMinutes(s)
      }));
    }
    async function openSettings() {
      const next = await editSettings(store, await getSettings());
      if (next) {
        settings = next;
        toast("Settings saved");
      }
    }
    registerMenu("Task → Calendar block: settings…", () => run(openSettings()));
    document.addEventListener("keydown", (e) => {
      if (!(e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyB")) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      run(openCalendar());
    }, true);
    function mountButton() {
      if (!issueFromPath(location.pathname) || document.getElementById(BTN_ID)) return;
      const heading = leafWithText("h3", "Activity");
      if (!heading) return;
      const btn = document.createElement("button");
      btn.id = BTN_ID;
      btn.type = "button";
      btn.textContent = "📅 Block time";
      btn.title = "Open a prefilled Google Calendar event for this issue (Option+B). Shift+click: settings";
      Object.assign(btn.style, {
        marginLeft: "12px",
        padding: "3px 10px",
        borderRadius: "6px",
        border: "1px solid #8886",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: "12px",
        fontWeight: "500",
        cursor: "pointer",
        verticalAlign: "middle"
      });
      btn.addEventListener("click", (e) => run(e.shiftKey ? openSettings() : openCalendar()));
      heading.appendChild(btn);
    }
    setInterval(mountButton, 500);
  }

  // src/linear.entry.ts
  if (typeof document !== "undefined" && typeof location !== "undefined" && /(^|\.)linear\.app$/.test(location.hostname)) main();
})();

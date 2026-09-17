// Shared by the Linear and Reclaim scripts: settings, storage, Google Calendar URL, small UI helpers.
// Runs in three hosts: a userscript manager (Tampermonkey/Violentmonkey with GM_* granted, or
// Greasemonkey 4 with only the promise-based GM.* API), a Chrome extension content script
// (chrome.storage), or a bare page context (bookmarklet / @grant none) with localStorage only.

export interface Settings {
  /** Linear workspace slug, e.g. "acme". Empty = detect from the page. */
  workspaceSlug: string;
  /** Linear team keys, e.g. ["HOME"]. Empty = detect from the page. First key is used to create issues. */
  teamKeys: string[];
  /** Linear project name for created issues. Empty = no project. */
  projectName: string;
  /** T-shirt estimate → minutes for the calendar block. */
  durationByEstimate: Record<string, number>;
  /** Block length when no estimate is known. */
  defaultMinutes: number;
  /** Linear label group whose labels are energy values (-5 … +5). Empty disables the ⚡ badge. */
  energyGroup: string;
}

export const DEFAULT_SETTINGS: Settings = {
  workspaceSlug: '',
  teamKeys: [],
  projectName: '',
  durationByEstimate: { XS: 30, S: 60, M: 120, L: 240, XL: 480 },
  defaultMinutes: 60,
  energyGroup: 'Energy Δ',
};

const SETTINGS_KEY = 'tcb-settings';

// ---- storage ------------------------------------------------------------------------------------

export interface Store {
  readonly kind: 'gm' | 'extension' | 'local';
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

declare const GM_getValue: ((key: string, def?: unknown) => unknown) | undefined;
declare const GM_setValue: ((key: string, value: unknown) => void) | undefined;
declare const GM_deleteValue: ((key: string) => void) | undefined;
declare const GM_registerMenuCommand: ((label: string, fn: () => void) => unknown) | undefined;
declare const GM: {
  getValue(key: string, def?: unknown): Promise<unknown>;
  setValue(key: string, value: unknown): Promise<void>;
  deleteValue(key: string): Promise<void>;
  registerMenuCommand?(label: string, fn: () => void): unknown;
} | undefined;

function hasGm(): boolean {
  return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
}

/** Greasemonkey 4 silently drops GM_* grants and exposes only the promise-based GM.* API;
 *  Tampermonkey/Violentmonkey expose both (the GM_* branch wins there, so nothing changes). */
function gmApi(): NonNullable<typeof GM> | null {
  return typeof GM === 'object' && GM !== null && typeof GM.getValue === 'function' && typeof GM.setValue === 'function' ? GM : null;
}

function extStorage(): chrome.storage.StorageArea | null {
  try {
    const c = (globalThis as { chrome?: typeof chrome }).chrome;
    return c && c.storage && c.storage.local ? c.storage.local : null;
  } catch {
    return null;
  }
}

export function makeStore(): Store {
  if (hasGm()) {
    return {
      kind: 'gm',
      async get(k) { const v = GM_getValue!(k, null); return typeof v === 'string' ? v : null; },
      async set(k, v) { GM_setValue!(k, v); },
      async remove(k) { if (typeof GM_deleteValue === 'function') GM_deleteValue(k); else GM_setValue!(k, null); },
    };
  }
  // Order matters: Greasemonkey 4 also has a chrome.storage.local, but Firefox's chrome.* namespace
  // never returns promises, so the extension branch would break there.
  const gm = gmApi();
  if (gm) {
    return {
      kind: 'gm',
      async get(k) { const v = await gm.getValue(k, null); return typeof v === 'string' ? v : null; },
      async set(k, v) { await gm.setValue(k, v); },
      async remove(k) { await gm.deleteValue(k); },
    };
  }
  const ext = extStorage();
  if (ext) {
    // After the unpacked extension is reloaded, the orphaned content script gets "Extension context
    // invalidated" from every chrome.* call: reads fall back to defaults, writes fail loudly (a
    // swallowed write would let "Settings saved" lie).
    const unavailable = (e: unknown): Error =>
      new Error(`extension storage unavailable, reload this tab (${e instanceof Error ? e.message : String(e)})`);
    return {
      kind: 'extension',
      async get(k) {
        try { const o = await ext.get(k); const v = o[k]; return typeof v === 'string' ? v : null; } catch { return null; }
      },
      async set(k, v) { try { await ext.set({ [k]: v }); } catch (e) { throw unavailable(e); } },
      async remove(k) { try { await ext.remove(k); } catch (e) { throw unavailable(e); } },
    };
  }
  return {
    kind: 'local',
    async get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    async set(k, v) { try { localStorage.setItem(k, v); } catch { /* quota / privacy mode */ } },
    async remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
}

// ---- settings -----------------------------------------------------------------------------------

export function parseSettings(raw: string | null): Settings {
  if (!raw) return { ...DEFAULT_SETTINGS, durationByEstimate: { ...DEFAULT_SETTINGS.durationByEstimate } };
  let o: unknown = null;
  try { o = JSON.parse(raw); } catch { /* fall through */ }
  const s = (o && typeof o === 'object' ? o : {}) as Partial<Record<keyof Settings, unknown>>;
  const out: Settings = { ...DEFAULT_SETTINGS, durationByEstimate: { ...DEFAULT_SETTINGS.durationByEstimate } };
  // A stored slug that is not a slug (e.g. "https:" from an older prompt) degrades to auto-detect.
  if (typeof s.workspaceSlug === 'string') out.workspaceSlug = normalizeSlug(s.workspaceSlug) ?? '';
  if (Array.isArray(s.teamKeys)) out.teamKeys = normalizeTeamKeys(s.teamKeys.map(String));
  if (typeof s.projectName === 'string') out.projectName = s.projectName.trim();
  const d = parseDurations(s.durationByEstimate);
  if (d && Object.keys(d).length) out.durationByEstimate = d;
  const dm = Number(s.defaultMinutes);
  if (Number.isFinite(dm) && dm > 0) out.defaultMinutes = Math.round(dm);
  if (typeof s.energyGroup === 'string') out.energyGroup = s.energyGroup.trim();
  return out;
}

/** Team keys are 1–8 chars, letters then letters/digits, upper-case. Invalid entries are dropped. */
export function normalizeTeamKeys(keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const u = k.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9]{0,7}$/.test(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/** "HOME, ENG" or "HOME ENG" (comma- or whitespace-separated); `dropped` lists what normalizeTeamKeys
 *  rejected so the settings editor can say so instead of silently saving fewer keys. */
export function splitTeamKeys(input: string): { kept: string[]; dropped: string[] } {
  const entered = input.split(/[,\s]+/).filter(Boolean);
  const kept = normalizeTeamKeys(entered);
  const dropped = entered.filter((k) => !kept.includes(k.toUpperCase()));
  return { kept, dropped };
}

/** A bare slug or any linear.app URL ("https://linear.app/acme/issue/…", "linear.app/acme", with or
 *  without www/scheme) → "acme"; "" = detect from the page; null = not a slug (letters, digits, dashes). */
export function normalizeSlug(input: string): string | null {
  const raw = input.trim().replace(/^(https?:\/\/)?(www\.)?linear\.app\//i, '').split(/[/?#]/)[0] ?? '';
  return !raw || /^[a-z0-9][a-z0-9-]*$/i.test(raw) ? raw.toLowerCase() : null;
}

/** {"XS": 30, "m": "90"} → {XS: 30, M: 90}; entries without a positive minute value are dropped.
 *  null = not a JSON object at all (a number, an array, …). */
export function parseDurations(o: unknown): Record<string, number> | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const d: Record<string, number> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const n = Number(v);
    if (k && Number.isFinite(n) && n > 0) d[k.toUpperCase()] = Math.round(n);
  }
  return d;
}

export async function loadSettings(store: Store): Promise<Settings> {
  return parseSettings(await store.get(SETTINGS_KEY));
}

export async function saveSettings(store: Store, s: Settings): Promise<void> {
  await store.set(SETTINGS_KEY, JSON.stringify(s));
}

/** Prompt-based settings editor (no UI framework). Returns the new settings, or null if cancelled or
 *  if an answer was invalid (then nothing is saved and a toast says why). */
export async function editSettings(store: Store, current: Settings): Promise<Settings | null> {
  const keys = window.prompt('Linear team keys, comma- or space-separated (empty = detect from the page):', current.teamKeys.join(', '));
  if (keys === null) return null;
  const { kept, dropped } = splitTeamKeys(keys);
  const slug = window.prompt('Linear workspace slug (the part after linear.app/, or paste any linear.app URL; empty = detect):', current.workspaceSlug);
  if (slug === null) return null;
  const ws = normalizeSlug(slug);
  if (ws === null) { toast(`"${slug.trim()}" is not a Linear workspace slug (letters, digits, dashes); settings unchanged`, 6000); return null; }
  const project = window.prompt('Linear project for issues created from calendar events (empty = none):', current.projectName);
  if (project === null) return null;
  const durations = window.prompt(
    'Block length per estimate, as JSON minutes:',
    JSON.stringify(current.durationByEstimate),
  );
  if (durations === null) return null;
  let dur: unknown;
  try { dur = JSON.parse(durations); } catch { toast('Durations: not valid JSON (use {"XS":30,"S":60,...}); settings unchanged', 6000); return null; }
  const d = parseDurations(dur);
  if (!d) { toast('Durations must be a JSON object like {"XS":30,"S":60}; settings unchanged', 6000); return null; }
  if (!Object.keys(d).length) { toast('Durations: no valid minute values; settings unchanged', 6000); return null; }
  const group = window.prompt('Linear label group for energy values (⚡ badge on calendar events; empty = off):', current.energyGroup);
  if (group === null) return null;
  // Toasted after the last prompt: timers do not run while a prompt is open, so an earlier toast could vanish unseen.
  if (dropped.length) toast(`Ignored team keys: ${dropped.join(', ')} (letters/digits, max 8)`, 6000);
  const next: Settings = { ...current, teamKeys: kept, workspaceSlug: ws, projectName: project.trim(), durationByEstimate: d, energyGroup: group.trim() };
  await saveSettings(store, next);
  return next;
}

export function registerMenu(label: string, fn: () => void): void {
  if (typeof GM_registerMenuCommand === 'function') {
    try { GM_registerMenuCommand(label, fn); } catch { /* not in a userscript manager */ }
    return;
  }
  const gm = gmApi();
  if (gm && typeof gm.registerMenuCommand === 'function') {
    try { gm.registerMenuCommand(label, fn); } catch { /* Greasemonkey 4 < 4.11 */ }
  }
}

// ---- Linear identifiers -------------------------------------------------------------------------

/** Regex matching an issue identifier of one of the given teams, e.g. HOME-24 (word-bounded). */
export function issueIdRegex(teamKeys: readonly string[]): RegExp | null {
  const keys = normalizeTeamKeys([...teamKeys]);
  if (!keys.length) return null;
  return new RegExp('\\b((?:' + keys.join('|') + ')-\\d+)\\b');
}

/** Accept "HOME-26", "home-26", a bare number (needs a default team), a pasted issue URL, or a UUID. */
export function normalizeIssueId(answer: string, teamKeys: readonly string[]): string | null {
  const s = answer.trim();
  if (!s) return null;
  const defaultTeam = normalizeTeamKeys([...teamKeys])[0];
  if (/^\d+$/.test(s)) return defaultTeam ? `${defaultTeam}-${s}` : null;
  const u = s.match(/\/issue\/([A-Za-z][A-Za-z0-9]{0,7}-\d+)/);
  if (u && u[1]) return u[1].toUpperCase();
  const generic = s.toUpperCase().match(/^([A-Z][A-Z0-9]{0,7}-\d+)$/);
  if (generic && generic[1]) return generic[1];
  return s; // UUIDs pass through with case intact
}

// ---- Google Calendar "new event" URL ---------------------------------------------------------------

export function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
}

export function nextHalfHour(now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d;
}

export interface BlockSpec {
  title: string;
  details: string;
  start: Date;
  minutes: number;
}

export function calendarTemplateUrl(spec: BlockSpec): string {
  const end = new Date(spec.start.getTime() + Math.max(5, spec.minutes) * 60000);
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: spec.title,
    details: spec.details,
    dates: `${fmtLocal(spec.start)}/${fmtLocal(end)}`,
    // fmtLocal() emits wall-clock times; pin them to the browser's zone so Google does not
    // reinterpret them in the calendar's configured zone.
    ctz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

export function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener');
}

// ---- UI helpers ---------------------------------------------------------------------------------

export function toast(msg: string, ms = 4000): void {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: '2147483647',
    background: '#222', color: '#fff', padding: '10px 16px', borderRadius: '8px',
    font: '500 13px system-ui', boxShadow: '0 2px 12px #0006', maxWidth: '70vw',
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Fire-and-forget with a visible failure: a storage or network error surfaces as a toast instead of
 *  an unhandled rejection that leaves a click doing nothing. */
export function run(p: Promise<unknown>): void {
  p.catch((e: unknown) => toast(`Task → Calendar block: ${e instanceof Error ? e.message : String(e)}`, 6000));
}

/** Stop pointer/mouse/click events from reaching the host app (drag handles, row click targets). */
export function isolateClicks(el: HTMLElement, types: readonly string[] = ['pointerdown', 'mousedown', 'click']): void {
  for (const t of types) el.addEventListener(t, (e) => e.stopPropagation());
}

/** Leaf element (no element children) whose trimmed text equals `text`. */
export function leafWithText(selector: string, text: string, root: ParentNode = document): HTMLElement | null {
  for (const n of root.querySelectorAll<HTMLElement>(selector)) {
    if (n.children.length === 0 && (n.textContent || '').trim() === text) return n;
  }
  return null;
}

// ---- energy labels ------------------------------------------------------------------------------

/** Parse a label name such as "-5", "+2", "0", "−3" (Unicode minus) into a number; null if not a value. */
export function energyValue(name: string): number | null {
  const m = name.trim().replace(/[−–]/g, '-').match(/^([+-]?)(\d{1,2})$/);
  if (!m) return null;
  const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  return n >= -10 && n <= 10 ? n : null;
}

/** Display form: "+2", "−3" (Unicode minus, matches the label names), "0". */
export function energyText(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}

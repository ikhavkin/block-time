// Reclaim Planner (app.reclaim.ai):
//  1. "📅 Block" on every task row (Linear, Google Tasks, Todoist, Reclaim) → prefilled Google Calendar event.
//  2. "↗" on calendar events that belong to a task, resolved from the title ("HOME-24 …") or from the
//     event description via Reclaim's own API (GET only; cookie-authenticated like the app itself).
//  3. "＋" (on hover) on events without a task link → link an existing Linear issue or create one via
//     Linear's GraphQL API with a personal API key. Reclaim's API refuses PATCH/PUT from the browser,
//     so the event itself is not edited: the calendar link is attached on the Linear side and the
//     mapping is remembered locally for the "↗".
// main() is exported and started from reclaim.entry.ts.
import {
  calendarTemplateUrl, editSettings, isolateClicks, issueIdRegex, loadSettings, makeStore,
  energyText, energyValue, nextHalfHour, normalizeIssueId, normalizeTeamKeys, openInNewTab, parseSettings,
  registerMenu, run, toast, type Settings,
} from './shared.ts';

const ROW = '[class*="TaskListItem_root"]';
const TITLE = '[class*="TaskListItem_task__title"]';
const SUFFIX = '[class*="linkSuffix"]';
// Grouped views: text buttons ("Mark Done", "Start Task") inside metadata__left--actions;
// list views: icon-only buttons directly inside metadata__left. Match both.
const ACTIONS = '[class*="metadata__left"]';
const CHIP = '[data-event-key]';
const CHIP_HEADER = '[class*="CalendarEventDetails_content__header"]';
const ROW_BTN = 'tcb-block-btn';
const LINK_CLASS = 'tcb-ev-link';
const ADD_CLASS = 'tcb-ev-add';
const ENERGY_CLASS = 'tcb-ev-energy';
const ENERGY_MENU = 'tcb-ev-energy-menu';
const STORE_KEY = 'tcb-ev-links-v2';      // sessionStorage: seriesKey -> url | null (per tab; API answers)
const DURABLE_KEY = 'tcb-ev-links';       // script/extension storage: seriesKey -> url (links made with ＋, or found on the issue)
const ATTACH_MISS_KEY = 'tcb-ev-attach-miss';   // seriesKey -> ms timestamp of the last "no attachment" answer
const ATTACH_TTL = 24 * 3600 * 1000;
const API_KEY = 'tcb-linear-api-key';
const RECLAIM_API = 'https://api.app.reclaim.ai/api';
const LINEAR_GQL = 'https://api.linear.app/graphql';
// Reclaim returns descriptions as Markdown ("[url](url)"), so brackets and parens end a URL too.
const URL_RE = /https:\/\/(?:linear\.app|tasks\.google\.com|(?:app\.)?todoist\.com)\/[^\s"'<>()[\]\\]+/;

// ---- pure helpers (exported for tests) ----------------------------------------------------------

export function rowTitle(row: Element): string | null {
  const t = row.querySelector(TITLE);
  if (!t) return null;
  const suffix = row.querySelector(SUFFIX);
  const parts = [(t.textContent || '').trim()];
  // Reclaim wraps the last word of the title in a separate span carrying the external-link icon.
  if (suffix && !t.contains(suffix)) parts.push((suffix.textContent || '').trim());
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

/** List views show "Ready to start • Due Sep 21 • 4h" / "• 30m"; grouped views show nothing. Only a
 *  •/newline-delimited segment that is nothing but a duration counts, so a title containing "2h"
 *  cannot override the real one. Callers pass innerText: it inserts the line breaks between the
 *  title, actions and metadata blocks, whereas textContent glues "…📅4h" together. */
export function minutesFromText(text: string, fallback: number): number {
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

export function sourceLabel(href: string): string {
  if (!href) return 'Reclaim task';
  if (href.includes('linear.app')) return 'Linear';
  if (href.includes('tasks.google.com')) return 'Google Tasks';
  if (href.includes('todoist.com')) return 'Todoist';
  return 'Task';
}

/** Recurring instances look like "<cal>/<seriesId>_20260917T060000Z" (timed) or "<cal>/<seriesId>_20260917"
 *  (all-day); one lookup per series. */
export function seriesKey(key: string): string {
  return key.replace(/_\d{8}(?:T\d{6}Z)?$/, '');
}

export function linkLabel(url: string): string {
  if (url.includes('linear.app')) return 'Open in Linear';
  if (url.includes('tasks.google.com')) return 'Open in Google Tasks';
  return 'Open in Todoist';
}

/** Team keys visible on the page, from linear.app issue links only. Row titles are not used: a
 *  Google task called "FLU-19: book booster" would otherwise register FLU as a team. */
export function detectTeamKeys(root: ParentNode = document): string[] {
  const found: string[] = [];
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href^="https://linear.app/"]')) {
    const m = a.href.match(/\/issue\/([A-Za-z][A-Za-z0-9]{0,7})-\d+/);
    if (m && m[1]) found.push(m[1]);
  }
  return normalizeTeamKeys(found);
}

/** Workspace slug from the first linear.app *issue* link (other linear.app links are skipped). */
export function detectWorkspaceSlug(root: ParentNode = document): string {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href^="https://linear.app/"]')) {
    const m = a.href.match(/^https:\/\/linear\.app\/([^/]+)\/issue\//);
    if (m && m[1]) return m[1];
  }
  return '';
}

const transient = (status: number): boolean => status === 401 || status === 408 || status === 429 || status >= 500;

// ---- main ---------------------------------------------------------------------------------------

export function main(): void {
  // A userscript and the extension are separate JS worlds sharing one DOM, so a DOM attribute (not a
  // window flag) lets the first copy own the page (its pollers, its settings store).
  const html = document.documentElement;
  if (html.dataset['tcbReclaim']) { console.info('task-calendar-block: another copy is already active on this page'); return; }
  html.dataset['tcbReclaim'] = '1';

  const store = makeStore();
  let settings: Settings | null = null;
  const getSettings = async (): Promise<Settings> => {
    if (settings) return settings;
    try { settings = await loadSettings(store); } catch { return parseSettings(null); }   // storage unavailable: defaults, not cached
    return settings;
  };
  const teamKeys = (s: Settings): string[] => (s.teamKeys.length ? s.teamKeys : detectTeamKeys());
  const slug = (s: Settings): string => s.workspaceSlug || detectWorkspaceSlug();

  async function openSettings(): Promise<void> {
    const next = await editSettings(store, await getSettings());
    if (next) { settings = next; forgetLinks(); toast('Settings saved'); }
  }
  registerMenu('Task → Calendar block: settings…', () => run(openSettings()));
  registerMenu('Task → Calendar block: forget Linear API key', () => run(forgetApiKey()));

  // ---- 1. row buttons ---------------------------------------------------------------------------
  function mountRows(): void {
    for (const row of document.querySelectorAll<HTMLElement>(ROW)) {
      if (row.querySelector('.' + ROW_BTN)) continue;
      const actions = row.querySelector(ACTIONS);
      if (!actions) continue;
      const buttons = [...actions.querySelectorAll('button')];
      const ref = buttons.find((b) => (b.textContent || '').trim() === 'Start Task') ?? buttons[buttons.length - 1];
      const iconMode = !buttons.some((b) => (b.textContent || '').trim());
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = ROW_BTN;
      btn.textContent = iconMode ? '📅' : '📅 Block';
      btn.title = 'Open a prefilled Google Calendar event for this task. Shift+click: settings';
      Object.assign(btn.style, {
        font: ref ? getComputedStyle(ref).font : '500 13px Poppins, system-ui',
        padding: ref ? getComputedStyle(ref).padding : '4px 8px',
        color: 'inherit', background: 'transparent', border: 'none', cursor: 'pointer', opacity: '0.85',
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) { run(openSettings()); return; }
        run((async () => {
          const s = await getSettings();
          const title = rowTitle(row);
          if (!title) return;
          const a = row.querySelector<HTMLAnchorElement>('a[href]');
          const href = a ? a.href : '';
          openInNewTab(calendarTemplateUrl({
            title,
            details: `${sourceLabel(href)}: ${title}${href ? '\n' + href : ''}`,
            start: nextHalfHour(),
            // innerText keeps the block boundaries as line breaks (see minutesFromText); textContent
            // would glue the title, "📅" and "4h" into one segment.
            minutes: minutesFromText(row.innerText || row.textContent || '', s.defaultMinutes),
          }));
        })());
      });
      actions.appendChild(btn);
    }
  }
  setInterval(mountRows, 700);

  // ---- 2. event → task links --------------------------------------------------------------------
  let stored: Record<string, string | null> = {};
  try { stored = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}') as Record<string, string | null>; } catch { /* ignore */ }
  const cache = new Map<string, Promise<string | null>>();
  const retryAt = new Map<string, { n: number; t: number }>();
  // Links that must survive the tab: made with "＋" here, or found as a calendar attachment on the
  // Linear issue (which "＋" creates, so other devices can rediscover the link). Reclaim's API refuses
  // to write the link into the event itself, hence this side table.
  let durable: Record<string, string> = {};
  let attachMiss: Record<string, number> = {};
  const parseMap = <T,>(raw: string | null, ok: (v: unknown) => v is T): Record<string, T> => {
    try {
      const o: unknown = JSON.parse(raw || '{}');
      const out: Record<string, T> = {};
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (ok(v)) out[k] = v;
      return out;
    } catch { return {}; }
  };
  const durableReady: Promise<void> = (async () => {
    durable = parseMap(await store.get(DURABLE_KEY).catch(() => null), (v): v is string => typeof v === 'string' && v.startsWith('https://'));
    attachMiss = parseMap(await store.get(ATTACH_MISS_KEY).catch(() => null), (v): v is number => typeof v === 'number');
  })();
  function rememberDurable(k: string, url: string): void {
    durable[k] = url;
    remember(k, url);
    run(store.set(DURABLE_KEY, JSON.stringify(durable)));
  }

  function remember(k: string, url: string | null): string | null {
    stored[k] = url;
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(stored)); } catch { /* ignore */ }
    return url;
  }

  /** Settings changed: title-derived links (slug, team keys) and "no link" answers may differ now, so
   *  forget everything and resolve again (one GET per visible series, same as a fresh tab). */
  function forgetLinks(): void {
    stored = {};
    try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    cache.clear();
    retryAt.clear();
    attachMiss = {};                 // durable links stay: they were made by hand, not derived from settings
    run(store.remove(ATTACH_MISS_KEY));
    for (const chip of document.querySelectorAll<HTMLElement>(CHIP)) {
      chip.querySelectorAll('.' + LINK_CLASS + ', .' + ADD_CLASS).forEach((n) => n.remove());
      delete chip.dataset['tcbSeen'];
      delete chip.dataset['tcbAdd'];
    }
    forgetEnergy();   // hoisted; only ever runs after main() finished, so section-4 state is initialised
  }

  function chipTitle(chip: Element): string {
    return ((chip.querySelector(CHIP_HEADER) || chip).textContent || '').trim();
  }

  async function resolveLink(chip: Element): Promise<string | null> {
    const key = chip.getAttribute('data-event-key');
    if (!key) return null;
    const k = seriesKey(key);
    if (k in stored) return stored[k] ?? null;
    const inflight = cache.get(k);
    if (inflight) return inflight;
    const s = await getSettings();
    await durableReady;
    // The awaits yielded (even with settings cached): a sibling instance of the same series may have
    // registered the lookup meanwhile. Without this, N instances mean N GETs and N backoff bumps.
    if (k in stored) return stored[k] ?? null;
    const again = cache.get(k);
    if (again) return again;
    const kept = durable[k];
    if (kept) return remember(k, kept);
    const idRe = issueIdRegex(teamKeys(s));
    const idMatch = idRe ? chipTitle(chip).match(idRe) : null;
    let p: Promise<string | null>;
    if (idMatch && idMatch[1] && slug(s)) {
      p = Promise.resolve(remember(k, `https://linear.app/${slug(s)}/issue/${idMatch[1]}`));
    } else {
      const [cal, ...rest] = key.split('/');
      const url = `${RECLAIM_API}/events/${cal}/${encodeURIComponent(rest.join('/'))}`;
      // Only definitive answers are remembered: 2xx (with or without a task URL) and 403/404/other 4xx.
      // Transient statuses and network errors back off exponentially (5 s … 5 min) and retry.
      p = fetch(url, { credentials: 'include' })
        .then((r) => {
          if (r.ok) return r.text();
          if (transient(r.status)) throw new Error('transient ' + r.status);
          return '';
        })
        .then((body) => {
          retryAt.delete(k);
          const m = body.match(URL_RE);
          return remember(k, m ? m[0] : null);
        })
        .catch(() => {
          cache.delete(k);
          const n = (retryAt.get(k)?.n ?? 0) + 1;
          retryAt.set(k, { n, t: Date.now() + Math.min(300000, 5000 * 2 ** (n - 1)) });
          return null;
        });
    }
    cache.set(k, p);
    return p;
  }

  function decorate(chip: HTMLElement, url: string): void {
    if (chip.querySelector('.' + LINK_CLASS)) return;
    const a = document.createElement('a');
    a.className = LINK_CLASS;
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '↗';
    a.title = linkLabel(url);
    Object.assign(a.style, {
      position: 'absolute', top: '1px', right: '3px', zIndex: '5', lineHeight: '14px',
      font: '700 11px system-ui', textDecoration: 'none', color: 'inherit',
      background: 'rgba(255,255,255,0.75)', borderRadius: '4px', padding: '0 4px', opacity: '0.9',
    });
    isolateClicks(a);   // no drag start, no event popover
    if (getComputedStyle(chip).position === 'static') chip.style.position = 'relative';
    chip.appendChild(a);
    mountEnergy(chip, url);
  }

  function mountEventLinks(): void {
    for (const chip of document.querySelectorAll<HTMLElement>(CHIP)) {
      if (chip.dataset['tcbSeen']) continue;
      const k = seriesKey(chip.getAttribute('data-event-key') || '');
      const r = retryAt.get(k);
      if (r && Date.now() < r.t) continue;   // inside the backoff window; revisit on a later tick
      chip.dataset['tcbSeen'] = '1';
      void resolveLink(chip)
        .then((url) => {
          if (url) decorate(chip, url);
          else if (k && !(k in stored)) delete chip.dataset['tcbSeen'];   // transient failure: retry later
          else if (k) void discoverAttachment(chip, k);
        })
        .catch(() => { delete chip.dataset['tcbSeen']; });   // e.g. settings load failed: revisit, do not toast every tick
    }
  }
  setInterval(mountEventLinks, 1000);

  // ---- 3. "＋": link or create a Linear issue ----------------------------------------------------
  const pending = new Set<string>();
  let credentialId: string | null = null;

  const style = document.createElement('style');
  style.textContent = `.${ADD_CLASS}{opacity:0;transition:opacity .15s}${CHIP}:hover .${ADD_CLASS}{opacity:.95}`;
  document.head.appendChild(style);

  async function forgetApiKey(): Promise<void> {
    await store.remove(API_KEY);
    toast('Linear API key forgotten; the next "＋" asks for one');
  }

  /** `interactive = false`: never prompt (background reads); null when no key is stored. */
  async function apiKey(interactive = true): Promise<string | null> {
    let k = await store.get(API_KEY);
    if (!k) {
      if (!interactive) return null;
      const where = store.kind === 'extension'
        ? 'Kept in the extension\'s own storage (chrome.storage.local).'
        : store.kind === 'gm'
          ? 'Kept in the script manager\'s private storage.'
          : 'Note: without a userscript manager or extension it is kept in app.reclaim.ai localStorage, readable by Reclaim\'s own scripts.';
      k = (window.prompt(`Linear personal API key (Linear → Settings → Security & access → Personal API keys). ${where} Shift+click "＋" forgets it.`) || '').trim();
      if (!k) return null;
      // Linear keys are printable ASCII; a zero-width space or smart quote from a chat app would make
      // the Authorization header throw before Linear can answer 401 (and the key would never be cleared).
      if (!/^[\x21-\x7e]+$/.test(k)) { toast('That does not look like a Linear API key (ASCII, no spaces or line breaks); nothing saved', 6000); return null; }
      await store.set(API_KEY, k);
    }
    return k;
  }

  interface GqlError { message: string; extensions?: { type?: string } }
  async function gql<T>(query: string, variables: Record<string, unknown>, opts: { interactive?: boolean } = {}): Promise<T> {
    const key = await apiKey(opts.interactive !== false);
    if (!key) throw new Error('No Linear API key');
    const r = await fetch(LINEAR_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({ query, variables }),
    });
    const rejected = async (): Promise<never> => {
      try { await store.remove(API_KEY); } catch { /* ignore */ }
      throw new Error('Linear rejected the API key; it was cleared, try again');
    };
    // Linear answers every auth failure with 401 (+ extensions.type 'authentication error' in the JSON
    // body); check the status before parsing so a non-JSON 401 also clears the key.
    if (r.status === 401) return rejected();
    const text = await r.text();
    let j: { data?: T; errors?: GqlError[]; error?: unknown } | null = null;
    try { j = JSON.parse(text); } catch { /* non-JSON body (edge/outage page) */ }
    if (!j || typeof j !== 'object') throw new Error(`Linear HTTP ${r.status}`);
    const errs = Array.isArray(j.errors) ? j.errors : [];
    if (errs.some((e) => e.extensions?.type === 'authentication error')) return rejected();
    if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
    if (j.error) throw new Error(String(j.error));  // Linear's non-GraphQL 400 shape {error, code}
    if (!j.data) throw new Error('Linear returned no data');
    return j.data;
  }

  interface EventInfo { key: string; title: string; when: Date | null; htmlLink: string | null }
  /** The Google Calendar link of an event (what "＋" attaches to the issue); null when unavailable. */
  async function calendarLink(cal: string, id: string): Promise<string | null> {
    try {
      if (!credentialId) {
        const me = await fetch(`${RECLAIM_API}/users/current`, { credentials: 'include' }).then((r) => r.text());
        const m = me.match(/"credentialId":(\d+)/);
        credentialId = m && m[1] ? m[1] : null;
      }
      if (!credentialId) return null;
      const raw = await fetch(`${RECLAIM_API}/events/raw-google/${credentialId}/${cal}/${encodeURIComponent(id)}`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() as Promise<{ rawData?: { htmlLink?: string } }> : null));
      return raw?.rawData?.htmlLink ?? null;
    } catch { return null; }
  }

  const attachPending = new Set<string>();
  /** An event with no link in its title/description may still be attached to a Linear issue (that is
   *  what "＋" does). Ask Linear for attachments of the event's calendar URL, once per series per day,
   *  only when a key is already stored (never prompts), and remember a hit durably. */
  async function discoverAttachment(chip: HTMLElement, k: string): Promise<void> {
    await durableReady;
    if (durable[k] || attachPending.has(k)) return;
    const miss = attachMiss[k];
    if (miss !== undefined && Date.now() - miss < ATTACH_TTL) return;
    if (!(await store.get(API_KEY).catch(() => null))) return;
    attachPending.add(k);
    try {
      const key = chip.getAttribute('data-event-key') || '';
      const [cal = '', ...rest] = key.split('/');
      const link = await calendarLink(cal, rest.join('/'));
      if (!link) return;
      const d = await gql<{ attachmentsForURL: { nodes: { issue: { url: string } | null }[] } }>(
        'query($url:String!){ attachmentsForURL(url:$url, first:5){ nodes{ issue{ url } } } }', { url: link }, { interactive: false });
      const url = d.attachmentsForURL.nodes.map((n) => n.issue?.url).find((u): u is string => typeof u === 'string' && u.startsWith('https://')) ?? null;
      if (url) {
        rememberDurable(k, url);
        for (const c of document.querySelectorAll<HTMLElement>(CHIP)) {
          if (seriesKey(c.getAttribute('data-event-key') || '') !== k) continue;
          c.querySelectorAll('.' + ADD_CLASS).forEach((n) => n.remove());
          decorate(c, url);
        }
      } else {
        attachMiss[k] = Date.now();
        void store.set(ATTACH_MISS_KEY, JSON.stringify(attachMiss)).catch(() => undefined);
      }
    } catch {
      attachMiss[k] = Date.now() - ATTACH_TTL + 5 * 60 * 1000;   // transient: try again in five minutes
    } finally {
      attachPending.delete(k);
    }
  }

  async function eventInfo(chip: Element): Promise<EventInfo> {
    const key = chip.getAttribute('data-event-key') || '';
    const [cal = '', ...rest] = key.split('/');
    const id = rest.join('/');
    const ev = await fetch(`${RECLAIM_API}/events/${cal}/${encodeURIComponent(id)}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() as Promise<{ title?: string; eventStart?: string }> : null)).catch(() => null);
    const htmlLink = await calendarLink(cal, id);
    const title = ev?.title || chipTitle(chip);
    const when = ev?.eventStart ? new Date(ev.eventStart) : null;
    return { key, title, when, htmlLink };
  }

  interface Issue { id: string; identifier: string; url: string; title: string }
  /** `attached`: true = calendar link attached to the issue, false = the attachment failed, null = no
   *  calendar link was available (raw-google lookup failed), so the toast can say what really happened. */
  async function linkOrCreate(chip: Element, issueId: string | null): Promise<{ issue: Issue; attached: boolean | null }> {
    const s = await getSettings();
    const info = await eventInfo(chip);
    let issue: Issue | undefined;
    if (issueId) {
      const d = await gql<{ issue: Issue | null }>('query($id:String!){ issue(id:$id){ id identifier url title } }', { id: issueId });
      if (!d.issue) throw new Error(`Issue ${issueId} not found`);
      issue = d.issue;
    } else {
      const team = teamKeys(s)[0];
      if (!team) throw new Error('No Linear team key known: set one in settings (Shift+click 📅 Block)');
      interface Meta {
        teams: { nodes: { id: string; activeCycle: { id: string; startsAt: string; endsAt: string } | null }[] };
        projects: { nodes: { id: string }[] };
        viewer: { id: string };
      }
      const meta = await gql<Meta>(`query($team:String!,$project:String!,$withProject:Boolean!){
        teams(filter:{key:{eq:$team}}){ nodes{ id activeCycle{ id startsAt endsAt } } }
        projects(filter:{name:{eq:$project}}) @include(if:$withProject){ nodes{ id } }
        viewer{ id } }`, { team, project: s.projectName || '-', withProject: Boolean(s.projectName) });
      const t = meta.teams.nodes[0];
      if (!t) throw new Error(`Linear team ${team} not found`);
      const input: Record<string, unknown> = { teamId: t.id, title: info.title, priority: 3, assigneeId: meta.viewer.id };
      // Active cycle only when the block falls inside its window (next week's block stays out of this week's cycle).
      const cyc = t.activeCycle;
      if (cyc && (!info.when || (info.when >= new Date(cyc.startsAt) && info.when < new Date(cyc.endsAt)))) input['cycleId'] = cyc.id;
      const project = meta.projects?.nodes[0];
      if (project) input['projectId'] = project.id;
      if (info.when) input['description'] = `Calendar block: ${info.when.toLocaleString()}`;
      const d = await gql<{ issueCreate: { success: boolean; issue: Issue | null } }>(
        'mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier url title } } }', { input });
      if (!d.issueCreate.issue) throw new Error('Linear did not create the issue');
      issue = d.issueCreate.issue;
    }
    let attached: boolean | null = null;
    if (info.htmlLink) {
      const label = `Calendar: ${info.title}${info.when ? ', ' + info.when.toLocaleString() : ''}`;
      attached = await gql('mutation($issueId:String!,$url:String!,$title:String!){ attachmentLinkURL(issueId:$issueId,url:$url,title:$title){ success } }',
        { issueId: issue.id, url: info.htmlLink, title: label }).then(() => true).catch(() => false);
    }
    const sk = seriesKey(info.key);
    rememberDurable(sk, issue.url);
    // Update every live chip of this series (re-rendered replacements, sibling recurring instances).
    for (const c of document.querySelectorAll<HTMLElement>(CHIP)) {
      if (seriesKey(c.getAttribute('data-event-key') || '') !== sk) continue;
      c.querySelectorAll('.' + ADD_CLASS).forEach((n) => n.remove());
      decorate(c, issue.url);
    }
    return { issue, attached };
  }

  function addButton(chip: HTMLElement): void {
    if (chip.querySelector('.' + ADD_CLASS) || chip.querySelector('.' + LINK_CLASS)) return;
    if (pending.has(seriesKey(chip.getAttribute('data-event-key') || ''))) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = ADD_CLASS;
    b.textContent = '＋';
    b.title = 'Link or create a Linear issue for this event. Shift+click: forget the stored API key';
    Object.assign(b.style, {
      position: 'absolute', top: '1px', right: '3px', zIndex: '5', lineHeight: '14px', border: 'none',
      font: '700 12px system-ui', color: 'inherit', background: 'rgba(255,255,255,0.75)',
      borderRadius: '4px', padding: '0 4px', cursor: 'pointer',
    });
    isolateClicks(b, ['pointerdown', 'mousedown']);
    b.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (e.shiftKey) { run(forgetApiKey()); return; }   // the only way to replace a wrong key that Linear does not answer with 401
      const k = seriesKey(chip.getAttribute('data-event-key') || '');
      if (pending.has(k)) return;                        // already in flight for this series
      const cur = stored[k];
      if (cur) { b.remove(); decorate(chip, cur); return; }   // linked meanwhile (e.g. via a sibling instance)
      run((async () => {
        const s = await getSettings();
        const keys = teamKeys(s);
        const example = keys[0] ? `${keys[0]}-26` : 'ABC-26';
        const answer = window.prompt(`Linear issue ID to link (e.g. ${example}), or leave empty to create a new issue titled:\n"${chipTitle(chip)}"`, '');
        if (answer === null) return;
        const id = normalizeIssueId(answer, keys);
        if (answer.trim() && !id) { toast('Enter a full issue ID like ABC-26 (no default team is known)'); return; }
        pending.add(k);
        b.textContent = '…';
        try {
          const { issue, attached } = await linkOrCreate(chip, id);
          const note = attached === false ? ' (calendar link NOT attached)' : attached === null ? ' (no calendar link available)' : '';
          toast(`${id ? 'Linked' : 'Created'} ${issue.identifier} ${issue.title}${note}`);
        } catch (err) {
          b.textContent = '＋';
          toast(`Linear: ${err instanceof Error ? err.message : String(err)}`, 6000);
        } finally {
          pending.delete(k);
        }
      })());
    });
    if (getComputedStyle(chip).position === 'static') chip.style.position = 'relative';
    chip.appendChild(b);
  }

  // ---- 4. "⚡" energy badge on Linear-linked events ---------------------------------------------
  // Shows the issue's label from the configured label group (e.g. "Energy Δ": −5 … +5) and lets you set
  // it from the calendar. Reads only when an API key is already stored (no surprise prompts on load);
  // clicking the badge asks for the key if needed.
  interface EnergyLabel { id: string; name: string; value: number }
  /** `groupLabelIds`: the issue's labels from the configured group only (normally one). Labels outside
   *  the group are never read into the cache, so a write can never drop them. */
  interface IssueLabels { id: string; groupLabelIds: string[]; value: number | null }
  let groupLabels: { group: string; p: Promise<EnergyLabel[]> } | null = null;
  const issueCache = new Map<string, Promise<IssueLabels | null>>();   // identifier -> labels
  const energyRetryAt = new Map<string, { n: number; t: number }>();   // identifier -> background-read backoff
  const ISSUE_URL_RE = /linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]{0,7}-\d+)/;

  const energyStyle = document.createElement('style');
  energyStyle.textContent = `.${ENERGY_MENU}{position:fixed;z-index:2147483647;display:flex;gap:2px;padding:4px;border-radius:8px;background:#fff;box-shadow:0 2px 12px #0005}` +
    `.${ENERGY_MENU} button{border:1px solid #8884;border-radius:6px;background:#fff;font:600 12px system-ui;padding:2px 6px;cursor:pointer;color:#222}` +
    `.${ENERGY_MENU} button:hover{background:#eee}`;
  document.head.appendChild(energyStyle);

  function loadGroupLabels(group: string): Promise<EnergyLabel[]> {
    if (!groupLabels || groupLabels.group !== group) {
      const p: Promise<EnergyLabel[]> = gql<{ issueLabels: { nodes: { id: string; name: string }[] } }>(
        'query($group:String!){ issueLabels(filter:{parent:{name:{eq:$group}}}, first:50){ nodes{ id name } } }', { group })
        .then((d) => d.issueLabels.nodes
          .map((l) => ({ id: l.id, name: l.name, value: energyValue(l.name) }))
          .filter((l): l is EnergyLabel => l.value !== null)
          .sort((a, b) => a.value - b.value))
        .catch((e: unknown) => { if (groupLabels?.p === p) groupLabels = null; throw e; });   // a stale failure must not null a newer group's entry
      groupLabels = { group, p };
    }
    return groupLabels.p;
  }

  function loadIssueLabels(identifier: string, group: string, interactive = true): Promise<IssueLabels | null> {
    let p = issueCache.get(identifier);
    if (!p) {
      p = gql<{ issue: { id: string; labels: { nodes: { id: string; name: string; parent: { name: string } | null }[] } } | null }>(
        'query($id:String!){ issue(id:$id){ id labels(first:50){ nodes{ id name parent{ name } } } } }', { id: identifier }, { interactive })
        .then((d) => {
          energyRetryAt.delete(identifier);
          if (!d.issue) return null;
          const mine = d.issue.labels.nodes.filter((l) => l.parent?.name === group);
          return { id: d.issue.id, groupLabelIds: mine.map((l) => l.id), value: mine[0] ? energyValue(mine[0].name) : null };
        })
        .catch((e: unknown) => {
          // Evict so a click retries at once, but back off the background reads (5 s … 5 min, like
          // resolveLink): chips re-render often and every new node would otherwise query again.
          issueCache.delete(identifier);
          const n = (energyRetryAt.get(identifier)?.n ?? 0) + 1;
          energyRetryAt.set(identifier, { n, t: Date.now() + Math.min(300000, 5000 * 2 ** (n - 1)) });
          throw e;
        });
      issueCache.set(identifier, p);
    }
    return p;
  }

  function paintBadge(b: HTMLElement, value: number | null): void {
    b.textContent = value === null ? '⚡' : `⚡${energyText(value)}`;
    b.style.opacity = value === null ? '0.6' : '1';
    b.title = value === null ? 'Set energy change for this task' : `Energy change ${energyText(value)} (click to change)`;
  }

  /** Updates to one issue run one after another: two quick picks would otherwise each compute a delta
   *  from the same base and leave the issue with two group labels. */
  const updating = new Map<string, Promise<unknown>>();
  function serial<T>(id: string, job: () => Promise<T>): Promise<T> {
    const next = (updating.get(id) ?? Promise.resolve()).catch(() => undefined).then(job);
    updating.set(id, next);
    return next;
  }

  function setEnergy(identifier: string, group: string, value: number): Promise<void> {
    return serial(identifier, async () => {
      // Fresh read, then a delta (addedLabelIds / removedLabelIds): issueUpdate's labelIds is the full
      // set, and a snapshot from page load would drop any label added in Linear since then.
      issueCache.delete(identifier);
      const [labels, current] = await Promise.all([loadGroupLabels(group), loadIssueLabels(identifier, group)]);
      if (!current) throw new Error(`Issue ${identifier} not found`);
      const target = labels.find((l) => l.value === value);
      if (!target) throw new Error(`No "${energyText(value)}" label in group ${group}`);
      const removedLabelIds = current.groupLabelIds.filter((id) => id !== target.id);
      await gql('mutation($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }',
        { id: current.id, input: { addedLabelIds: [target.id], removedLabelIds } });
      issueCache.set(identifier, Promise.resolve({ id: current.id, groupLabelIds: [target.id], value }));
    });
  }

  function closeMenus(): void { document.querySelectorAll('.' + ENERGY_MENU).forEach((m) => m.remove()); }

  /** Settings changed: the group name, and every cached value derived from it, may differ now. Badges
   *  are removed so decorate() mounts fresh ones for the new group (or none when it is empty). */
  function forgetEnergy(): void {
    groupLabels = null;
    issueCache.clear();
    energyRetryAt.clear();
    closeMenus();
    document.querySelectorAll('.' + ENERGY_CLASS).forEach((n) => n.remove());
  }
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.' + ENERGY_MENU)) closeMenus();
  }, true);
  // The menu is position:fixed, so it would stay put while the calendar grid scrolls under it.
  document.addEventListener('scroll', closeMenus, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); }, true);

  async function openPicker(chip: HTMLElement, badge: HTMLElement, identifier: string, group: string): Promise<void> {
    closeMenus();
    const labels = await loadGroupLabels(group);
    if (!labels.length) { toast(`Label group "${group}" has no numeric labels`); return; }
    const menu = document.createElement('div');
    menu.className = ENERGY_MENU;
    for (const l of labels) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = energyText(l.value);
      b.title = l.name;
      b.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        closeMenus();
        const prev = issueCache.get(identifier);   // before setEnergy evicts it
        paintBadge(badge, l.value);
        run(setEnergy(identifier, group, l.value).then(
          () => { for (const other of document.querySelectorAll<HTMLElement>(`.${ENERGY_CLASS}[data-issue="${identifier}"]`)) paintBadge(other, l.value); },
          (err: unknown) => {
            // The write failed, so the value Linear still holds is the fresh read (or the one from before the click).
            const back = issueCache.get(identifier) ?? prev ?? Promise.resolve(null);
            void back.then((c) => paintBadge(badge, c?.value ?? null), () => paintBadge(badge, null));
            throw err;
          },
        ));
      });
      menu.appendChild(b);
    }
    isolateClicks(menu);
    closeMenus();   // again: a second click during the label fetch above would otherwise leave two menus
    menu.style.position = 'fixed';
    document.body.appendChild(menu);
    // Measure the real box, then flip above the badge when it would run past the bottom edge and keep
    // it inside the right edge (a fixed element does not extend the scrollable area, so off-screen = lost).
    const r = badge.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const top = r.bottom + 4 + m.height > innerHeight ? r.top - 4 - m.height : r.bottom + 4;
    const left = Math.max(4, Math.min(r.right - m.width, innerWidth - m.width - 4));
    Object.assign(menu.style, { left: `${left}px`, top: `${Math.max(4, top)}px` });
  }

  function mountEnergy(chip: HTMLElement, url: string): void {
    const m = url.match(ISSUE_URL_RE);
    if (!m || !m[1] || chip.querySelector('.' + ENERGY_CLASS)) return;
    const identifier = m[1].toUpperCase();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = ENERGY_CLASS;
    b.dataset['issue'] = identifier;
    Object.assign(b.style, {
      position: 'absolute', top: '1px', right: '22px', zIndex: '5', lineHeight: '14px', border: 'none',
      font: '700 11px system-ui', color: 'inherit', background: 'rgba(255,255,255,0.75)',
      borderRadius: '4px', padding: '0 4px', cursor: 'pointer',
    });
    paintBadge(b, null);
    isolateClicks(b, ['pointerdown', 'mousedown']);
    b.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      run((async () => {
        const s = await getSettings();
        if (!s.energyGroup) { toast('Energy badge is off: set a label group in settings (Shift+click 📅 Block)'); return; }
        await openPicker(chip, b, identifier, s.energyGroup);
      })());
    });
    chip.appendChild(b);
    // Read the current value only when a key is already stored: no prompt on page load.
    run((async () => {
      const s = await getSettings();
      if (!s.energyGroup) { b.remove(); return; }
      const r = energyRetryAt.get(identifier);
      if (r && Date.now() < r.t) return;                  // recent failure: wait for the window, not the next re-render
      if (!(await store.get(API_KEY))) return;            // no key: no Linear traffic, and nothing recorded as a failure
      // Non-interactive: with chrome.storage a 401 from a sibling read can clear the key between the
      // check above and gql()'s own read, and that must not open the key prompt on page load.
      const cur = await loadIssueLabels(identifier, s.energyGroup, false).catch(() => null);
      if (cur) paintBadge(b, cur.value);
    })());
  }

  // Chips that resolved to "no link" get the "＋"; linked ones get "↗" (also covers re-rendered nodes).
  setInterval(() => {
    for (const chip of document.querySelectorAll<HTMLElement>(CHIP)) {
      if (chip.dataset['tcbAdd']) continue;
      const k = seriesKey(chip.getAttribute('data-event-key') || '');
      if (!(k in stored)) continue;          // not resolved yet
      if (pending.has(k)) continue;          // link/create in flight: revisit once it settles
      chip.dataset['tcbAdd'] = '1';
      const url = stored[k];
      if (url) decorate(chip, url); else addButton(chip);
    }
  }, 1200);
}

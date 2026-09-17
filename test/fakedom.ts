// A small fake DOM plus a vm context that runs the Reclaim script (src/reclaim.entry.ts, bundled
// in-process by esbuild, so the tests see the current sources rather than dist/) against a fake
// Planner page. It covers what the ↗ / ＋ / ⚡ code paths touch: querySelector with class, tag and
// attribute selectors, capture/bubble event dispatch, dataset, bounding boxes, timers, storage in
// both flavours (localStorage and a sequenced chrome.storage.local) and a stateful Linear GraphQL fake.
import vm from 'node:vm';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let bundled: Promise<string> | null = null;
/** The Reclaim entry bundle, built once per test process from the current sources. */
export function reclaimBundle(): Promise<string> {
  bundled ??= build({
    bundle: true, absWorkingDir: root, entryPoints: [join(root, 'src/reclaim.entry.ts')],
    format: 'iife', target: ['es2022'], write: false, logLevel: 'silent',
  }).then((r) => {
    const text = r.outputFiles?.[0]?.text;
    if (!text) throw new Error('esbuild produced no output');
    return text;
  });
  return bundled;
}

export interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface Listener { fn: (e: FakeEvent) => void; cap: boolean }
const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export class FakeElement {
  tagName: string;
  ownerDocument: FakeDocument | null;
  childNodes: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  className = '';
  id = '';
  title = '';
  href: string | undefined;
  /** Layout box for getBoundingClientRect(); the document's `defaultRect` applies when unset. */
  rect: Rect | null = null;
  private text = '';

  constructor(tag: string, doc: FakeDocument | null) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; }
  get children(): FakeElement[] { return this.childNodes; }
  get textContent(): string { return this.text + this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.childNodes = []; this.text = String(v); }
  get innerText(): string { return this.textContent; }
  getAttribute(n: string): string | null {
    if (n in this.attrs) return this.attrs[n] ?? null;
    if (n.startsWith('data-')) { const k = camel(n.slice(5)); return k in this.dataset ? String(this.dataset[k]) : null; }
    if (n === 'class') return this.className;
    if (n === 'id') return this.id;
    if (n === 'href') return this.href ?? null;
    return null;
  }
  setAttribute(n: string, v: string): void { this.attrs[n] = String(v); }
  appendChild<T extends FakeElement>(c: T): T { c.remove(); c.parentNode = this; this.childNodes.push(c); return c; }
  remove(): void {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) this.parentNode.childNodes.splice(i, 1);
    this.parentNode = null;
  }
  contains(n: FakeElement | null): boolean { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(t: string, fn: (e: FakeEvent) => void, opts?: boolean | { capture?: boolean }): void {
    const cap = opts === true || (typeof opts === 'object' && Boolean(opts.capture));
    (this.listeners[t] ??= []).push({ fn, cap });
  }
  removeEventListener(): void { /* never needed by the scripts */ }
  *descendants(): Generator<FakeElement> { for (const c of this.childNodes) { yield c; yield* c.descendants(); } }
  querySelectorAll(sel: string): FakeElement[] { const m = compile(sel); return [...this.descendants()].filter(m); }
  querySelector(sel: string): FakeElement | null { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel: string): FakeElement | null {
    const m = compile(sel);
    for (let x: FakeElement | null = this; x; x = x.parentNode) if (m(x)) return x;
    return null;
  }
  getBoundingClientRect(): Rect {
    return this.rect ?? this.ownerDocument?.defaultRect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

export class FakeDocument extends FakeElement {
  head: FakeElement;
  body: FakeElement;
  documentElement: FakeElement;
  /** Box reported by every element without an explicit `rect` (the picker menu, for instance). */
  defaultRect: Rect = { left: 500, top: 100, right: 560, bottom: 120, width: 60, height: 20 };
  constructor() {
    super('#document', null);
    this.ownerDocument = this;
    this.documentElement = this.appendChild(new FakeElement('html', this));
    this.head = this.documentElement.appendChild(new FakeElement('head', this));
    this.body = this.documentElement.appendChild(new FakeElement('body', this));
  }
  createElement(tag: string): FakeElement { return new FakeElement(tag, this); }
}

type Matcher = (el: FakeElement) => boolean;
function compile(sel: string): Matcher {
  const alts = sel.split(',').map((s) => parseCompound(s.trim()));
  return (el) => alts.some((f) => f(el));
}
/** `tag`, `.class`, `[attr]`, `[attr="v"]`, `[attr*="v"]`, `[attr^="v"]`, `[attr$="v"]` and their compounds. */
function parseCompound(s: string): Matcher {
  const m = s.match(/^([a-zA-Z*][\w-]*)?((?:\.[\w-]+|\[[^\]]+\])*)$/);
  if (!m) throw new Error('unsupported selector ' + s);
  const tag = m[1] && m[1] !== '*' ? m[1].toUpperCase() : null;
  const tests: Matcher[] = [];
  if (tag) tests.push((el) => el.tagName === tag);
  for (const p of m[2]?.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []) {
    if (p.startsWith('.')) { const c = p.slice(1); tests.push((el) => el.className.split(/\s+/).includes(c)); continue; }
    const am = p.slice(1, -1).match(/^([\w-]+)(?:([*^$]?=)"?([^"]*)"?)?$/);
    if (!am) throw new Error('unsupported attribute selector ' + p);
    const name = am[1] ?? '';
    const op = am[2];
    const val = am[3] ?? '';
    tests.push((el) => {
      const v = el.getAttribute(name);
      if (v === null) return false;
      if (!op) return true;
      return op === '=' ? v === val : op === '*=' ? v.includes(val) : op === '^=' ? v.startsWith(val) : v.endsWith(val);
    });
  }
  return (el) => tests.every((t) => t(el));
}

export class FakeEvent {
  type: string;
  target: FakeElement | null = null;
  defaultPrevented = false;
  stopped = false;
  shiftKey = false;
  key = '';
  constructor(type: string, init: Partial<FakeEvent> = {}) { this.type = type; Object.assign(this, init); }
  stopPropagation(): void { this.stopped = true; }
  preventDefault(): void { this.defaultPrevented = true; }
}

/** Capture phase from the document down, the target, then bubbling; stopPropagation honoured. */
export function dispatch(target: FakeElement, type: string, init: Partial<FakeEvent> = {}): FakeEvent {
  const e = new FakeEvent(type, init);
  e.target = target;
  const path: FakeElement[] = [];
  for (let x: FakeElement | null = target; x; x = x.parentNode) path.push(x);
  for (let i = path.length - 1; i > 0 && !e.stopped; i--) for (const l of path[i]!.listeners[type] ?? []) if (l.cap) l.fn(e);
  if (!e.stopped) for (const l of target.listeners[type] ?? []) l.fn(e);
  for (let i = 1; i < path.length && !e.stopped; i++) for (const l of path[i]!.listeners[type] ?? []) if (!l.cap) l.fn(e);
  return e;
}

// ---- fake services --------------------------------------------------------------------------------

export interface FakeResponse { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }
export const resp = (status: number, body: string): FakeResponse =>
  ({ ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) as unknown });
const jsonResp = (o: unknown): FakeResponse => resp(200, JSON.stringify(o));

export interface GqlCall { query: string; variables: Record<string, any>; auth: string | undefined }
interface Label { id: string; name: string; parent: { name: string } | null }

/** Linear's GraphQL, stateful for labels: issueUpdate applies addedLabelIds/removedLabelIds (or a full
 *  labelIds set, so a regression to full replacement shows up as lost labels). */
export class FakeLinear {
  labels: Label[] = [
    { id: 'bug', name: 'Bug', parent: null }, { id: 'feature', name: 'Feature', parent: null },
    { id: 'l-2', name: '-2', parent: { name: 'Energy Δ' } }, { id: 'l0', name: '0', parent: { name: 'Energy Δ' } },
    { id: 'l+2', name: '+2', parent: { name: 'Energy Δ' } }, { id: 'lq', name: '?', parent: { name: 'Energy Δ' } },
    { id: 'm-1', name: '-1', parent: { name: 'Mood' } }, { id: 'm+1', name: '+1', parent: { name: 'Mood' } },
  ];
  issues = new Map<string, { id: string; labelIds: string[] }>();
  updates: Record<string, any>[] = [];
  /** Answers first when it returns a response; null falls through to the default handling. */
  hook: ((call: GqlCall) => Promise<FakeResponse | null> | FakeResponse | null) | null = null;

  /** Every issue starts with "Bug" and "+2" (Energy Δ) unless the test changed it before the first read. */
  issue(identifier: string): { id: string; labelIds: string[] } {
    let i = this.issues.get(identifier);
    if (!i) { i = { id: 'iss-' + identifier, labelIds: ['bug', 'l+2'] }; this.issues.set(identifier, i); }
    return i;
  }
  groupLabelIds(identifier: string, group: string): string[] {
    return this.issue(identifier).labelIds.filter((id) => this.labels.find((l) => l.id === id)?.parent?.name === group);
  }
  handle(call: GqlCall): FakeResponse {
    const { query: q, variables: v } = call;
    if (q.includes('issueLabels(')) {
      const nodes = this.labels.filter((l) => l.parent?.name === v['group']).map(({ id, name }) => ({ id, name }));
      return jsonResp({ data: { issueLabels: { nodes } } });
    }
    if (q.includes('labels(first:50)')) {
      const i = this.issue(String(v['id']));
      return jsonResp({ data: { issue: { id: i.id, labels: { nodes: i.labelIds.map((id) => this.labels.find((l) => l.id === id)) } } } });
    }
    if (q.includes('issueUpdate(')) {
      this.updates.push(v);
      const i = [...this.issues.values()].find((x) => x.id === v['id']);
      const full = v['labelIds'] as string[] | undefined;
      const input = v['input'] as { addedLabelIds?: string[]; removedLabelIds?: string[]; labelIds?: string[] } | undefined;
      if (i && (full ?? input?.labelIds)) i.labelIds = [...(full ?? input?.labelIds ?? [])];
      else if (i && input) {
        const rm = new Set(input.removedLabelIds ?? []);
        i.labelIds = i.labelIds.filter((id) => !rm.has(id));
        for (const id of input.addedLabelIds ?? []) if (!i.labelIds.includes(id)) i.labelIds.push(id);
      }
      return jsonResp({ data: { issueUpdate: { success: true } } });
    }
    return jsonResp({ errors: [{ message: 'unrouted query' }] });
  }
}

export interface MemStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; map: Map<string, string> }
function mem(init: Record<string, string>): MemStore {
  const map = new Map(Object.entries(init));
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}

// ---- harness --------------------------------------------------------------------------------------

export interface HarnessOptions { apiKey?: string; settings?: Record<string, unknown>; storage?: 'local' | 'extension' }
export interface Harness {
  ctx: Record<string, any>;
  document: FakeDocument;
  body: FakeElement;
  linear: FakeLinear;
  /** Every GraphQL request, in order, with the Authorization header it carried. */
  calls: GqlCall[];
  toasts: string[];
  /** Queued answers for window.prompt (one per call); an empty queue answers null (= cancelled). */
  promptAnswers: string[];
  promptsShown: string[];
  logs: string[];
  local: MemStore;
  session: MemStore;
  /** chrome.storage.local's backing map when storage is 'extension'. */
  ext: Map<string, string> | null;
  /** Runs every setInterval callback once (rows, event links, ＋/badge mounting). */
  tick(): void;
  /** Lets pending promises and setImmediate-based storage settle. */
  flush(n?: number): Promise<void>;
  run(): Promise<void>;
  addChip(key: string, title: string): FakeElement;
  addRow(title: string, href: string): FakeElement;
  issueReads(): GqlCall[];
  groupReads(): GqlCall[];
  updates(): GqlCall[];
}

export function makeHarness(o: HarnessOptions = {}): Harness {
  const document = new FakeDocument();
  const local = mem({ ...(o.apiKey ? { 'tcb-linear-api-key': o.apiKey } : {}), ...(o.settings ? { 'tcb-settings': JSON.stringify(o.settings) } : {}) });
  const session = mem({});
  const intervals: (() => void)[] = [];
  const toasts: string[] = []; const promptAnswers: string[] = []; const promptsShown: string[] = []; const logs: string[] = [];
  const linear = new FakeLinear();
  const calls: GqlCall[] = [];
  const ctx: Record<string, any> = {
    console: { info: (...a: unknown[]) => logs.push(a.join(' ')), log: () => {}, warn: () => {}, error: (...a: unknown[]) => logs.push('ERR ' + a.join(' ')) },
    document, Element: FakeElement, HTMLElement: FakeElement, Node: FakeElement,
    location: { hostname: 'app.reclaim.ai', pathname: '/planner', href: 'https://app.reclaim.ai/planner' },
    sessionStorage: session, localStorage: local,
    innerWidth: 1200, innerHeight: 800,
    setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; }, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    getComputedStyle: (el: FakeElement) => ({ position: el.style['position'] || 'absolute', font: '500 13px x', padding: '2px 4px' }),
    prompt: (msg: string) => { promptsShown.push(msg); return promptAnswers.shift() ?? null; },
    open: () => {},
    __now: 1_000_000,
    fetch: async (url: string, init?: { body?: string; headers?: Record<string, string> }): Promise<FakeResponse> => {
      if (url === 'https://api.linear.app/graphql') {
        const b = JSON.parse(init?.body ?? '{}') as { query: string; variables: Record<string, any> };
        const call: GqlCall = { query: b.query, variables: b.variables, auth: init?.headers?.['Authorization'] };
        calls.push(call);
        const hooked = linear.hook ? await linear.hook(call) : null;
        return hooked ?? linear.handle(call);
      }
      if (url.includes('/api/users/current')) return resp(200, '{"credentialId":1}');
      if (url.includes('/api/events/raw-google/')) return jsonResp({ rawData: { htmlLink: 'https://calendar.google.com/event?eid=abc' } });
      if (url.includes('/api/events/')) return resp(404, '');
      throw new Error('unrouted fetch ' + url);
    },
  };
  let ext: Map<string, string> | null = null;
  if (o.storage === 'extension') {
    // chrome.storage.local as a FIFO of asynchronous operations (Chromium's storage backend is
    // sequenced): an operation issued earlier always completes earlier, never in the same tick.
    const m = new Map(local.map);
    local.map.clear();
    ext = m;
    const later = <T,>(f: () => T): Promise<T> => new Promise((r) => setImmediate(() => r(f())));
    ctx['chrome'] = { storage: { local: {
      get: (k: string) => later(() => ({ [k]: m.get(k) })),
      set: (obj: Record<string, string>) => later(() => { for (const [k, v] of Object.entries(obj)) m.set(k, v); }),
      remove: (k: string) => later(() => { m.delete(k); }),
    } } };
  }
  ctx['window'] = ctx;
  ctx['globalThis'] = ctx;
  vm.createContext(ctx);
  vm.runInContext('Date.now = () => globalThis.__now;', ctx);
  // Toasts are divs the script pins to the bottom of the body.
  const origAppend = document.body.appendChild.bind(document.body);
  document.body.appendChild = <T extends FakeElement>(c: T): T => { if (c.style['bottom'] === '24px') toasts.push(c.textContent); return origAppend(c); };

  const addChip = (key: string, title: string): FakeElement => {
    const chip = document.createElement('div');
    chip.className = 'CalendarEventView_root__x';
    chip.setAttribute('data-event-key', key);
    const h = document.createElement('div');
    h.className = 'CalendarEventDetails_content__header__x';
    h.textContent = title;
    chip.appendChild(h);
    return document.body.appendChild(chip);
  };
  const addRow = (title: string, href: string): FakeElement => {
    const row = document.createElement('div');
    row.className = 'TaskListItem_root__x';
    const a = document.createElement('a');
    a.className = 'TaskListItem_task__title__x';
    a.href = href;
    a.textContent = title;
    row.appendChild(a);
    const meta = document.createElement('div');
    meta.className = 'TaskListItem_task__metadata__left__x TaskListItem_task__metadata__left--actions__x';
    const b = document.createElement('button');
    b.textContent = 'Start Task';
    meta.appendChild(b);
    row.appendChild(meta);
    return document.body.appendChild(row);
  };
  return {
    ctx, document, body: document.body, linear, calls, toasts, promptAnswers, promptsShown, logs, local, session, ext,
    tick: () => { for (const fn of intervals) fn(); },
    flush: async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); },
    run: async () => { vm.runInContext(await reclaimBundle(), ctx, { filename: 'reclaim.js' }); },
    addChip, addRow,
    issueReads: () => calls.filter((c) => c.query.includes('labels(first:50)')),
    groupReads: () => calls.filter((c) => c.query.includes('issueLabels(')),
    updates: () => calls.filter((c) => c.query.includes('issueUpdate(')),
  };
}

export const q = (el: FakeElement, sel: string): FakeElement | null => el.querySelector(sel);
export const menus = (body: FakeElement): FakeElement[] => body.querySelectorAll('.tcb-ev-energy-menu');
export const menuButtons = (body: FakeElement): FakeElement[] => menus(body)[0]?.querySelectorAll('button') ?? [];

// Linear issue page: "📅 Block time" next to the Activity heading, or Option+B, opens a prefilled
// Google Calendar event for the issue. Shift+click the button to edit settings.
// main() is exported and started from linear.entry.ts, so the bookmarklet can import the pure
// helpers below without bundling (and running) the page script.
import {
  calendarTemplateUrl, editSettings, leafWithText, loadSettings, makeStore, nextHalfHour,
  openInNewTab, parseSettings, registerMenu, run, toast, type Settings,
} from './shared.ts';

const ISSUE_RE = /\/issue\/([A-Z][A-Z0-9]{0,7}-\d+)(?:\/([^/?#]*))?/;
const BTN_ID = 'tcb-block-btn';

interface IssueRef { id: string; slug: string; }

export function issueFromPath(pathname: string): IssueRef | null {
  const m = pathname.match(ISSUE_RE);
  return m && m[1] ? { id: m[1], slug: m[2] || '' } : null;
}

/** "<ID> <title>" is the tab title on an issue page; require the space so a stale title for another
 *  issue (HOME-2 vs "HOME-24 …") falls through to the slug instead of yielding "4 …". */
export function issueTitle(issue: IssueRef, docTitle: string): string {
  const t = docTitle.trim();
  if (t.startsWith(issue.id + ' ')) return t.slice(issue.id.length + 1).trim();
  if (issue.slug) {
    const words = issue.slug.split('-').filter(Boolean).join(' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return t || issue.id;
}

/** The estimate is a plain row (no labels/ids) inside the element that follows the "Properties"
 *  heading in the sidebar; scoping the search there keeps a label or comment "M" from matching. */
export function estimateMinutes(settings: Settings, root: ParentNode = document): number {
  const heading = leafWithText('div,span,h2,h3,p', 'Properties', root);
  const scope = heading?.nextElementSibling ?? null;
  if (!scope) return settings.defaultMinutes;
  for (const n of scope.querySelectorAll<HTMLElement>('div,span,button')) {
    const t = (n.textContent || '').trim().toUpperCase();
    const m = settings.durationByEstimate[t];
    if (m) return m;
  }
  return settings.defaultMinutes;
}

export function main(): void {
  // A userscript and the extension are separate JS worlds sharing one DOM, so a DOM attribute (not a
  // window flag) lets the first copy own the page; otherwise Option+B would open two tabs.
  const html = document.documentElement;
  if (html.dataset['tcbLinear']) { console.info('task-calendar-block: another copy is already active on this page'); return; }
  html.dataset['tcbLinear'] = '1';

  const store = makeStore();
  let settings: Settings | null = null;
  const getSettings = async (): Promise<Settings> => {
    if (settings) return settings;
    try { settings = await loadSettings(store); } catch { return parseSettings(null); }   // storage unavailable: defaults, not cached
    return settings;
  };

  async function openCalendar(): Promise<void> {
    const issue = issueFromPath(location.pathname);
    if (!issue) { toast('Not on a Linear issue page.'); return; }
    const s = await getSettings();
    const url = `https://linear.app${location.pathname}`;
    openInNewTab(calendarTemplateUrl({
      title: `${issue.id} ${issueTitle(issue, document.title)}`,
      details: `Linear: ${issue.id}\n${url}`,
      start: nextHalfHour(),
      minutes: estimateMinutes(s),
    }));
  }

  async function openSettings(): Promise<void> {
    const next = await editSettings(store, await getSettings());
    if (next) { settings = next; toast('Settings saved'); }
  }
  registerMenu('Task → Calendar block: settings…', () => run(openSettings()));

  // Option+B anywhere on the page, except while typing.
  document.addEventListener('keydown', (e) => {
    if (!(e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyB')) return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    e.preventDefault();
    run(openCalendar());
  }, true);

  // Linear is a SPA that re-renders; poll and re-insert whenever the button is missing.
  function mountButton(): void {
    if (!issueFromPath(location.pathname) || document.getElementById(BTN_ID)) return;
    const heading = leafWithText('h3', 'Activity');
    if (!heading) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '📅 Block time';
    btn.title = 'Open a prefilled Google Calendar event for this issue (Option+B). Shift+click: settings';
    Object.assign(btn.style, {
      marginLeft: '12px', padding: '3px 10px', borderRadius: '6px', border: '1px solid #8886',
      background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px', fontWeight: '500',
      cursor: 'pointer', verticalAlign: 'middle',
    });
    btn.addEventListener('click', (e) => run(e.shiftKey ? openSettings() : openCalendar()));
    heading.appendChild(btn);
  }
  setInterval(mountButton, 500);
}

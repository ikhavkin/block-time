import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarTemplateUrl, fmtLocal, issueIdRegex, makeStore, nextHalfHour, normalizeIssueId, normalizeSlug,
  normalizeTeamKeys, parseDurations, parseSettings, splitTeamKeys,
} from '../src/shared.ts';
import { issueFromPath, issueTitle } from '../src/linear.ts';
import { detectTeamKeys, detectWorkspaceSlug, linkLabel, minutesFromText, seriesKey, sourceLabel } from '../src/reclaim.ts';

test('parseSettings: defaults, merge, validation', () => {
  const d = parseSettings(null);
  assert.equal(d.defaultMinutes, 60);
  assert.deepEqual(d.durationByEstimate, { XS: 30, S: 60, M: 120, L: 240, XL: 480 });
  const s = parseSettings(JSON.stringify({ teamKeys: ['home', 'x y', 'ENG'], workspaceSlug: ' acme ', durationByEstimate: { m: '90', bad: 'x' }, defaultMinutes: '45' }));
  assert.deepEqual(s.teamKeys, ['HOME', 'ENG']);
  assert.equal(s.workspaceSlug, 'acme');
  assert.deepEqual(s.durationByEstimate, { M: 90 });
  assert.equal(s.defaultMinutes, 45);
  assert.equal(parseSettings('not json').defaultMinutes, 60);
  // An empty or non-object durations value keeps the defaults; a stored non-slug degrades to auto-detect.
  assert.deepEqual(parseSettings(JSON.stringify({ durationByEstimate: {} })).durationByEstimate, d.durationByEstimate);
  assert.deepEqual(parseSettings(JSON.stringify({ durationByEstimate: 30 })).durationByEstimate, d.durationByEstimate);
  assert.equal(parseSettings(JSON.stringify({ workspaceSlug: 'https:' })).workspaceSlug, '');
  assert.equal(parseSettings(JSON.stringify({ workspaceSlug: 'https://linear.app/acme/issue/ENG-1' })).workspaceSlug, 'acme');
});

test('parseDurations: object with positive minutes only; non-objects are null', () => {
  assert.deepEqual(parseDurations({ XS: 20 }), { XS: 20 });
  assert.deepEqual(parseDurations({ xs: '20', S: 0, M: -5, L: 'abc', '': 9 }), { XS: 20 });
  assert.deepEqual(parseDurations({ XS: 'abc' }), {});
  assert.deepEqual(parseDurations({}), {});
  assert.equal(parseDurations(30), null);
  assert.equal(parseDurations([]), null);
  assert.equal(parseDurations(null), null);
  assert.equal(parseDurations('{"XS":20}'), null);
});

test('normalizeTeamKeys drops invalid and duplicate keys', () => {
  assert.deepEqual(normalizeTeamKeys(['home', 'HOME', '9AB', 'TOOLONGKEYX', 'A-B', 'eng2']), ['HOME', 'ENG2']);
});

test('splitTeamKeys: commas or whitespace, reports what was dropped', () => {
  assert.deepEqual(splitTeamKeys('HOME ENG'), { kept: ['HOME', 'ENG'], dropped: [] });
  assert.deepEqual(splitTeamKeys('HOME, eng,,'), { kept: ['HOME', 'ENG'], dropped: [] });
  assert.deepEqual(splitTeamKeys('x y, TOOLONGKEYX, home'), { kept: ['X', 'Y', 'HOME'], dropped: ['TOOLONGKEYX'] });
  assert.deepEqual(splitTeamKeys('HOME;ENG'), { kept: [], dropped: ['HOME;ENG'] });
  assert.deepEqual(splitTeamKeys('home, HOME'), { kept: ['HOME'], dropped: [] });
  assert.deepEqual(splitTeamKeys('  '), { kept: [], dropped: [] });
});

test('normalizeSlug: bare slug, linear.app URLs, empty = detect, invalid = null', () => {
  assert.equal(normalizeSlug('acme'), 'acme');
  assert.equal(normalizeSlug(' Acme '), 'acme');
  assert.equal(normalizeSlug(''), '');
  assert.equal(normalizeSlug('   '), '');
  assert.equal(normalizeSlug('linear.app/acme-inc'), 'acme-inc');
  assert.equal(normalizeSlug(' https://linear.app/acme'), 'acme');
  assert.equal(normalizeSlug('https://www.linear.app/acme/'), 'acme');
  assert.equal(normalizeSlug('http://linear.app/acme/issue/ENG-7/title'), 'acme');
  assert.equal(normalizeSlug('acme?x'), 'acme');
  assert.equal(normalizeSlug('acme#frag'), 'acme');
  assert.equal(normalizeSlug('Acme Corp'), null);
  assert.equal(normalizeSlug('https:'), null);
  assert.equal(normalizeSlug('-acme'), null);
  assert.equal(normalizeSlug('https://example.com/acme'), null);
});

test('issueIdRegex matches only configured teams', () => {
  const re = issueIdRegex(['HOME']);
  assert.ok(re);
  for (const t of ['FLU-19 booster', 'Q3-2026 planning', 'WWDC-26', 'XHOME-5', 'HOME-24abc', 'ABC-12']) assert.equal(t.match(re!), null, t);
  assert.equal('Call re HOME-24'.match(re!)?.[1], 'HOME-24');
  assert.equal(issueIdRegex([]), null);
  assert.equal('ENG-7'.match(issueIdRegex(['HOME', 'ENG'])!)?.[1], 'ENG-7');
});

test('normalizeIssueId accepts numbers, lowercase, URLs, UUIDs', () => {
  assert.equal(normalizeIssueId('26', ['HOME']), 'HOME-26');
  assert.equal(normalizeIssueId('26', []), null);
  assert.equal(normalizeIssueId(' home-26 ', ['HOME']), 'HOME-26');
  assert.equal(normalizeIssueId('https://linear.app/acme/issue/eng-7/eng-7-looks-like-id', []), 'ENG-7');
  assert.equal(normalizeIssueId('', ['HOME']), null);
  const uuid = 'd09ebf94-222c-4f0d-ba5f-5e84b2559ae5';
  assert.equal(normalizeIssueId(uuid, ['HOME']), uuid);
});

test('calendar URL: dates, encoding, ctz, minimum length', () => {
  const start = new Date(2026, 8, 17, 10, 0);
  const url = calendarTemplateUrl({ title: 'Reply to recruiter @ LinkedIn & co', details: 'Linear: HOME-25\nhttps://x', start, minutes: 30 });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(u.searchParams.get('action'), 'TEMPLATE');
  assert.equal(u.searchParams.get('text'), 'Reply to recruiter @ LinkedIn & co');
  assert.equal(u.searchParams.get('details'), 'Linear: HOME-25\nhttps://x');
  assert.equal(u.searchParams.get('dates'), '20260917T100000/20260917T103000');
  assert.equal(u.searchParams.get('ctz'), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.match(new URL(calendarTemplateUrl({ title: 't', details: '', start, minutes: 0 })).searchParams.get('dates')!, /T100500$/);
  assert.equal(fmtLocal(new Date(2026, 11, 31, 23, 59)), '20261231T235900');
});

test('nextHalfHour rounds up and crosses the hour/day', () => {
  assert.equal(nextHalfHour(new Date(2026, 8, 16, 10, 5)).getTime(), new Date(2026, 8, 16, 10, 30).getTime());
  assert.equal(nextHalfHour(new Date(2026, 8, 16, 10, 30)).getTime(), new Date(2026, 8, 16, 11, 0).getTime());
  assert.equal(nextHalfHour(new Date(2026, 8, 16, 23, 45)).getTime(), new Date(2026, 8, 17, 0, 0).getTime());
});

test('Linear issue path and title parsing', () => {
  assert.deepEqual(issueFromPath('/acme/issue/HOME-24/update-resume'), { id: 'HOME-24', slug: 'update-resume' });
  assert.deepEqual(issueFromPath('/acme/issue/HOME-24'), { id: 'HOME-24', slug: '' });
  assert.equal(issueFromPath('/acme/team/HOME/active'), null);
  const i = { id: 'HOME-24', slug: 'update-resume' };
  assert.equal(issueTitle(i, 'HOME-24 Update resume'), 'Update resume');
  assert.equal(issueTitle(i, 'HOME-24 Foo - Linear'), 'Foo - Linear');
  assert.equal(issueTitle({ id: 'HOME-2', slug: 'other-thing' }, 'HOME-24 Update resume'), 'Other thing');
  assert.equal(issueTitle({ id: 'HOME-2', slug: '' }, 'HOME-24 Update resume'), 'HOME-24 Update resume');
});

test('minutesFromText: only duration-only segments count', () => {
  assert.equal(minutesFromText('HOME-12: Dry clothes\nReady to start • Due Sep 21 • 30m', 60), 30);
  assert.equal(minutesFromText('Fix the 2h thing • Due Sep 21 • 4h', 60), 240);
  assert.equal(minutesFromText('Wait 20m before coffee\nReady to start • Due Sep 21', 60), 60);
  assert.equal(minutesFromText('x • 1h 30m', 60), 90);
  assert.equal(minutesFromText('x • 1h30m', 60), 90);
  assert.equal(minutesFromText('x • 1.5h', 60), 90);
  assert.equal(minutesFromText('HOME-21: Weekly sync\nMark Done\nStart Task\n📅 Block', 60), 60);
  // textContent of a list row with an estimate but no start/due date (no "•" rendered): the duration is
  // glued to the title and must NOT match; the caller passes innerText, which keeps the line breaks.
  assert.equal(minutesFromText('Dry clothes📅4h', 60), 60);
  assert.equal(minutesFromText('Dry clothes\n📅\n4h', 60), 240);
});

test('seriesKey collapses timed and all-day instances', () => {
  assert.equal(seriesKey('1000001/abc_20260917T060000Z'), '1000001/abc');
  assert.equal(seriesKey('1000001/abc_20260917'), '1000001/abc');
  assert.equal(seriesKey('1000001/abc'), '1000001/abc');
  assert.equal(seriesKey('1000001/x_2026'), '1000001/x_2026');
});

test('labels', () => {
  assert.equal(sourceLabel(''), 'Reclaim task');
  assert.equal(sourceLabel('https://tasks.google.com/task/x'), 'Google Tasks');
  assert.equal(linkLabel('https://linear.app/a/issue/HOME-1'), 'Open in Linear');
});

/** Minimal planner root: querySelectorAll answers the anchor selector with {href} objects and any
 *  other selector (row titles) with {textContent} objects. */
function fakeRoot(titles: string[], hrefs: string[]): ParentNode {
  return {
    querySelectorAll: (sel: string) => (sel.startsWith('a[') ? hrefs.map((href) => ({ href })) : titles.map((textContent) => ({ textContent }))),
  } as unknown as ParentNode;
}

test('detectTeamKeys / detectWorkspaceSlug use issue links only, never row titles', () => {
  const root = fakeRoot(
    ['FLU-19: book booster', 'HOME-21: Weekly sync', 'ENG-3: not a link'],
    ['https://tasks.google.com/task/abc?sa=6', 'https://linear.app/acme/team/HOME/active',
      'https://linear.app/acme/issue/HOME-21/weekly-sync', 'https://linear.app/acme/issue/home-24/x'],
  );
  assert.deepEqual(detectTeamKeys(root), ['HOME']);
  assert.equal(detectWorkspaceSlug(root), 'acme');
  assert.deepEqual(detectTeamKeys(fakeRoot(['FLU-19: x'], ['https://tasks.google.com/task/abc'])), []);
  assert.equal(detectWorkspaceSlug(fakeRoot([], ['https://linear.app/acme/team/ENG/active'])), '');
  assert.equal(detectWorkspaceSlug(fakeRoot([], [])), '');
});

test('makeStore: GM.* (Greasemonkey 4) wins over chrome.storage; extension reads fail soft, writes fail loud', async () => {
  const g = globalThis as Record<string, unknown>;
  const bag = new Map<string, unknown>();
  g['GM'] = {
    getValue: async (k: string, def: unknown) => (bag.has(k) ? bag.get(k) : def),
    setValue: async (k: string, v: unknown) => { bag.set(k, v); },
    deleteValue: async (k: string) => { bag.delete(k); },
  };
  g['chrome'] = { storage: { local: { get: async () => { throw new Error('should not be used'); } } } };
  try {
    const gm = makeStore();
    assert.equal(gm.kind, 'gm');
    assert.equal(await gm.get('k'), null);
    await gm.set('k', 'v');
    assert.equal(await gm.get('k'), 'v');
    await gm.remove('k');
    assert.equal(await gm.get('k'), null);
  } finally { delete g['GM']; }

  g['chrome'] = { storage: { local: {
    get: async () => { throw new Error('Extension context invalidated.'); },
    set: async () => { throw new Error('Extension context invalidated.'); },
    remove: async () => { throw new Error('Extension context invalidated.'); },
  } } };
  try {
    const ext = makeStore();
    assert.equal(ext.kind, 'extension');
    assert.equal(await ext.get('k'), null);
    await assert.rejects(ext.set('k', 'v'), /reload this tab.*Extension context invalidated/);
    await assert.rejects(ext.remove('k'), /reload this tab/);
    g['chrome'] = { storage: { local: { get: async (k: string) => ({ [k]: 'stored' }), set: async () => {}, remove: async () => {} } } };
    assert.equal(await makeStore().get('k'), 'stored');
  } finally { delete g['chrome']; }
});

test('energy labels: parse and display', async () => {
  const { energyValue, energyText } = await import('../src/shared.ts');
  assert.equal(energyValue('-5'), -5);
  assert.equal(energyValue('+2'), 2);
  assert.equal(energyValue('0'), 0);
  assert.equal(energyValue('−3'), -3);          // Unicode minus, as Linear may render it
  assert.equal(energyValue(' +1 '), 1);
  assert.equal(energyValue('Energy Δ'), null);
  assert.equal(energyValue('+42'), null);
  assert.equal(energyValue('5x'), null);
  assert.equal(energyText(2), '+2');
  assert.equal(energyText(-3), '−3');
  assert.equal(energyText(0), '0');
  assert.equal(parseSettings(null).energyGroup, 'Energy Δ');
  assert.equal(parseSettings(JSON.stringify({ energyGroup: ' Mood ' })).energyGroup, 'Mood');
  assert.equal(parseSettings(JSON.stringify({ energyGroup: '' })).energyGroup, '');
});

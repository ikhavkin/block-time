// The Reclaim script's ⚡ badge, run in a fake DOM (test/fakedom.ts): label writes, caches, prompts,
// menu placement and failure handling. Each test builds a fresh page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, makeHarness, menuButtons, menus, q, resp, type FakeElement, type Harness, type HarnessOptions } from './fakedom.ts';

const SETTINGS = { teamKeys: ['HOME'], workspaceSlug: 'acme' };
const DURATIONS = '{"XS":30,"S":60,"M":120,"L":240,"XL":480}';
const badge = (chip: FakeElement): FakeElement => { const b = q(chip, '.tcb-ev-energy'); assert.ok(b, 'badge mounted'); return b; };
const badgeText = (chip: FakeElement): string | undefined => q(chip, '.tcb-ev-energy')?.textContent;

async function page(o: HarnessOptions = {}): Promise<Harness> {
  const H = makeHarness({ apiKey: 'lin_api_test', settings: SETTINGS, ...o });
  await H.run();
  return H;
}
async function chipOn(H: Harness, key: string, title = 'HOME-24 Update resume'): Promise<FakeElement> {
  const chip = H.addChip(key, title);
  H.tick();
  await H.flush();
  return chip;
}
async function openMenu(H: Harness, chip: FakeElement): Promise<FakeElement[]> {
  dispatch(badge(chip), 'click');
  await H.flush();
  return menuButtons(H.body);
}
async function pick(H: Harness, chip: FakeElement, label: string): Promise<void> {
  const b = (await openMenu(H, chip)).find((x) => x.textContent === label);
  assert.ok(b, `menu has ${label}`);
  dispatch(b, 'click');
  await H.flush();
}

test('page load: badge reads the group label with a stored key and never prompts; no key = no request', async () => {
  const H = await page();
  const chip = await chipOn(H, 'cal/abc_20260917T060000Z');
  assert.ok(q(chip, '.tcb-ev-link'), '↗ mounted');
  assert.equal(badgeText(chip), '⚡+2');
  assert.equal(badge(chip).style['opacity'], '1');
  assert.equal(H.issueReads().length, 1);
  assert.equal(H.issueReads()[0]?.auth, 'lin_api_test');
  assert.equal(H.promptsShown.length, 0, H.promptsShown.join("|"));
  // a re-rendered chip of the same issue is served from the cache
  chip.remove();
  const again = await chipOn(H, 'cal/abc_20260918T060000Z');
  assert.equal(badgeText(again), '⚡+2');
  assert.equal(H.issueReads().length, 1);

  const bare = makeHarness({ settings: SETTINGS });   // no key stored
  await bare.run();
  const c2 = await chipOn(bare, 'cal/abc_20260917T060000Z');
  assert.equal(badgeText(c2), '⚡');
  assert.equal(badge(c2).style['opacity'], '0.6');
  assert.equal(bare.calls.length, 0);
  assert.equal(bare.promptsShown.length, 0, bare.promptsShown.join("|"));
});

test('picking a value writes a delta inside the group and leaves other labels alone', async () => {
  const H = await page();
  H.linear.issue('HOME-24').labelIds = ['bug', 'l+2', 'lq'];   // a stray second group label ("?") on the issue
  const a = await chipOn(H, 'cal/abc_20260917T060000Z');
  const b = await chipOn(H, 'cal/abc_20260918T060000Z');
  assert.equal(badgeText(a), '⚡+2');
  H.linear.issue('HOME-24').labelIds.push('feature');           // added in Linear after the page-load read
  assert.deepEqual((await openMenu(H, a)).map((x) => x.textContent), ['−2', '0', '+2']);
  await pick(H, a, '−2');
  assert.equal(H.updates().length, 1);
  assert.deepEqual(H.updates()[0]?.variables, { id: 'iss-HOME-24', input: { addedLabelIds: ['l-2'], removedLabelIds: ['l+2', 'lq'] } });
  assert.deepEqual(H.linear.issue('HOME-24').labelIds, ['bug', 'feature', 'l-2']);
  assert.equal(badgeText(a), '⚡−2');
  assert.equal(badgeText(b), '⚡−2', 'sibling chip of the same issue repainted');
  assert.equal(H.toasts.length, 0, H.toasts.join("|"));
  assert.equal(H.issueReads().length, 2, 'one read at mount, one fresh read before the write');
});

test('two quick picks on one issue are serialised: the second removes what the first added', async () => {
  const H = await page();
  const chip = await chipOn(H, 'cal/abc_20260917T060000Z');
  let release = (): void => {};
  const gate = new Promise<void>((r) => { release = r; });
  let gated = false;
  H.linear.hook = async (c) => { if (c.query.includes('issueUpdate(') && !gated) { gated = true; await gate; } return null; };
  await pick(H, chip, '0');
  assert.equal(H.updates().length, 1, 'first update sent and held');
  await pick(H, chip, '−2');
  assert.equal(H.updates().length, 1, 'second update waits for the first');
  assert.equal(badgeText(chip), '⚡−2', 'optimistic paint');
  release();
  await H.flush(20);
  assert.deepEqual(H.updates().map((u) => u.variables['input']), [
    { addedLabelIds: ['l0'], removedLabelIds: ['l+2'] },
    { addedLabelIds: ['l-2'], removedLabelIds: ['l0'] },
  ]);
  assert.deepEqual(H.linear.groupLabelIds('HOME-24', 'Energy Δ'), ['l-2'], 'exactly one group label survives');
  assert.equal(badgeText(chip), '⚡−2');
  assert.equal(H.toasts.length, 0, H.toasts.join("|"));
});

test('a failed update rolls the badge back to the value Linear still holds and toasts the error', async () => {
  const H = await page();
  const chip = await chipOn(H, 'cal/abc_20260917T060000Z');
  H.linear.hook = (c) => (c.query.includes('issueUpdate(') ? resp(500, '{"errors":[{"message":"boom"}]}') : null);
  await pick(H, chip, '−2');
  assert.equal(badgeText(chip), '⚡+2');
  assert.deepEqual(H.linear.issue('HOME-24').labelIds, ['bug', 'l+2']);
  assert.ok(H.toasts.some((t) => t.includes('boom')), H.toasts.join('|'));
  // and it is not stuck: the next pick goes through
  H.linear.hook = null;
  await pick(H, chip, '0');
  assert.equal(badgeText(chip), '⚡0');
});

test('settings change: badges and caches are dropped, the picker uses the new group, "" turns the badge off', async () => {
  const H = await page();
  const chips = [await chipOn(H, 'cal/abc_20260917T060000Z'), await chipOn(H, 'cal/abc_20260918T060000Z')];
  await openMenu(H, chips[0]!);
  assert.equal(menus(H.body).length, 1);
  const row = H.addRow('HOME-24: Update resume', 'https://linear.app/acme/issue/HOME-24/update-resume');
  H.tick();
  await H.flush();
  H.promptAnswers.push('HOME', 'acme', '', DURATIONS, 'Mood');
  dispatch(q(row, '.tcb-block-btn')!, 'click', { shiftKey: true });
  await H.flush();
  assert.equal(JSON.parse(H.local.getItem('tcb-settings') ?? '{}').energyGroup, 'Mood');
  assert.ok(H.toasts.includes('Settings saved'));
  assert.ok(!H.toasts.some((t) => t.startsWith('Task → Calendar block:')), H.toasts.join('|'));
  assert.equal(menus(H.body).length, 0, 'open picker closed');
  for (const c of chips) { assert.equal(q(c, '.tcb-ev-link'), null); assert.equal(q(c, '.tcb-ev-energy'), null); }
  const reads = H.issueReads().length;
  H.tick(); await H.flush(); H.tick(); await H.flush();
  for (const c of chips) { assert.ok(q(c, '.tcb-ev-link'), '↗ back'); assert.equal(badgeText(c), '⚡', 'no Mood label yet'); }
  assert.equal(H.issueReads().length, reads + 1, 'the issue was read again for the new group');
  assert.deepEqual((await openMenu(H, chips[0]!)).map((x) => x.textContent), ['−1', '+1']);
  assert.equal(H.groupReads().at(-1)?.variables['group'], 'Mood');
  await pick(H, chips[0]!, '−1');
  assert.deepEqual(H.updates().at(-1)?.variables, { id: 'iss-HOME-24', input: { addedLabelIds: ['m-1'], removedLabelIds: [] } });
  assert.deepEqual(H.linear.issue('HOME-24').labelIds, ['bug', 'l+2', 'm-1'], 'the Energy Δ label is not touched');
  for (const c of chips) assert.equal(badgeText(c), '⚡−1');

  H.promptAnswers.push('HOME', 'acme', '', DURATIONS, '');
  dispatch(q(row, '.tcb-block-btn')!, 'click', { shiftKey: true });
  await H.flush();
  H.tick(); await H.flush(); H.tick(); await H.flush();
  for (const c of chips) { assert.ok(q(c, '.tcb-ev-link')); assert.equal(q(c, '.tcb-ev-energy'), null); }
  assert.ok(!H.toasts.some((t) => t.startsWith('Task → Calendar block:')), H.toasts.join('|'));
});

test('background reads back off after a failure (5 s, 10 s, …) while a click still reads at once', async () => {
  const H = await page();
  let limited = true;
  H.linear.hook = (c) => (limited && c.query.includes('labels(first:50)') ? resp(429, '{"errors":[{"message":"Rate limit exceeded"}]}') : null);
  let chip: FakeElement | null = null;
  const rerender = async (): Promise<FakeElement> => { chip?.remove(); return chipOn(H, 'cal/r_20260917T060000Z', 'HOME-24 thing'); };
  for (let i = 0; i < 5; i++) chip = await rerender();
  assert.equal(H.issueReads().length, 1, 'one read for five re-renders');
  assert.equal(H.toasts.length, 0, 'background failures are silent');
  H.ctx['__now'] += 5001; chip = await rerender();
  assert.equal(H.issueReads().length, 2, 'retried after 5 s');
  H.ctx['__now'] += 5001; chip = await rerender();
  assert.equal(H.issueReads().length, 2, 'second window is 10 s');
  H.ctx['__now'] += 5001; chip = await rerender();
  assert.equal(H.issueReads().length, 3);
  const before = H.issueReads().length;
  await pick(H, chip, '−2');
  assert.equal(H.issueReads().length, before + 1, 'a pick reads immediately');
  assert.ok(H.toasts.at(-1)?.includes('Rate limit exceeded'), H.toasts.join('|'));
  limited = false;
  await pick(H, chip, '−2');
  assert.equal(badgeText(chip), '⚡−2');
  const after = H.issueReads().length;
  chip = await rerender();
  assert.equal(badgeText(chip), '⚡−2');
  assert.equal(H.issueReads().length, after, 'served from the cache after recovery');
});

test('picker: one menu after two clicks during the label fetch; placed inside the viewport; closes on scroll and Escape', async () => {
  const H = await page();
  const chip = await chipOn(H, 'cal/abc_20260917T060000Z');
  let release = (): void => {};
  const gate = new Promise<void>((r) => { release = r; });
  H.linear.hook = async (c) => { if (c.query.includes('issueLabels(')) await gate; return null; };
  dispatch(badge(chip), 'click');
  dispatch(badge(chip), 'click');
  await H.flush();
  assert.equal(menus(H.body).length, 0, 'nothing until the labels arrive');
  release();
  await H.flush();
  assert.equal(menus(H.body).length, 1);
  H.linear.hook = null;

  // badge at the bottom-right edge: the menu (270×30) flips above it and is pulled inside the right edge
  H.document.defaultRect = { left: 0, top: 0, right: 270, bottom: 30, width: 270, height: 30 };
  badge(chip).rect = { left: 1154, top: 790, right: 1199, bottom: 800, width: 45, height: 10 };
  dispatch(badge(chip), 'click');
  await H.flush();
  let menu = menus(H.body)[0];
  assert.ok(menu);
  assert.equal(menu.style['position'], 'fixed');
  assert.equal(menu.style['top'], `${790 - 4 - 30}px`);
  assert.equal(menu.style['left'], `${1200 - 270 - 4}px`);
  dispatch(chip, 'scroll');
  assert.equal(menus(H.body).length, 0, 'closed by a scroll of an inner container');

  // top-left badge: below it, clamped to the left edge
  badge(chip).rect = { left: 60, top: 100, right: 100, bottom: 120, width: 40, height: 20 };
  dispatch(badge(chip), 'click');
  await H.flush();
  menu = menus(H.body)[0];
  assert.ok(menu);
  assert.equal(menu.style['top'], '124px');
  assert.equal(menu.style['left'], '4px');
  dispatch(H.body, 'keydown', { key: 'Escape' });
  assert.equal(menus(H.body).length, 0, 'closed by Escape');
});

test('extension storage: a sibling 401 clearing the key mid-read never opens the key prompt at page load', async () => {
  const H = makeHarness({ apiKey: 'lin_api_revoked', settings: SETTINGS, storage: 'extension' });
  let release = (): void => {};
  const gate = new Promise<void>((r) => { release = r; });
  H.linear.hook = async (c) => {
    if (c.query.includes('labels(first:50)') && c.variables['id'] === 'HOME-1') await gate;   // chip A's read: its 401 lands when released
    return resp(401, '{"errors":[{"message":"auth","extensions":{"type":"authentication error"}}]}');
  };
  let armed = false;
  const storage = H.ctx['chrome'].storage.local;
  const origGet = storage.get;
  storage.get = (k: string) => { if (k === 'tcb-linear-api-key' && armed) { armed = false; release(); } return origGet(k); };
  await H.run();
  H.addChip('cal/a_20260917T060000Z', 'HOME-1 a');
  H.tick();
  await H.flush(30);
  assert.equal(H.issueReads().length, 1, 'chip A read in flight');
  armed = true;   // A's 401 arrives exactly when chip C issues its pre-check store.get
  H.addChip('cal/c_20260917T060000Z', 'HOME-3 c');
  H.tick();
  await H.flush(40);
  assert.equal(H.promptsShown.length, 0, H.promptsShown.join("|"));
  assert.equal(H.ext?.has('tcb-linear-api-key'), false, 'the 401 cleared the key');
  assert.equal(H.toasts.length, 0, H.toasts.join("|"));
});

test('clicking the badge with no stored key asks once and proceeds with the typed key', async () => {
  const H = makeHarness({ settings: SETTINGS });
  await H.run();
  const chip = await chipOn(H, 'cal/a_20260917T060000Z', 'HOME-1 a');
  assert.equal(H.calls.length, 0);
  H.promptAnswers.push('lin_api_typed');
  assert.deepEqual((await openMenu(H, chip)).map((x) => x.textContent), ['−2', '0', '+2']);
  assert.equal(H.promptsShown.length, 1);
  assert.equal(H.local.getItem('tcb-linear-api-key'), 'lin_api_typed');
  await pick(H, chip, '0');
  assert.deepEqual(H.calls.map((c) => c.auth), ['lin_api_typed', 'lin_api_typed', 'lin_api_typed']);
  assert.equal(badgeText(chip), '⚡0');
  assert.equal(H.promptsShown.length, 1);
  assert.equal(H.toasts.length, 0, H.toasts.join("|"));
});

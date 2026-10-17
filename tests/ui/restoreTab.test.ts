import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import type { OptionType } from '../../model';
import { toSavedWorkspace } from '../../ui/persist';
import {
  type Action,
  initialState,
  MAX_TABS,
  type RestoreTabAction,
  reduce,
  restoreTabAction,
  type State,
  stashActive,
} from '../../ui/state';
import {
  closedTabText,
  RESTORE_TAB_FULL_TEXT,
  RESTORE_TAB_TAKEN_TEXT,
  restoreTabError,
} from '../../ui/view/boxTabs';
import { fixture } from '../support/fixtures';
import { rng } from '../support/synthChain';

/**
 * #87 (B) AC-5: タブを閉じたあとの [元に戻す]（restoreTab）。閉じる前の state から restoreTabAction で写しを作り、
 * closeTab のあとに reduce すると、並び・名前・足・作業中のタブ・シナリオ・横軸の表示範囲が閉じる前と同じになる。
 */

function loaded(chain: Chain): State {
  return reduce(initialState, { type: 'loaded', chain, label: 'latest' });
}

function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reduce, state);
}

const chain = normalizeChain(fixture('latest'));
const m0 = chain.months[0];
if (!m0) throw new Error('限月が無い');
const ks = m0.rows.map((r) => r.k);
const mid = Math.floor(ks.length / 2);
const board = (i: number, optionType: OptionType, side: 'buy' | 'sell'): Action => ({
  type: 'addBoardLeg',
  expiry: m0.id,
  k: ks[mid + i] ?? 0,
  optionType,
  side,
});

/** 不変条件（State.tabs の注記）+ 名前が重複しない */
function invariant(s: State): void {
  const active = s.tabs.filter((t) => t.id === s.activeTab);
  expect(active).toHaveLength(1);
  expect(active[0]?.saved).toBeNull();
  for (const t of s.tabs) if (t.id !== s.activeTab) expect(t.saved).not.toBeNull();
  expect(s.tabs.length).toBeGreaterThanOrEqual(1);
  expect(s.tabs.length).toBeLessThanOrEqual(MAX_TABS);
  expect(new Set(s.tabs.map((t) => t.id)).size).toBe(s.tabs.length);
  expect(new Set(s.tabs.map((t) => t.name)).size).toBe(s.tabs.length);
  expect(s.tabs.every((t) => t.id < s.nextTabId)).toBe(true);
}

/** タブの並びを比べる形（id は問わない。作業中のタブは stashActive の形） */
function shape(s: State) {
  return s.tabs.map((t) => ({
    name: t.name,
    active: t.id === s.activeTab,
    legs: (t.id === s.activeTab ? stashActive(s) : t.saved)?.legs ?? null,
  }));
}

/**
 * タブ 3 個: A（足 1 本）/ B（作業中・足 2 本）/ C（third = 'empty' なら足 0 本、'legs' なら足 1 本）。
 * 横軸の表示範囲を入れておく
 */
function three(third: 'empty' | 'legs'): State {
  let s = run(loaded(chain), board(-1, 'put', 'buy'));
  s = run(s, { type: 'addTab', mode: 'empty' }); // B（id 2）
  s = run(s, board(-2, 'put', 'sell'), board(2, 'call', 'sell'));
  s = run(s, { type: 'addTab', mode: 'empty' }); // C（id 3）
  if (third === 'legs') s = run(s, board(3, 'call', 'buy'));
  s = run(s, { type: 'switchTab', id: 2 }, { type: 'setPnlViewport', viewport: [60000, 70000] });
  return s;
}

function closeAndRestore(before: State, id: number): { closed: State; restored: State } {
  const action = restoreTabAction(before, id);
  if (!action) throw new Error('写しが作れない');
  const closed = reduce(before, { type: 'closeTab', id });
  return { closed, restored: reduce(closed, action) };
}

describe('restoreTabAction（閉じる前の写し）', () => {
  it('無い id・タブ 1 個は null', () => {
    const one = loaded(chain);
    expect(restoreTabAction(one, 1)).toBeNull();
    expect(restoreTabAction(three('legs'), 99)).toBeNull();
  });

  it('作業中のタブ: position = stashActive・active・index = 並びの位置・viewport = pnlViewport', () => {
    const s = three('legs');
    const a = restoreTabAction(s, 2);
    expect(a).toEqual({
      type: 'restoreTab',
      name: 'B',
      position: stashActive(s),
      index: 1,
      active: true,
      viewport: [60000, 70000],
    } satisfies RestoreTabAction);
  });

  it('作業中でないタブ: position はその saved（同じ参照）・active でない', () => {
    const s = three('legs');
    const a = restoreTabAction(s, 3);
    expect(a?.active).toBe(false);
    expect(a?.index).toBe(2);
    expect(a?.name).toBe('C');
    expect(a?.position).toBe(s.tabs[2]?.saved);
  });
});

describe('restoreTab（#87 (B) AC-5）', () => {
  it.each(['empty', 'legs'] as const)(
    '(a) 作業中のタブを閉じて戻すと閉じる前と同じ（隣の C が %s）',
    (third) => {
      const before = three(third);
      const { closed, restored } = closeAndRestore(before, 2);
      // 閉じると右隣の C へ移る（C が足 0 本なら表示範囲は null になる）
      expect(closed.tabs.map((t) => t.name)).toEqual(['A', 'C']);
      if (third === 'empty') expect(closed.pnlViewport).toBeNull();
      invariant(restored);
      expect(shape(restored)).toEqual(shape(before));
      expect(restored.tabs.findIndex((t) => t.id === restored.activeTab)).toBe(1);
      expect(restored.scenario).toEqual(before.scenario);
      expect(restored.pnlViewport).toEqual(before.pnlViewport);
      expect(restored.legs.map((l) => l.id)).toEqual([1, 2]);
      expect(restored.smilePick).toBeNull();
    },
  );

  it('(a) 作業中の足 0 本のタブを戻すと表示範囲は null（switchTab と同じ規則）', () => {
    const s = run(three('empty'), { type: 'switchTab', id: 3 });
    const { restored } = closeAndRestore(s, 3);
    expect(restored.legs).toEqual([]);
    expect(restored.pnlViewport).toBeNull();
    expect(shape(restored)).toEqual(shape(s));
  });

  it('(b) 作業中でないタブを閉じて戻す: 作業中のタブ（id・足）は変わらず、saved は閉じる前と等しい', () => {
    for (const id of [1, 3]) {
      const before = three('legs');
      const { closed, restored } = closeAndRestore(before, id);
      invariant(restored);
      expect(restored.activeTab).toBe(before.activeTab);
      expect(restored.legs).toBe(closed.legs);
      expect(restored.pnlViewport).toBe(closed.pnlViewport);
      expect(shape(restored)).toEqual(shape(before));
      const i = before.tabs.findIndex((t) => t.id === id);
      expect(restored.tabs[i]?.saved).toEqual(before.tabs[i]?.saved);
      expect(restored.nextTabId).toBe(closed.nextTabId + 1);
    }
  });

  it('(c) 上限なら何もしない（同じ参照）・restoreTabError は上限の文', () => {
    const before = three('legs');
    const action = restoreTabAction(before, 3);
    if (!action) throw new Error('写しが作れない');
    let s = reduce(before, { type: 'closeTab', id: 3 });
    while (s.tabs.length < MAX_TABS) s = reduce(s, { type: 'addTab', mode: 'empty' });
    expect(reduce(s, action)).toBe(s);
    expect(restoreTabError(s.tabs, action.name)).toBe(RESTORE_TAB_FULL_TEXT);
  });

  it('(c) 同じ名前のタブがあれば何もしない（renameTab・addTab の両方）', () => {
    const before = three('legs');
    const action = restoreTabAction(before, 3);
    if (!action) throw new Error('写しが作れない');
    const closed = reduce(before, { type: 'closeTab', id: 3 });
    // renameTab で A を C に
    const renamed = reduce(closed, { type: 'renameTab', id: 1, name: 'C' });
    expect(reduce(renamed, action)).toBe(renamed);
    expect(restoreTabError(renamed.tabs, action.name)).toBe(RESTORE_TAB_TAKEN_TEXT);
    // addTab は空いている最初の文字 C を使う
    const added = reduce(closed, { type: 'addTab', mode: 'empty' });
    expect(added.tabs.map((t) => t.name)).toContain('C');
    expect(reduce(added, action)).toBe(added);
    expect(restoreTabError(added.tabs, action.name)).toBe(RESTORE_TAB_TAKEN_TEXT);
  });

  it('名前が空になるものは戻さない・index は丸める', () => {
    const before = three('legs');
    const action = restoreTabAction(before, 3);
    if (!action) throw new Error('写しが作れない');
    const closed = reduce(before, { type: 'closeTab', id: 3 });
    expect(reduce(closed, { ...action, name: '  ' })).toBe(closed);
    expect(restoreTabError(closed.tabs, ' \u0000 ')).toBe(RESTORE_TAB_TAKEN_TEXT);
    const far = reduce(closed, { ...action, index: 99 });
    expect(far.tabs.map((t) => t.name)).toEqual(['A', 'B', 'C']);
    const neg = reduce(closed, { ...action, index: Number.NaN });
    expect(neg.tabs.map((t) => t.name)).toEqual(['C', 'A', 'B']);
    expect(reduce(closed, { ...action, index: -3 }).tabs[0]?.name).toBe('C');
    expect(reduce(closed, { ...action, index: 1.9 }).tabs[1]?.name).toBe('C');
  });

  it('(d) 閉じたタブを重ねたピンは戻さない', () => {
    const before = run(three('legs'), { type: 'addPin', source: { kind: 'tab', tabId: 3 } });
    expect(before.pins.some((p) => p.kind === 'tab' && p.tabId === 3)).toBe(true);
    const { restored } = closeAndRestore(before, 3);
    expect(restored.pins.filter((p) => p.kind === 'tab')).toEqual([]);
  });

  it('(e) 戻した後の保存の形（キー・版）は閉じる前と同じ', () => {
    const before = three('legs');
    for (const id of [2, 3]) {
      const { restored } = closeAndRestore(before, id);
      const a = toSavedWorkspace(before, 0);
      const b = toSavedWorkspace(restored, 0);
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
      expect(b.schema_version).toBe(a.schema_version);
      expect(b.tabs.map((t) => Object.keys(t).sort())).toEqual(
        a.tabs.map((t) => Object.keys(t).sort()),
      );
      expect(b.active).toBe(a.active);
      expect(b.tabs.map((t) => t.name)).toEqual(a.tabs.map((t) => t.name));
      expect(b.tabs.map((t) => t.position.legs)).toEqual(a.tabs.map((t) => t.position.legs));
    }
  });

  it('性質: 固定の種の乱数 300 手で不変条件と restoreTabError ⇔ 変化の同値', () => {
    const rand = rng(87);
    const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(rand() * xs.length)];
    let s = run(loaded(chain), board(0, 'call', 'buy'));
    const kept: RestoreTabAction[] = [];
    for (let step = 0; step < 300; step++) {
      const r = rand();
      if (r < 0.2) s = reduce(s, { type: 'addTab', mode: rand() < 0.5 ? 'empty' : 'copy' });
      else if (r < 0.35) {
        const t = pick(s.tabs);
        if (t) s = reduce(s, { type: 'switchTab', id: t.id });
      } else if (r < 0.55) {
        const t = pick(s.tabs);
        if (t) {
          const a = restoreTabAction(s, t.id);
          if (a) kept.push(a);
          s = reduce(s, { type: 'closeTab', id: t.id });
        }
      } else if (r < 0.8) {
        const a = pick(kept);
        if (a) {
          const next = reduce(s, a);
          expect(next !== s).toBe(restoreTabError(s.tabs, a.name) === null);
          s = next;
        }
      } else if (r < 0.9) {
        const t = pick(s.tabs);
        if (t)
          s = reduce(s, { type: 'renameTab', id: t.id, name: pick(['A', 'B', 'C', 'X']) ?? 'X' });
      } else s = reduce(s, board(Math.floor(rand() * 7) - 3, 'put', 'buy'));
      invariant(s);
    }
  });
});

describe('closedTabText', () => {
  it('足の本数（0 本は出さない）', () => {
    expect(closedTabText('A', 2)).toBe('タブ A（足 2 本）を閉じた');
    expect(closedTabText('長いタブの名前', 0)).toBe('タブ 長いタブの名前 を閉じた');
  });
});

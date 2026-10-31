import { describe, expect, it } from 'vitest';
import { ZERO_SCENARIO } from '../../model';
import { MAX_TABS, type TabSlot } from '../../ui/state';
import {
  closeConfirmText,
  openInNewTabError,
  renameError,
  SHARE_FALLBACK_TEXT,
  SHARE_UNSUPPORTED_TEXT,
  shareCopiedMessage,
  shareCopyDisabled,
  shareMakeError,
  TAB_NAME_EMPTY_TEXT,
  TAB_NAME_TAKEN_TEXT,
  TABS_FULL_TEXT,
  type TabKeyInput,
  tabKeyKind,
  tabKeyTarget,
  tabMoveKey,
  tabsModel,
} from '../../ui/view/tabs';

const leg = {
  leg: {
    kind: 'future' as const,
    product: 'fut_mini' as const,
    contract: '2026-12',
    side: 'buy' as const,
    qty: 1,
    entry: 67880,
  },
  marks: [],
};

function slot(id: number, name: string, legs: number | null): TabSlot {
  return {
    id,
    name,
    saved:
      legs === null
        ? null
        : {
            legs: Array.from({ length: legs }, () => leg),
            scenario: ZERO_SCENARIO,
            boardSnapshotAt: null,
          },
  };
}

/** #71 AC1・AC2・AC8: タブの帯の表示モデル。 */
describe('tabsModel', () => {
  it('名前・足の本数（作業中は State の足、他は退避した足。0 本は出さない）・aria の文言', () => {
    const v = tabsModel([slot(1, 'A', 3), slot(2, 'B', null), slot(3, 'C', 0)], 2, 2);
    expect(v.tabs.map((t) => [t.name, t.legCount, t.countText, t.active])).toEqual([
      ['A', 3, '3', false],
      ['B', 2, '2', true],
      ['C', 0, null, false],
    ]);
    expect(v.tabs.map((t) => t.label)).toEqual(['A（足 3 本）', 'B（足 2 本）', 'C（足なし）']);
    expect(v.active.name).toBe('B');
    expect(v.canAdd).toBe(true);
    expect(v.canClose).toBe(true);
    expect(v.addTitle).toBe('タブを足す');
  });

  it(`上限 ${MAX_TABS} 個で ＋ を押せない（理由を title に）。1 個なら閉じられない`, () => {
    const full = Array.from({ length: MAX_TABS }, (_, i) =>
      slot(i + 1, String(i), i === 0 ? null : 1),
    );
    const v = tabsModel(full, 1, 0);
    expect(v.canAdd).toBe(false);
    expect(v.addTitle).toBe(TABS_FULL_TEXT);
    expect(TABS_FULL_TEXT).toBe('タブは 6 個まで');
    expect(tabsModel([slot(1, 'A', null)], 1, 0).canClose).toBe(false);
  });

  it('名前は文字列のまま（HTML として扱わない。表示は JSX のテキスト）', () => {
    const v = tabsModel([slot(1, '<b>x</b>', null)], 1, 1);
    expect(v.tabs[0]?.name).toBe('<b>x</b>');
    expect(v.tabs[0]?.label).toBe('<b>x</b>（足 1 本）');
  });

  it('#301 AC15: 保有のタブは印（held）と「保有」を含む label。印なしは今の文字列', () => {
    const held = (t: TabSlot): TabSlot => ({ ...t, held: true });
    const v = tabsModel([held(slot(1, 'A', 3)), slot(2, 'B', null), held(slot(3, 'C', 0))], 2, 2);
    expect(v.tabs.map((t) => t.held)).toEqual([true, false, true]);
    expect(v.tabs.map((t) => t.label)).toEqual([
      'A（保有・足 3 本）',
      'B（足 2 本）',
      'C（保有・足なし）',
    ]);
    expect(v.active.held).toBe(false);
    expect(tabsModel([held(slot(1, 'A', null))], 1, 2).active).toMatchObject({
      held: true,
      label: 'A（保有・足 2 本）',
    });
  });
});

describe('closeConfirmText', () => {
  it('足があれば確認の文言、無ければ null（すぐ閉じる）', () => {
    expect(closeConfirmText('B', 3)).toBe('タブ B（足 3 本）を閉じる。保存一覧に無い内容は消える');
    expect(closeConfirmText('B', 0)).toBeNull();
  });
});

describe('tabKeyTarget（←/→・Home/End）', () => {
  const ids = [1, 4, 7];
  it('←/→ は隣（端では反対の端へ回る）、Home/End は端、他のキーは null', () => {
    expect(tabKeyTarget(ids, 4, 'ArrowRight')).toBe(7);
    expect(tabKeyTarget(ids, 7, 'ArrowRight')).toBe(1);
    expect(tabKeyTarget(ids, 4, 'ArrowLeft')).toBe(1);
    expect(tabKeyTarget(ids, 1, 'ArrowLeft')).toBe(7);
    expect(tabKeyTarget(ids, 4, 'Home')).toBe(1);
    expect(tabKeyTarget(ids, 4, 'End')).toBe(7);
    expect(tabKeyTarget(ids, 4, 'Enter')).toBeNull();
    expect(tabKeyTarget(ids, 9, 'ArrowRight')).toBeNull();
    expect(tabKeyTarget([], 1, 'Home')).toBeNull();
  });
});

describe('tabKeyKind・tabMoveKey（#323 Ctrl / ⌘ + Shift + ← →）', () => {
  const ids = [1, 4, 7];
  const k = (key: string, m: Partial<TabKeyInput> = {}): TabKeyInput => ({
    key,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    isComposing: false,
    keyCode: 0,
    ...m,
  });
  const ctrlShift = { ctrl: true, shift: true };
  const metaShift = { meta: true, shift: true };

  it('Ctrl + Shift / ⌘ + Shift + → で右、← で左（動かした後の添字）', () => {
    expect(tabMoveKey(ids, 4, k('ArrowRight', ctrlShift))).toBe(2);
    expect(tabMoveKey(ids, 4, k('ArrowLeft', ctrlShift))).toBe(0);
    expect(tabMoveKey(ids, 4, k('ArrowRight', metaShift))).toBe(2);
    expect(tabMoveKey(ids, 4, k('ArrowLeft', metaShift))).toBe(0);
    expect(tabMoveKey(ids, 1, k('ArrowRight', { ctrl: true, meta: true, shift: true }))).toBe(1);
    expect(tabKeyKind(k('ArrowRight', ctrlShift))).toBe('move');
  });

  it('端では null（回らない）。無い id も null', () => {
    expect(tabMoveKey(ids, 7, k('ArrowRight', ctrlShift))).toBeNull();
    expect(tabMoveKey(ids, 1, k('ArrowLeft', ctrlShift))).toBeNull();
    expect(tabMoveKey([5], 5, k('ArrowRight', metaShift))).toBeNull();
    expect(tabMoveKey(ids, 9, k('ArrowRight', ctrlShift))).toBeNull();
  });

  it('修飾なし / Shift だけ / Ctrl だけ / ⌘ だけ / Alt 付き / IME の変換中 / 他のキーは null', () => {
    const cases: Array<[TabKeyInput, 'plain' | 'other']> = [
      [k('ArrowRight'), 'plain'],
      [k('ArrowRight', { shift: true }), 'other'],
      [k('ArrowRight', { ctrl: true }), 'other'],
      [k('ArrowRight', { meta: true }), 'other'],
      [k('ArrowRight', { ...ctrlShift, alt: true }), 'other'],
      [k('ArrowRight', { alt: true }), 'other'],
      [k('ArrowRight', { ...ctrlShift, isComposing: true }), 'other'],
      [k('Process', ctrlShift), 'other'],
      [k('ArrowRight', { ...ctrlShift, keyCode: 229 }), 'other'],
      [k('ArrowRight', { isComposing: true }), 'other'],
      [k('Home', ctrlShift), 'other'],
      [k('ArrowUp', ctrlShift), 'other'],
    ];
    for (const [input, kind] of cases) {
      expect(tabMoveKey(ids, 4, input), JSON.stringify(input)).toBeNull();
      expect(tabKeyKind(input), JSON.stringify(input)).toBe(kind);
    }
  });
});

describe('renameError（名前の変更を断る理由。reducer の renameTab と同じ規則）', () => {
  const tabs = [
    { id: 1, name: 'A' },
    { id: 2, name: 'ヘッジ案' },
  ];
  it('空（正規化した後）・他のタブと同じ名前は断る。自分の今の名前・空いている名前は null', () => {
    expect(TAB_NAME_EMPTY_TEXT).toBe('名前を入れる');
    expect(TAB_NAME_TAKEN_TEXT).toBe('同じ名前のタブがある');
    expect(renameError(tabs, 1, ' ‏ ')).toBe(TAB_NAME_EMPTY_TEXT);
    expect(renameError(tabs, 1, 'ヘッジ案')).toBe(TAB_NAME_TAKEN_TEXT);
    expect(renameError(tabs, 1, ' ヘッジ案\u0007 ')).toBe(TAB_NAME_TAKEN_TEXT);
    expect(renameError(tabs, 2, 'A')).toBe(TAB_NAME_TAKEN_TEXT);
    expect(renameError(tabs, 1, 'A')).toBeNull();
    expect(renameError(tabs, 1, 'B')).toBeNull();
  });
});

describe('openInNewTabError（保存一覧の [新しいタブで開く]）', () => {
  it(`タブが ${MAX_TABS} 個なら理由（一覧を閉じずに出す）、それ未満は null`, () => {
    expect(openInNewTabError(MAX_TABS)).toBe(TABS_FULL_TEXT);
    expect(openInNewTabError(MAX_TABS + 1)).toBe(TABS_FULL_TEXT);
    expect(openInNewTabError(MAX_TABS - 1)).toBeNull();
    expect(openInNewTabError(1)).toBeNull();
  });
});

/** #72: [URL をコピー] の文言（数だけ。URL の中身を入れない）。 */
describe('URL をコピー', () => {
  const ok = (length: number, long: boolean) =>
    ({ kind: 'ok', url: `https://example.invalid/#p=1.${'A'.repeat(4)}`, length, long }) as const;

  it('押せない理由: 足 0 本・このブラウザで作れない', () => {
    expect(shareCopyDisabled(0, true)).toBe('足が無い');
    expect(shareCopyDisabled(3, false)).toBe(SHARE_UNSUPPORTED_TEXT);
    expect(shareCopyDisabled(3, true)).toBeNull();
  });

  it('コピーした（字数）。長い URL は注意を添える。欄に出したときは選んでコピーする旨', () => {
    expect(shareCopiedMessage(ok(812, false), false)).toEqual({
      text: 'コピーした（812 字）',
      warn: false,
    });
    const long = shareCopiedMessage(ok(2345, true), false);
    expect(long.warn).toBe(true);
    expect(long.text).toMatch(/^コピーした（2,345 字）。長い URL（2,000 字 超）/);
    expect(shareCopiedMessage(ok(812, false), true)).toEqual({
      text: SHARE_FALLBACK_TEXT,
      warn: true,
    });
    expect(long.text).not.toContain('#p=');
  });

  it('作れない理由: 長すぎる（字数と上限）・非対応・失敗。作れたら null', () => {
    expect(shareMakeError({ kind: 'tooLong', length: 9123 })).toBe(
      '足が多すぎて URL にできない（9,123 字。上限 8,000 字）。保存一覧の書き出しを使う',
    );
    expect(shareMakeError({ kind: 'unsupported' })).toBe(SHARE_UNSUPPORTED_TEXT);
    expect(shareMakeError({ kind: 'failed' })).toBe('URL を作れなかった');
    expect(shareMakeError(ok(800, false))).toBeNull();
  });
});

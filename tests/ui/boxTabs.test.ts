import { describe, expect, it } from 'vitest';
import type { ShareMake } from '../../ui/share';
import { MAX_TABS, type TabSlot } from '../../ui/state';
import {
  addMenuModel,
  closedTabText,
  HELD_NO_LEGS_TEXT,
  revealScrollLeft,
  shareItemState,
  shareResultView,
  tabMenuModel,
} from '../../ui/view/boxTabs';
import {
  SHARE_FALLBACK_TEXT,
  SHARE_PREPARING_TEXT,
  SHARE_UNSUPPORTED_TEXT,
  shareCopiedMessage,
  shareMakeError,
  TABS_FULL_TEXT,
  tabsModel,
} from '../../ui/view/tabs';

/** #87 (B) AC-12・AC-13: BOX タブのメニュー・URL をコピーの判定と文、帯のスクロール */

const pos = { legs: [], scenario: { days: 0, dX: 0, dSigma: 0, dSkew: 0 }, boardSnapshotAt: null };
function view(n: number) {
  const tabs: TabSlot[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: String.fromCharCode(65 + i),
    saved: i === 0 ? null : (pos as unknown as TabSlot['saved']),
  }));
  return tabsModel(tabs, 1, 2);
}
const okShare = { disabled: false, title: 't' };

describe('tabMenuModel', () => {
  it('タブ 1 個: 閉じるが無い', () => {
    const rows = tabMenuModel(view(1), okShare);
    expect(rows.map((r) => r.key)).toEqual(['rename', 'copy', 'held', 'save', 'share']);
    expect(rows.find((r) => r.key === 'copy')?.disabled).toBeUndefined();
  });

  it('タブ 2 個: 閉じるは区切りの後', () => {
    const rows = tabMenuModel(view(2), okShare);
    expect(rows.map((r) => r.label)).toEqual([
      '名前を変える…',
      '複製',
      '保有にする',
      '保存一覧に保存…',
      'URL をコピー',
      '閉じる',
    ]);
    expect(rows[5]?.sep).toBe(true);
  });

  it(`タブ ${MAX_TABS} 個: 複製を押せない（理由は title）`, () => {
    const copy = tabMenuModel(view(MAX_TABS), okShare).find((r) => r.key === 'copy');
    expect(copy).toMatchObject({ disabled: true, title: TABS_FULL_TEXT });
  });

  it('URL をコピーの状態をそのまま映す', () => {
    const share = tabMenuModel(view(2), { disabled: true, title: '足が無い' })[4];
    expect(share).toMatchObject({ key: 'share', disabled: true, title: '足が無い' });
  });
});

describe('tabMenuModel の 保有にする / 保有を外す（#301 AC15）', () => {
  const tabsOf = (held: boolean): TabSlot[] => [
    { id: 1, name: 'A', saved: null, ...(held ? { held: true as const } : {}) },
    { id: 2, name: 'B', saved: pos as unknown as TabSlot['saved'] },
  ];
  const heldRow = (held: boolean, legCount: number) =>
    tabMenuModel(tabsModel(tabsOf(held), 1, legCount), okShare).find((r) => r.key === 'held');

  it('印なし・足あり: 保有にする（押せる）', () => {
    expect(heldRow(false, 2)).toEqual({ key: 'held', label: '保有にする' });
  });
  it('印なし・足 0 本: 保有にするを押せない（理由 = 足が無い）', () => {
    expect(heldRow(false, 0)).toEqual({
      key: 'held',
      label: '保有にする',
      disabled: true,
      title: HELD_NO_LEGS_TEXT,
    });
  });
  it('保有: 保有を外す（足 0 本でも外せる）', () => {
    expect(heldRow(true, 2)).toEqual({ key: 'held', label: '保有を外す' });
    expect(heldRow(true, 0)).toEqual({ key: 'held', label: '保有を外す' });
  });
});

describe('addMenuModel', () => {
  it('空のタブ / このタブを複製、上限で両方押せない', () => {
    expect(addMenuModel(view(2)).map((r) => [r.key, r.label, r.disabled])).toEqual([
      ['empty', '空のタブ', undefined],
      ['copy', 'このタブを複製', undefined],
    ]);
    for (const r of addMenuModel(view(MAX_TABS))) {
      expect(r).toMatchObject({ disabled: true, title: TABS_FULL_TEXT });
    }
  });
});

describe('shareItemState（5 通り）', () => {
  const ok: ShareMake = { kind: 'ok', url: 'https://example.test/#p=x', length: 25, long: false };
  it('足 0 本 / 作れないブラウザ / 作成中 / ok / tooLong', () => {
    expect(shareItemState(0, true, ok)).toEqual({ disabled: true, title: '足が無い' });
    expect(shareItemState(2, false, ok)).toEqual({ disabled: true, title: SHARE_UNSUPPORTED_TEXT });
    expect(shareItemState(2, true, null)).toEqual({ disabled: true, title: SHARE_PREPARING_TEXT });
    expect(shareItemState(2, true, ok)).toEqual({
      disabled: false,
      title: '作業中のタブを URL にしてコピーする（別の端末で開ける）',
    });
    const tooLong: ShareMake = { kind: 'tooLong', length: 99_999 };
    expect(shareItemState(2, true, tooLong)).toEqual({
      disabled: false,
      title: shareMakeError(tooLong),
    });
  });
});

describe('shareResultView（4 通り）', () => {
  const short = {
    kind: 'ok',
    url: 'https://example.test/?ui=next#p=a',
    length: 1234,
    long: false,
  } as const;
  const long = { ...short, length: 3000, long: true } as const;
  it('コピーした（短い）= 1 行のトースト', () => {
    expect(shareResultView({ kind: 'copied', make: short })).toEqual({
      toast: { kind: 'share', text: 'コピーした（1,234 字）' },
    });
    expect(shareCopiedMessage(short, false).text).toBe('コピーした（1,234 字）');
  });
  it('コピーした（長い）= 警告の知らせ', () => {
    expect(shareResultView({ kind: 'copied', make: long })).toEqual({
      toast: { kind: 'share', text: shareCopiedMessage(long, false).text, note: 'warn' },
    });
  });
  it('書けない = ダイアログ（URL と SHARE_FALLBACK_TEXT で始まる文）', () => {
    const r = shareResultView({ kind: 'fallback', make: long });
    expect(r).toEqual({ dialog: { url: long.url, text: shareCopiedMessage(long, true).text } });
    if ('dialog' in r) expect(r.dialog.text.startsWith(SHARE_FALLBACK_TEXT)).toBe(true);
  });
  it('作れない = 警告の知らせ（shareMakeError の文）', () => {
    for (const make of [
      { kind: 'tooLong', length: 9000 },
      { kind: 'unsupported' },
      { kind: 'failed' },
    ] as const) {
      expect(shareResultView({ kind: 'error', make })).toEqual({
        toast: { kind: 'share', text: shareMakeError(make), note: 'warn' },
      });
    }
  });
});

describe('revealScrollLeft', () => {
  it('左に切れる / 右に切れる / 収まる / 帯より広い / 非有限', () => {
    expect(revealScrollLeft(100, 200, 40, 60)).toBe(40);
    expect(revealScrollLeft(0, 200, 180, 60)).toBe(40);
    expect(revealScrollLeft(50, 200, 100, 60)).toBe(50);
    expect(revealScrollLeft(50, 200, 120, 300)).toBe(120);
    expect(revealScrollLeft(50, Number.NaN, 120, 30)).toBe(50);
    expect(revealScrollLeft(50, 200, Number.POSITIVE_INFINITY, 30)).toBe(50);
  });

  it('pad（#87 (C)）: 左は引いて 0 未満にしない・右は足す・収まるなら今のまま・非有限は 0 扱い', () => {
    expect(revealScrollLeft(100, 200, 40, 60, 3)).toBe(37);
    expect(revealScrollLeft(100, 200, 2, 60, 3)).toBe(0);
    expect(revealScrollLeft(0, 200, 180, 60, 3)).toBe(43);
    expect(revealScrollLeft(50, 200, 100, 60, 3)).toBe(50);
    expect(revealScrollLeft(50, 200, 120, 300, 3)).toBe(117);
    expect(revealScrollLeft(100, 200, 40, 60, Number.NaN)).toBe(40);
    expect(revealScrollLeft(0, 200, 180, 60, Number.NaN)).toBe(40);
  });
});

describe('tabMenuModel の 保存一覧に保存…（#87 (C)）', () => {
  it('複製の直後・上限でも押せる', () => {
    for (const n of [1, 2, MAX_TABS]) {
      const rows = tabMenuModel(view(n), okShare);
      const i = rows.findIndex((r) => r.key === 'save');
      // 複製の次は保有の行（#301）、その次が保存一覧に保存…
      expect(rows[i - 2]?.key).toBe('copy');
      expect(rows[i - 1]?.key).toBe('held');
      expect(rows[i]).toEqual({ key: 'save', label: '保存一覧に保存…' });
    }
  });
});

describe('closedTabText', () => {
  it('0 本 / 2 本', () => {
    expect(closedTabText('B', 0)).toBe('タブ B を閉じた');
    expect(closedTabText('B', 2)).toBe('タブ B（足 2 本）を閉じた');
  });
});

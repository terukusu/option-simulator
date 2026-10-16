import { describe, expect, it } from 'vitest';
import { ZERO_SCENARIO } from '../../model';
import type { Workspace } from '../../ui/persist';
import { initialState } from '../../ui/state';
import {
  bootNote,
  dropNote,
  NEWER_OTHER_TAB_NOTE,
  OTHER_TAB_NOTE,
  pushNote,
  saveFailedNote,
} from '../../ui/view/persistNote';

const ui = {
  atmBasis: initialState.atmBasis,
  monthId: null,
  target: initialState.target,
  filterAsk: false,
  smileAxis: initialState.smileAxis,
  feePerLot: 0,
  futureBasis: initialState.futureBasis,
  metricsUnit: initialState.metricsUnit,
  pnlY: initialState.pnlY,
  pnlFolded: false,
  hedge: initialState.hedge,
};

function saved(nLegs: number, savedAt: number | null, snap: number | null): Workspace {
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
  return {
    savedAt,
    position: {
      boardSnapshotAt: snap,
      legs: Array.from({ length: nLegs }, () => leg),
      scenario: ZERO_SCENARIO,
    },
    ui,
  };
}

/** #23 AC3・AC4: 復元・読めない・新しい版・保存できない・別のタブの知らせ。 */
describe('persistNote', () => {
  const SAVED = Date.parse('2026-11-02T12:47:00Z'); // JST 21:47
  const SNAP = Date.parse('2026-11-02T21:31:00+09:00');

  it('復元: 足の本数・保存の時刻・そのときの板の時刻（足が 0 本なら出さない）', () => {
    expect(bootNote({ kind: 'ok', saved: saved(3, SAVED, SNAP), dropped: false })).toEqual({
      kind: 'restored',
      text: '前回の作業を復元した（足 3 本。保存 2026-11-02 21:47、そのときの板 2026-11-02 21:31）。建値は保存時のまま',
      warn: false,
    });
    expect(bootNote({ kind: 'ok', saved: saved(1, null, null), dropped: false })?.text).toBe(
      '前回の作業を復元した（足 1 本）。建値は保存時のまま',
    );
    expect(bootNote({ kind: 'ok', saved: saved(0, SAVED, SNAP), dropped: false })).toBeNull();
    expect(bootNote({ kind: 'empty' })).toBeNull();
  });

  it('読めない・足を捨てた・新しい版は注意', () => {
    expect(bootNote({ kind: 'invalid' })?.text).toMatch(/読めなかった/);
    const dropped = bootNote({
      kind: 'ok',
      saved: { ...saved(0, SAVED, null), position: null },
      dropped: true,
    });
    expect(dropped?.kind).toBe('dropped');
    expect(dropped?.text).toMatch(/設定だけ戻した/);
    const newer = bootNote({ kind: 'newer', version: 2 });
    expect(newer?.text).toMatch(/新しい版/);
    expect(newer?.text).toMatch(/保存しない/);
    expect([dropped?.warn, newer?.warn]).toEqual([true, true]);
  });

  it('保存できない: 容量 / 設定で文言を分ける。ok なら null', () => {
    expect(saveFailedNote('ok')).toBeNull();
    expect(saveFailedNote('quota')?.text).toMatch(/容量/);
    expect(saveFailedNote('unavailable')?.text).toMatch(/ブラウザの設定/);
    expect(saveFailedNote('quota')?.text).toMatch(/再読み込みすると足・設定は消える/);
  });

  it('pushNote: 同じ種類は置き換え、null は足さない', () => {
    const a = pushNote([], OTHER_TAB_NOTE);
    expect(pushNote(a, OTHER_TAB_NOTE)).toHaveLength(1);
    expect(pushNote(a, null)).toEqual(a);
    const b = pushNote(a, saveFailedNote('quota'));
    expect(b.map((n) => n.kind)).toEqual(['otherTab', 'saveFailed']);
  });

  it('別のタブの新しい版: 版の知らせ（newer）で、別のタブの知らせを置き換える', () => {
    expect(NEWER_OTHER_TAB_NOTE.kind).toBe('newer');
    expect(NEWER_OTHER_TAB_NOTE.warn).toBe(true);
    expect(NEWER_OTHER_TAB_NOTE.text).toMatch(/新しい版/);
    expect(NEWER_OTHER_TAB_NOTE.text).toMatch(/保存しない/);
    const ns = pushNote(dropNote(pushNote([], OTHER_TAB_NOTE), 'otherTab'), NEWER_OTHER_TAB_NOTE);
    expect(ns.map((n) => n.kind)).toEqual(['newer']);
  });

  it('dropNote: その種類だけ消す。無ければ同じ配列（描き直さない）', () => {
    const failed = saveFailedNote('quota');
    const ns = pushNote(pushNote([], OTHER_TAB_NOTE), failed);
    expect(dropNote(ns, 'saveFailed').map((n) => n.kind)).toEqual(['otherTab']);
    const none = pushNote([], OTHER_TAB_NOTE);
    expect(dropNote(none, 'saveFailed')).toBe(none);
  });
});

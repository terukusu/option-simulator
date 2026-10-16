/**
 * 作業の保存・復元の知らせ（topbar の下の 1 行。純関数。#23）。文言は固定で、保存した値を反射しない
 * （数・時刻だけを書式して入れる）。
 */

import type { ReadResult } from '../persist';
import type { WriteResult } from '../storage';
import { fmtDateTime } from './format';

export type PersistNoteKind =
  | 'restored'
  | 'dropped'
  | 'invalid'
  | 'newer'
  | 'saveFailed'
  | 'otherTab';

export interface PersistNote {
  kind: PersistNoteKind;
  text: string;
  /** 注意（warn の色） */
  warn: boolean;
}

/** 開いたときの読み取りの結果の知らせ（出さなければ null）。 */
export function bootNote(read: ReadResult): PersistNote | null {
  switch (read.kind) {
    case 'empty':
      return null;
    case 'invalid':
      return {
        kind: 'invalid',
        text: '保存した作業を読めなかった（形式が壊れている）。既定の状態で開いた',
        warn: true,
      };
    case 'newer':
      return {
        kind: 'newer',
        text: '新しい版で保存された作業は読めない（この画面では保存しない。新しい版の保存は残す）',
        warn: true,
      };
    case 'ok': {
      const { saved } = read;
      if (read.dropped) {
        return {
          kind: 'dropped',
          text: '保存した足を読めなかった（形式が壊れている）。設定だけ戻した',
          warn: true,
        };
      }
      const active = saved.tabs[saved.active] ?? saved.tabs[0];
      const n = active?.position.legs.length ?? 0;
      const total = saved.tabs.reduce((a, t) => a + t.position.legs.length, 0);
      // 一部のタブを捨てた: 注意として出す（残りを復元した）
      if (read.droppedTabs > 0) {
        return {
          kind: 'dropped',
          text: `保存したタブ ${read.droppedTabs} 個を読めなかった（形式が壊れている）。残りのタブ ${saved.tabs.length} 個を復元した`,
          warn: true,
        };
      }
      if (total === 0) return null;
      const at = saved.savedAt === null ? '' : `。保存 ${fmtDateTime(saved.savedAt)}`;
      const snap = active?.position.boardSnapshotAt ?? null;
      const board = snap === null ? '' : `、そのときの板 ${fmtDateTime(snap)}`;
      // タブが 1 個なら #23 と同じ文。複数なら個数と作業中のタブを添える（名前は入れない。保存した値を反射しない）
      const what =
        saved.tabs.length > 1
          ? `タブ ${saved.tabs.length} 個・作業中のタブの足 ${n} 本`
          : `足 ${n} 本`;
      return {
        kind: 'restored',
        text: `前回の作業を復元した（${what}${at}${board}）。建値は保存時のまま`,
        warn: false,
      };
    }
  }
}

/** 書き込みに失敗したときの知らせ（ok なら null）。 */
export function saveFailedNote(result: WriteResult): PersistNote | null {
  if (result === 'ok') return null;
  return {
    kind: 'saveFailed',
    text:
      result === 'quota'
        ? 'この端末に作業を保存できない（容量の不足）。再読み込みすると足・設定は消える'
        : 'この端末に作業を保存できない（ブラウザの設定・プライベートモード）。再読み込みすると足・設定は消える',
    warn: true,
  };
}

/** 開いたあとに別のタブが新しい版で保存したときの知らせ（このタブはそれ以降保存しない）。 */
export const NEWER_OTHER_TAB_NOTE: PersistNote = {
  kind: 'newer',
  text: '別のタブが新しい版で作業を保存した。このタブでは以後保存しない（新しい版の保存を残す。ページを再読み込みすると新しい版で開く）',
  warn: true,
};

/** 別のタブが作業を保存したときの知らせ。 */
export const OTHER_TAB_NOTE: PersistNote = {
  kind: 'otherTab',
  text: '別のタブで作業が保存された。このタブで操作すると、このタブの内容で上書きする（取り込むにはページを再読み込み）',
  warn: true,
};

/** 知らせを足す（同じ種類は置き換え。並びは足した順）。 */
export function pushNote(notes: readonly PersistNote[], note: PersistNote | null): PersistNote[] {
  if (!note) return [...notes];
  return [...notes.filter((n) => n.kind !== note.kind), note];
}

/** 知らせを 1 種類消す（無ければ同じ配列を返す＝描き直さない）。 */
export function dropNote(notes: PersistNote[], kind: PersistNoteKind): PersistNote[] {
  return notes.some((n) => n.kind === kind) ? notes.filter((n) => n.kind !== kind) : notes;
}

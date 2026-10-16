/**
 * 作業の保存・復元の知らせ（topbar の下の 1 行。純関数。#23）。文言は固定で、保存した値を反射しない
 * （数・時刻だけを書式して入れる）。
 */

import type { ReadResult } from '../persist';
import type { ShareRead } from '../share';
import type { WriteResult } from '../storage';
import { fmtDateTime } from './format';

export type PersistNoteKind =
  | 'restored'
  | 'dropped'
  | 'invalid'
  | 'newer'
  | 'saveFailed'
  | 'otherTab'
  /** URL 共有（#72）を開いた・読めなかった */
  | 'shared';

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

/**
 * URL 共有（#72）を開いた・読めなかったときの知らせ（扱わなければ null）。opened = 開いた先（ok のときだけ）。
 * 固定の文 + 数・時刻だけ（URL の中の名前・建値などの文字列は入れない。開いたタブは帯で分かる）。
 */
export function shareNote(
  read: ShareRead,
  opened: 'replace' | 'newTab' | null = null,
): PersistNote | null {
  const warn = (text: string): PersistNote => ({ kind: 'shared', text, warn: true });
  switch (read.kind) {
    case 'none':
      return null;
    case 'invalid':
      return warn(
        'URL のポジションを読めなかった（壊れているか途中で切れている）。作業は変えていない',
      );
    case 'tooLong':
      return warn('URL が長すぎて読まない。作業は変えていない');
    case 'tooLarge':
      return warn('URL の中身が大きすぎて読まない。作業は変えていない');
    case 'newer':
      return warn(
        '新しい版で作った URL は読めない（ページを再読み込みして新しい版で開く）。作業は変えていない',
      );
    case 'noLegs':
      return warn('URL に足が無い。作業は変えていない');
    case 'unsupported':
      return warn(
        'このブラウザでは URL のポジションを開けない（iOS 16.4 以上・最新のブラウザで開く）',
      );
    case 'ok': {
      const { shared } = read;
      const where = opened === 'newTab' ? '新しいタブで' : '作業中のタブで';
      const at = shared.savedAt === null ? '' : `。共有 ${fmtDateTime(shared.savedAt)}`;
      const board =
        shared.boardSnapshotAt === null
          ? ''
          : `、そのときの板 ${fmtDateTime(shared.boardSnapshotAt)}`;
      return {
        kind: 'shared',
        text: `URL のポジションを${where}開いた（足 ${shared.legs.length} 本${at}${board}）。建値は共有時のまま。シナリオ・手数料・先物の basis は今のまま（URL の値は使わない）`,
        warn: false,
      };
    }
  }
}

/**
 * タブが上限のとき URL のポジションで作業中のタブを置き換えるかの確認の文言（名前は受け手のタブの名前）。
 */
export function shareReplaceConfirmText(
  maxTabs: number,
  legCount: number,
  activeName: string,
  activeLegCount: number,
): string {
  return `タブは ${maxTabs} 個まで。URL のポジション（足 ${legCount} 本）を開くと作業中のタブ ${activeName}（足 ${activeLegCount} 本）が置き換わる（保存一覧に無い内容は消える）`;
}

/** 知らせを足す（同じ種類は置き換え。並びは足した順）。 */
export function pushNote(notes: readonly PersistNote[], note: PersistNote | null): PersistNote[] {
  if (!note) return [...notes];
  return [...notes.filter((n) => n.kind !== note.kind), note];
}

/** 知らせを 1 種類消す（無ければ同じ配列を返す＝描き直さない）。 */
export function dropNote(notes: PersistNote[], kind: PersistNoteKind): PersistNote[] {
  return notes.some((n) => n.kind === kind) ? notes.filter((n) => n.kind !== kind) : notes;
}

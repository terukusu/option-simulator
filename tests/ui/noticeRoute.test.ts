import { describe, expect, it } from 'vitest';
import { ZERO_SCENARIO } from '../../model';
import { readWorkspace } from '../../ui/persist';
import type { ShareRead } from '../../ui/share';
import {
  boardNoticeText,
  legErrorToast,
  loadFailedToast,
  noticeRoute,
  WARN_TAG_LABEL,
  warnTagsModel,
} from '../../ui/view/notices';
import {
  bootNote,
  NEWER_OTHER_TAB_NOTE,
  OTHER_TAB_NOTE,
  type PersistNote,
  saveFailedNote,
  shareNote,
  shareReplaceConfirmText,
} from '../../ui/view/persistNote';
import v2 from './saved/workspace-v2.json';

/** #87 AC-3: 知らせの振り分け。文は PersistNote.text（ほかは #81 の知らせの行の文）と 1 字も違わない。 */
const savedText = JSON.stringify(v2);

const must = (n: PersistNote | null): PersistNote => {
  if (!n) throw new Error('知らせが出るはず');
  return n;
};

const toastOf = (n: PersistNote) => {
  const r = noticeRoute(n);
  if (r.to !== 'toast') throw new Error(`トーストのはず: ${n.kind}`);
  return r.toast;
};
const tagOf = (n: PersistNote) => {
  const r = noticeRoute(n);
  if (r.to !== 'tag') throw new Error(`タグのはず: ${n.kind}`);
  return r;
};

describe('noticeRoute', () => {
  it('bootNote: restored = 情報のトースト、invalid・dropped = 警告のトースト、newer = タグ', () => {
    const restored = must(bootNote(readWorkspace(savedText)));
    expect(restored.kind).toBe('restored');
    expect(toastOf(restored)).toEqual({ kind: 'note-restored', text: restored.text, note: 'info' });

    const invalid = must(bootNote(readWorkspace('{')));
    expect(invalid.kind).toBe('invalid');
    expect(toastOf(invalid)).toEqual({ kind: 'note-invalid', text: invalid.text, note: 'warn' });

    const ws = JSON.parse(savedText);
    const broken = { ...ws, tabs: [ws.tabs[0], { name: 'X', position: 1 }] };
    const dropped = must(bootNote(readWorkspace(JSON.stringify(broken))));
    expect(dropped.kind).toBe('dropped');
    expect(toastOf(dropped)).toEqual({ kind: 'note-dropped', text: dropped.text, note: 'warn' });

    const newer = must(bootNote({ kind: 'newer', version: 3 }));
    expect(tagOf(newer)).toEqual({ to: 'tag', kind: 'newer', label: '新しい版', text: newer.text });
  });

  it('saveFailedNote の 2 種・OTHER_TAB_NOTE・NEWER_OTHER_TAB_NOTE はタグ', () => {
    for (const r of ['quota', 'unavailable'] as const) {
      const n = must(saveFailedNote(r));
      expect(tagOf(n)).toEqual({
        to: 'tag',
        kind: 'saveFailed',
        label: '保存できない',
        text: n.text,
      });
    }
    expect(tagOf(OTHER_TAB_NOTE)).toEqual({
      to: 'tag',
      kind: 'otherTab',
      label: '別のタブ',
      text: OTHER_TAB_NOTE.text,
    });
    expect(tagOf(NEWER_OTHER_TAB_NOTE).text).toBe(NEWER_OTHER_TAB_NOTE.text);
    expect(WARN_TAG_LABEL).toEqual({
      newer: '新しい版',
      saveFailed: '保存できない',
      otherTab: '別のタブ',
    });
  });

  it('shareNote の 7 種: 開いた = 情報、読めない 6 種 = 警告のトースト（文は同じ）', () => {
    const shared = {
      legs: [],
      scenario: ZERO_SCENARIO,
      feePerLot: 0,
      futureBasis: 'fixed' as const,
      name: 'A',
      savedAt: null,
      boardSnapshotAt: null,
      held: false,
    };
    const ok = must(shareNote({ kind: 'ok', shared }, 'newTab'));
    expect(toastOf(ok)).toEqual({ kind: 'note-shared', text: ok.text, note: 'info' });
    const kinds: ShareRead['kind'][] = [
      'invalid',
      'tooLong',
      'tooLarge',
      'newer',
      'noLegs',
      'unsupported',
    ];
    for (const kind of kinds) {
      const n = must(shareNote({ kind } as ShareRead));
      expect(toastOf(n)).toEqual({ kind: 'note-shared', text: n.text, note: 'warn' });
    }
  });

  it('共有を開く確認の文はダイアログに渡す shareReplaceConfirmText のまま', () => {
    expect(shareReplaceConfirmText(6, 3, 'A', 2)).toBe(
      'タブは 6 個まで。URL のポジション（足 3 本）を開くと作業中のタブ A（足 2 本）が置き換わる（保存一覧に無い内容は消える）',
    );
  });

  it('legError = 警告のトースト「足を追加できない: …」', () => {
    expect(legErrorToast('板に無い行使価格')).toEqual({
      kind: 'leg-error',
      text: '足を追加できない: 板に無い行使価格',
      note: 'warn',
    });
  });

  it('読み込みの失敗 = 警告のトースト（知らせの行の失敗の文 1 行）', () => {
    const error = { message: '板を読めない（HTTP 500）' };
    expect(loadFailedToast(true, error, '前の板のまま（取得 21:47）')).toEqual({
      kind: 'load-failed',
      text: '板を読めない（HTTP 500）。前の板のまま（取得 21:47）',
      note: 'warn',
    });
    expect(loadFailedToast(true, error, null).text).toBe('板を読めない（HTTP 500）');
    expect(loadFailedToast(false, error, null).text).toBe(
      '板を読めない。[最新] で読み直すか、板の JSON を選んでください。',
    );
  });

  it('#341: ログイン切れ（reload）の失敗は板の有無によらずその文で [ページを読み直す] を出す', () => {
    const auth = {
      message: 'ログインが切れた（[ページを読み直す] でログインし直す）',
      reload: true as const,
    };
    expect(loadFailedToast(true, auth, '前の板のまま（取得 21:47）')).toEqual({
      kind: 'load-failed',
      text: 'ログインが切れた（[ページを読み直す] でログインし直す）。前の板のまま（取得 21:47）',
      note: 'warn',
      reload: true,
    });
    for (const hasChain of [true, false]) {
      expect(loadFailedToast(hasChain, auth, null)).toEqual({
        kind: 'load-failed',
        text: 'ログインが切れた（[ページを読み直す] でログインし直す）',
        note: 'warn',
        reload: true,
      });
    }
    // http・network・invalid は reload のキーが無い（[ページを読み直す] を出さない）
    for (const message of [
      '板を読めない（HTTP 500）',
      '板を読めない（通信エラー）',
      '板の JSON が不正',
    ]) {
      for (const hasChain of [true, false]) {
        expect(loadFailedToast(hasChain, { message }, null)).not.toHaveProperty('reload');
      }
    }
  });

  it('boardNoticeText: #81 の知らせの行と同じ 5 通り', () => {
    const e = { message: 'm' };
    expect(boardNoticeText(true, true, e, 'k')).toEqual({ text: '読み込み中…', warn: false });
    expect(boardNoticeText(false, false, e, null)).toEqual({
      text: '板を読めない。[最新] で読み直すか、板の JSON を選んでください。',
      warn: true,
    });
    expect(boardNoticeText(false, false, null, null)).toEqual({
      text: '板の JSON を選んでください。',
      warn: false,
    });
    expect(boardNoticeText(true, false, e, 'k')).toEqual({ text: 'm。k', warn: true });
    expect(boardNoticeText(true, false, e, null)).toEqual({ text: 'm', warn: true });
    expect(boardNoticeText(true, false, null, null)).toBeNull();
  });
});

describe('warnTagsModel', () => {
  it('重い順 新しい版 > 保存できない > 別のタブ、aria-label は「警告: …」、無ければ null', () => {
    expect(warnTagsModel([])).toBeNull();
    const save = must(saveFailedNote('quota'));
    const restored = must(bootNote(readWorkspace(savedText)));
    const m = warnTagsModel([OTHER_TAB_NOTE, restored, save, NEWER_OTHER_TAB_NOTE]);
    expect(m?.tags.map((t) => t.label)).toEqual(['新しい版', '保存できない', '別のタブ']);
    expect(m?.tags.map((t) => t.text)).toEqual([
      NEWER_OTHER_TAB_NOTE.text,
      save.text,
      OTHER_TAB_NOTE.text,
    ]);
    expect(m?.label).toBe('警告: 新しい版・保存できない・別のタブ');
    expect(warnTagsModel([restored])).toBeNull();
  });
});

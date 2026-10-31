/**
 * 作業中のポジションのタブ（BOX タブ。#71）の帯の表示モデル・確認の文言・キー操作の移り先（純関数）。
 * 設計 docs/design.md 6.1・13.4。名前は JSX のテキスト / 属性で入れる（ここでは文字列として組み立てるだけ）。
 */

import { type ShareMake, URL_MAX, URL_WARN } from '../share';
import { MAX_TABS, sanitizeTabName, type TabSlot } from '../state';
import { fmtNum } from './format';
import { imeComposing, type KeySummary } from './keys';

export interface TabView {
  id: number;
  name: string;
  /** 足の本数 */
  legCount: number;
  /** 足の本数の表示（0 本なら null = 出さない） */
  countText: string | null;
  active: boolean;
  /** 保有の印（#301。帯のチップに「保」） */
  held: boolean;
  /** aria-label・title（名前の全文 + 保有 + 足の本数。帯では名前を省略することがある） */
  label: string;
}

export interface TabsView {
  tabs: TabView[];
  /** ＋ を押せる（上限未満） */
  canAdd: boolean;
  /** 作業中のタブを閉じられる（2 個以上） */
  canClose: boolean;
  /** ＋ の title（上限なら理由） */
  addTitle: string;
  active: TabView;
}

export const TABS_FULL_TEXT = `タブは ${MAX_TABS} 個まで`;

/**
 * 帯の表示モデル。activeLegCount = 作業中のタブの足の本数（State の legs。他のタブは退避した足の本数）。
 */
export function tabsModel(
  tabs: readonly TabSlot[],
  activeTab: number,
  activeLegCount: number,
): TabsView {
  const views = tabs.map((t): TabView => {
    const active = t.id === activeTab;
    const legCount = active ? activeLegCount : (t.saved?.legs.length ?? 0);
    const held = t.held === true;
    const legs = legCount > 0 ? `足 ${legCount} 本` : '足なし';
    return {
      id: t.id,
      name: t.name,
      legCount,
      countText: legCount > 0 ? String(legCount) : null,
      active,
      held,
      label: held ? `${t.name}（保有・${legs}）` : `${t.name}（${legs}）`,
    };
  });
  const canAdd = tabs.length < MAX_TABS;
  const first = views[0];
  const active = views.find((v) => v.active) ?? first;
  if (!active) throw new Error('タブが無い');
  return {
    tabs: views,
    canAdd,
    canClose: tabs.length > 1,
    addTitle: canAdd ? 'タブを足す' : TABS_FULL_TEXT,
    active,
  };
}

export const TAB_NAME_EMPTY_TEXT = '名前を入れる';
export const TAB_NAME_TAKEN_TEXT = '同じ名前のタブがある';

/**
 * 名前の変更を断る理由（変えられるなら null）。reducer の renameTab と同じ規則（正規化して空・他のタブと同じなら断る）。
 * 重複を断るのは、読み取り（readWorkspace）が重複した名前を別の文字に変えるため（再読み込みで名前が黙って変わらないように）。
 */
export function renameError(
  tabs: ReadonlyArray<{ id: number; name: string }>,
  id: number,
  raw: string,
): string | null {
  const name = sanitizeTabName(raw);
  if (name === '') return TAB_NAME_EMPTY_TEXT;
  return tabs.some((t) => t.id !== id && t.name === name) ? TAB_NAME_TAKEN_TEXT : null;
}

/**
 * 保存一覧の [新しいタブで開く] を断る理由（開けるなら null）。押した時点でタブが上限なら一覧を閉じずに出す
 * （ボタンは上限で押せないが、別の経路でタブが増えた直後に押されることがある）。
 */
export function openInNewTabError(tabCount: number): string | null {
  return tabCount >= MAX_TABS ? TABS_FULL_TEXT : null;
}

/** 作業中のタブを閉じるときの確認の文言（足が無ければ null = 確認しないで閉じる）。 */
export function closeConfirmText(name: string, legCount: number): string | null {
  return legCount > 0
    ? `タブ ${name}（足 ${legCount} 本）を閉じる。保存一覧に無い内容は消える`
    : null;
}

/**
 * キー操作の移り先（←/→ は端で反対の端へ回る、Home/End は端）。対象のキーでなければ null。
 * 自動アクティベーション（フォーカスの移動で切り替える。切り替えは 1 フレームの予算に収まるため）。
 */
export function tabKeyTarget(ids: readonly number[], current: number, key: string): number | null {
  const n = ids.length;
  const i = ids.indexOf(current);
  if (n === 0 || i < 0) return null;
  switch (key) {
    case 'ArrowRight':
      return ids[(i + 1) % n] ?? null;
    case 'ArrowLeft':
      return ids[(i - 1 + n) % n] ?? null;
    case 'Home':
      return ids[0] ?? null;
    case 'End':
      return ids[n - 1] ?? null;
    default:
      return null;
  }
}

/** 帯の keydown の要約（#323。KeySummary と同じ名前の部分集合） */
export type TabKeyInput = Pick<
  KeySummary,
  'key' | 'ctrl' | 'meta' | 'alt' | 'shift' | 'isComposing' | 'keyCode'
>;

/**
 * 帯のキーの種類（#323）: 'move' = Ctrl / ⌘ + Shift + ← →（並べ替え。Alt なし）、'plain' = 修飾なし（tabKeyTarget の
 * 切り替え）、'other' = それ以外（Shift だけ・Ctrl だけ・Alt 付き・IME の変換中。何もしない）
 */
export function tabKeyKind(k: TabKeyInput): 'move' | 'plain' | 'other' {
  if (imeComposing(k)) return 'other';
  if (!k.ctrl && !k.meta && !k.alt && !k.shift) return 'plain';
  if (
    (k.ctrl || k.meta) &&
    k.shift &&
    !k.alt &&
    (k.key === 'ArrowLeft' || k.key === 'ArrowRight')
  ) {
    return 'move';
  }
  return 'other';
}

/**
 * 並べ替えのキーで current のタブを動かした後の添字（#323）。端（回らない）・並べ替えのキーでない・無い id は null
 */
export function tabMoveKey(ids: readonly number[], current: number, k: TabKeyInput): number | null {
  if (tabKeyKind(k) !== 'move') return null;
  const i = ids.indexOf(current);
  if (i < 0) return null;
  const to = k.key === 'ArrowRight' ? i + 1 : i - 1;
  return to < 0 || to >= ids.length ? null : to;
}

// ---------------------------------------------------------------- URL 共有（#72）の文言

/** [URL をコピー] の結果の 1 行（warn = 注意の色） */
export interface ShareCopyMessage {
  text: string;
  warn: boolean;
}

const chars = (n: number) => `${fmtNum(n)} 字`;

/** [URL をコピー] を押せない理由（押せるなら null）。足 0 本・このブラウザで作れない。 */
export function shareCopyDisabled(legCount: number, supported: boolean): string | null {
  if (legCount === 0) return '足が無い';
  return supported ? null : SHARE_UNSUPPORTED_TEXT;
}

export const SHARE_UNSUPPORTED_TEXT =
  'このブラウザでは URL を作れない（iOS 16.4 以上・最新のブラウザで使う）';
export const SHARE_PREPARING_TEXT = 'URL を作っている…';
export const SHARE_FALLBACK_TEXT = 'コピーできない。下の欄を選んでコピーする';

/** URL を作れなかった・長すぎるときの文言（作れたなら null）。 */
export function shareMakeError(make: ShareMake): string | null {
  switch (make.kind) {
    case 'ok':
      return null;
    case 'tooLong':
      return `足が多すぎて URL にできない（${chars(make.length)}。上限 ${chars(URL_MAX)}）。保存一覧の書き出しを使う`;
    case 'unsupported':
      return SHARE_UNSUPPORTED_TEXT;
    case 'failed':
      return 'URL を作れなかった';
  }
}

/** コピーしたとき（fallback = クリップボードに書けず欄に出した）の文言。長い URL は注意を添える。 */
export function shareCopiedMessage(
  make: Extract<ShareMake, { kind: 'ok' }>,
  fallback: boolean,
): ShareCopyMessage {
  const head = fallback ? SHARE_FALLBACK_TEXT : `コピーした（${chars(make.length)}）`;
  return make.long
    ? {
        text: `${head}。長い URL（${chars(URL_WARN)} 超）はアプリによっては途中で切れる。切れたら開くときに「読めなかった」と出る`,
        warn: true,
      }
    : { text: head, warn: fallback };
}

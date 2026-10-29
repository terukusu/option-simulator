/**
 * 画面のコマンドパレット（#89 段 B。docs/ui-redesign.md §4.6・§5）の行・検索・キー（純関数）。
 * Preact・DOM・時計・storage に依存しない。部品は ui/next/parts/Palette.tsx、行の実行の振り分けは NextApp。
 *
 * - 行は既存の規則の関数（presetChips・evalChips・pinMenuRows・addMenuModel・marketAddPlan など）の結果を写すだけ
 *   （押せる / 押せない・理由を作り直さない）
 * - 行の実行の記述はデータ（関数を持たない。押せない行は run が null）
 * - 行の id はグループ + 規則のキーで、利用者の文字（タブ名・ピン名）を入れない
 */

import type { Chain } from '../../data';
import type { OptionType, Side } from '../../model';
import type { ThemePref } from '../prefs';
import type { Action } from '../state';
import { atmStrike } from './board';
import { type MarketAddInput, marketAddLabel, marketAddPlan, monthSegOptions } from './boardPanel';
import { addMenuModel } from './boxTabs';
import { GLOSSARY, type TermId, termSearchText } from './glossary';
import {
  CHART_KEY,
  type GlobalKey,
  imeComposing,
  type KeySummary,
  PANEL_KEY,
  THEME_KEY,
} from './keys';
import { type PinMenuInput, pinMenuRows } from './pins';
import { evalChips, presetChips, type ScenarioRegionInput } from './scenarioRegion';
import { CHART_MODES, DOCK_LABELS, type PanelId, type ShellAction } from './shell';
import type { TabsView } from './tabs';
import { CLEAR_NO_LEGS_TEXT, THEMES } from './topMenu';

export type PaletteGroup =
  | 'panel'
  | 'preset'
  | 'eval'
  | 'pin'
  | 'chart'
  | 'board'
  | 'leg'
  | 'tab'
  | 'work'
  | 'theme'
  | 'term';

/** グループの並び（固定）と表示名 */
export const PALETTE_GROUPS: readonly { group: PaletteGroup; name: string }[] = [
  { group: 'panel', name: 'パネル' },
  { group: 'preset', name: 'シナリオ' },
  { group: 'eval', name: '評価時刻' },
  { group: 'pin', name: 'ピン' },
  { group: 'chart', name: 'グラフ' },
  { group: 'board', name: '板' },
  { group: 'leg', name: '足' },
  { group: 'tab', name: 'タブ' },
  { group: 'work', name: '作業' },
  { group: 'theme', name: 'テーマ' },
  { group: 'term', name: '用語' },
];

const GROUP_NAME: Readonly<Record<PaletteGroup, string>> = Object.fromEntries(
  PALETTE_GROUPS.map((g) => [g.group, g.name]),
) as Record<PaletteGroup, string>;

/** グループの表示名 */
export function paletteGroupName(g: PaletteGroup): string {
  return GROUP_NAME[g];
}

/** パネルの名前（Shell の見出しと同じ。smile はドックの読み上げの名前 = 「IV」で IV 推移が候補に出る。#130） */
export const PANEL_NAMES: Readonly<Record<PanelId, string>> = {
  positions: 'ポジション',
  board: '板',
  scenario: 'シナリオ',
  metrics: '指標',
  smile: DOCK_LABELS.smile.name,
  ai: DOCK_LABELS.ai.name,
};
/** パネルの行の並び（キー 1〜6 の順 = ドックの並び。#275） */
const PANEL_ORDER: readonly PanelId[] = [
  'board',
  'smile',
  'positions',
  'scenario',
  'metrics',
  'ai',
];
/** [このポジションを診断] の行の名前（#135） */
export const DIAGNOSE_LABEL = 'このポジションを診断';

/** 行の実行の記述（データ。NextApp の runPalette が振り分ける） */
export type PaletteRun =
  /** 全体のキーと同じ動き（1〜5・G・T。runGlobalKey） */
  | { kind: 'key'; key: GlobalKey }
  /** 作業の状態の action（dispatch） */
  | { kind: 'action'; action: Action }
  /** 見た目の状態の action（グラフの 線 / 面） */
  | { kind: 'shell'; action: ShellAction }
  | { kind: 'pinCurrent' }
  /** 板を見せて ATM の行へ */
  | { kind: 'atm' }
  /** 板の bid / ask と同じ足の追加 */
  | { kind: 'add'; add: MarketAddInput }
  | { kind: 'book' }
  | { kind: 'saveToBook' }
  | { kind: 'clear' }
  | { kind: 'settings' }
  | { kind: 'theme'; theme: ThemePref }
  /** 用語の説明カードを開く（#167） */
  | { kind: 'term'; id: TermId }
  /** AI のパネルを開いて [このポジションを診断]（#135） */
  | { kind: 'diagnose' };

export interface PaletteItem {
  /** 一意（グループ + 規則のキー。利用者の文字を含まない） */
  id: string;
  group: PaletteGroup;
  label: string;
  /** 押せない（このとき run は null） */
  disabled: boolean;
  /** 押せない理由 */
  title?: string;
  /** 右に出すキーの表示 */
  kbd?: string;
  /** 選択中（ピンの線の 期中 / 満期。舞台の ⋯ の radio と同じ） */
  checked?: boolean;
  /** 検索だけに使う文字（表示しない。用語の読み・別名。#167）。行の区切りは改行 */
  keywords?: string;
  run: PaletteRun | null;
}

export interface PaletteInput {
  /** 舞台の描画域にフォーカスできる（足がある・スマホのミニでない = PnlPlot の tabIndex 0） */
  chartFocusable: boolean;
  /** 評価できる足が無い（舞台の ⟲ が押せない） */
  chartEmpty: boolean;
  /** シナリオの入力（Scenario.tsx と同じ組み立て） */
  scenario: ScenarioRegionInput;
  pins: PinMenuInput;
  chain: Chain | null;
  /** 表示中の限月 */
  monthId: string;
  /** 表示中の限月の ATM の行使価格（板の [ATM] と同じ。無ければ null） */
  atmK: number | null;
  tabs: TabsView;
  /** 作業中のタブの足の本数 */
  legCount: number;
  /** 保存一覧の件数（読めない・新しい版なら null） */
  bookCount: number | null;
  /**
   * [このポジションを診断] が押せない理由（#135。ui/view/aiChat.ts の diagnoseBlocked。null = 押せる。省略 = 行を出さない）
   */
  aiDiagnoseBlocked?: string | null;
}

export const CHART_NO_LEGS_TEXT = '足が無い';
export const CHART_MINI_TEXT = '損益グラフが小さい（シートを下げる）';
export const ATM_NONE_TEXT = '板が無い';

/** 行を作る（押せない行は run を null にする = disabled と run の対応を 1 か所で守る） */
function item(
  group: PaletteGroup,
  key: string,
  label: string,
  run: PaletteRun | null,
  o: { disabled?: boolean; title?: string | undefined; kbd?: string; checked?: boolean } = {},
): PaletteItem {
  const disabled = o.disabled === true || run === null;
  const out: PaletteItem = {
    id: `${group}:${key}`,
    group,
    label,
    disabled,
    run: disabled ? null : run,
  };
  if (disabled && o.title !== undefined) out.title = o.title;
  if (o.kbd !== undefined) out.kbd = o.kbd;
  if (o.checked !== undefined) out.checked = o.checked;
  return out;
}

const LEG_SIDES: readonly { type: OptionType; side: Side }[] = [
  { type: 'put', side: 'sell' },
  { type: 'put', side: 'buy' },
  { type: 'call', side: 'sell' },
  { type: 'call', side: 'buy' },
];

/** 足の行: 表示中の限月の全行使価格 × 売 P・買 P・売 C・買 C のうち足を作れるもの。ATM から近い順 */
function legItems(chain: Chain | null, monthId: string, atmK: number | null): PaletteItem[] {
  if (!chain) return [];
  const month = chain.months.find((m) => m.id === monthId);
  if (!month) return [];
  const monthText = monthSegOptions(chain.months).find((o) => o.value === monthId)?.text ?? monthId;
  const ks = month.strikes.map((s) => s.k);
  ks.sort(
    atmK === null ? (a, b) => b - a : (a, b) => Math.abs(a - atmK) - Math.abs(b - atmK) || a - b,
  );
  const out: PaletteItem[] = [];
  for (const k of ks) {
    for (const { type, side } of LEG_SIDES) {
      const add: MarketAddInput = { expiry: month.id, k, type, side };
      const leg = marketAddPlan(chain, add);
      if (!leg) continue;
      out.push(
        item('leg', `${month.id}:${k}:${type}:${side}`, `${marketAddLabel(leg)}（${monthText}）`, {
          kind: 'add',
          add,
        }),
      );
    }
  }
  return out;
}

/** パレットの行（並びは PALETTE_GROUPS の順で固定） */
export function paletteItems(input: PaletteInput): PaletteItem[] {
  const out: PaletteItem[] = [];
  // パネル
  for (const panel of PANEL_ORDER) {
    out.push(
      item(
        'panel',
        panel,
        PANEL_NAMES[panel],
        { kind: 'key', key: { kind: 'panel', panel } },
        {
          kbd: PANEL_KEY[panel],
        },
      ),
    );
  }
  if (input.aiDiagnoseBlocked !== undefined) {
    const reason = input.aiDiagnoseBlocked;
    out.push(
      item('panel', 'diagnose', DIAGNOSE_LABEL, reason === null ? { kind: 'diagnose' } : null, {
        disabled: reason !== null,
        title: reason ?? undefined,
      }),
    );
  }
  out.push(
    item(
      'panel',
      'chart',
      'グラフにフォーカス',
      { kind: 'key', key: { kind: 'chart' } },
      {
        disabled: !input.chartFocusable,
        title: input.chartEmpty ? CHART_NO_LEGS_TEXT : CHART_MINI_TEXT,
        kbd: CHART_KEY,
      },
    ),
  );
  // シナリオ・評価時刻（チップと同じ）
  for (const ch of presetChips(input.scenario)) {
    out.push(
      item('preset', ch.key, ch.text, ch.action ? { kind: 'action', action: ch.action } : null, {
        disabled: ch.disabled,
      }),
    );
  }
  for (const ch of evalChips(input.scenario)) {
    out.push(
      item('eval', ch.key, ch.text, ch.action ? { kind: 'action', action: ch.action } : null, {
        disabled: ch.disabled,
      }),
    );
  }
  // ピン（舞台の [ピン N/3] と同じ）
  for (const r of pinMenuRows(input.pins)) {
    out.push(
      item('pin', r.key, r.label, r.run, {
        disabled: r.disabled === true,
        ...(r.checked !== undefined && { checked: r.checked }),
      }),
    );
  }
  // グラフ
  for (const m of CHART_MODES) {
    out.push(
      item('chart', m.value, m.text, { kind: 'shell', action: { type: 'chart', chart: m.value } }),
    );
  }
  out.push(
    item(
      'chart',
      'reset',
      '表示をリセット',
      { kind: 'action', action: { type: 'setPnlViewport', viewport: null } },
      { disabled: input.chartEmpty, title: CHART_NO_LEGS_TEXT },
    ),
  );
  // 板
  out.push(
    item(
      'board',
      'atm',
      'ATM へ',
      { kind: 'atm' },
      {
        disabled: input.atmK === null,
        title: ATM_NONE_TEXT,
      },
    ),
  );
  // 足
  out.push(...legItems(input.chain, input.monthId, input.atmK));
  // タブ（＋ のメニューと同じ）
  for (const r of addMenuModel(input.tabs)) {
    out.push(
      item(
        'tab',
        r.key,
        r.key === 'empty' ? '空のタブを追加' : r.label,
        { kind: 'action', action: { type: 'addTab', mode: r.key } },
        { disabled: r.disabled === true, title: r.title },
      ),
    );
  }
  for (const t of input.tabs.tabs) {
    if (t.active) continue;
    out.push(
      item('tab', `switch:${t.id}`, `${t.name} に切り替え`, {
        kind: 'action',
        action: { type: 'switchTab', id: t.id },
      }),
    );
  }
  // 作業（⋯ と同じ）
  out.push(
    item(
      'work',
      'book',
      input.bookCount === null ? '保存一覧…' : `保存一覧（${input.bookCount}）…`,
      {
        kind: 'book',
      },
    ),
    item('work', 'save', '保存一覧に保存…', { kind: 'saveToBook' }),
    item(
      'work',
      'clear',
      '全クリア',
      { kind: 'clear' },
      { disabled: input.legCount === 0, title: CLEAR_NO_LEGS_TEXT },
    ),
    item('work', 'settings', '設定…', { kind: 'settings' }),
  );
  // テーマ
  out.push(
    item(
      'theme',
      'toggle',
      '切り替え',
      { kind: 'key', key: { kind: 'theme' } },
      { kbd: THEME_KEY },
    ),
  );
  for (const t of THEMES) {
    out.push(item('theme', t.theme, t.label, { kind: 'theme', theme: t.theme }));
  }
  // 用語（#167。並びの最後。見出し・読み・別名で当たる）
  out.push(...TERM_ITEMS);
  return out;
}

/** 用語の行（静的なので 1 回だけ作る） */
const TERM_ITEMS: readonly PaletteItem[] = GLOSSARY.map((t) => ({
  ...item('term', t.id, t.title, { kind: 'term', id: t.id }),
  keywords: termSearchText(t),
}));

/** 表示中の限月の ATM（板の [ATM] と同じ atmStrike。板・限月が無ければ null） */
export function paletteAtmK(
  chain: Chain | null,
  monthId: string,
  basis: Parameters<typeof atmStrike>[1],
): number | null {
  const month = chain?.months.find((m) => m.id === monthId);
  return month ? atmStrike(month, basis) : null;
}

// ---------------------------------------------------------------- 検索

/**
 * 検索の正規化: NFKC → 小文字 → カタカナ（ァ〜ヶ）をひらがなへ → `,` `，` を消す → `−`（U+2212）を `-` に。
 * ひらがな化（#167）は問い合わせと行の両方にかかるので、カタカナ / ひらがな / 半角カナを同一視する
 */
export function paletteNorm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[,，]/g, '')
    .replace(/−/g, '-');
}

/** ギリシャ文字の読み（#167。小文字化の後の字。δ = でるた・σ = しぐま・γ = がんま・θ = しーた・β = べーた） */
const GREEK_READING: Readonly<Record<string, string>> = {
  δ: 'でるた',
  σ: 'しぐま',
  γ: 'がんま',
  θ: 'しーた',
  β: 'べーた',
};

/** 正規化した文字列のギリシャ文字を読みに展開する（問い合わせと行の両方にかけるので「デルタσ」も「Δσ」に当たる） */
function greekRead(s: string): string {
  return s.replace(/[δσγθβ]/g, (c) => GREEK_READING[c] ?? c);
}

/** 行の検索対象（グループ名 + ラベル、keywords があれば改行の後に。空白を消し、行の区切りの改行は残す） */
function hayOf(it: PaletteItem): string {
  const s = GROUP_NAME[it.group] + it.label + (it.keywords === undefined ? '' : `\n${it.keywords}`);
  return greekRead(paletteNorm(s).replace(/[^\S\n]+/g, ''));
}

/**
 * 問い合わせを空白で区切った語が **すべて**「グループ名 + ラベル（+ keywords）」（正規化して空白を消したもの）に
 * 部分一致する行を、元の並びのまま返す（得点付けしない。includes だけで、問い合わせから正規表現を作らない）。
 * 語が 0 個なら全件。問い合わせの先頭が `?`（全角 `？` も NFKC で `?`）なら、`?` を外して用語の行だけを対象にする（#167）
 */
export function paletteFilter(items: readonly PaletteItem[], query: string): PaletteItem[] {
  let q = paletteNorm(query).trimStart();
  const termOnly = q.startsWith('?');
  if (termOnly) q = q.slice(1);
  const pool = termOnly ? items.filter((it) => it.group === 'term') : items;
  const words = greekRead(q)
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return pool.slice();
  return pool.filter((it) => {
    const hay = hayOf(it);
    return words.every((w) => hay.includes(w));
  });
}

/** 一覧に描く行の上限 */
export const PALETTE_LIMIT = 50;

export interface PaletteView {
  shown: PaletteItem[];
  /** 描かない残りの件数 */
  rest: number;
  /** 一覧の外の role="status" の文 */
  status: string;
}

/** 先頭 PALETTE_LIMIT 行と残りの件数・状態の文 */
export function paletteView(matched: readonly PaletteItem[]): PaletteView {
  const n = matched.length;
  const rest = Math.max(0, n - PALETTE_LIMIT);
  const status =
    n === 0 ? '該当なし' : rest > 0 ? `${n} 件 · ほか ${rest} 件（文字で絞り込む）` : `${n} 件`;
  return { shown: matched.slice(0, PALETTE_LIMIT), rest, status };
}

// ---------------------------------------------------------------- キー

export type PaletteKey = 'up' | 'down' | 'run' | 'close' | 'stay';

/**
 * パレットの入力欄のキー。IME の変換中（isComposing・Process・229）はどのキーも null（変換を確定する Enter で
 * 実行しない・候補の ↑↓ で行を動かさない・変換を取り消す Esc で閉じない）。Ctrl / ⌘ + K（Alt・Shift なし）は close
 * （開け閉めの癖。ブラウザのアドレスバーの検索を出さない）、ほかの Ctrl / ⌘ / Alt 付きは null。
 * ↓ = down・↑ = up・Enter = run・Esc = close・Tab（Shift 付きも）= stay（入力欄に留める = パレットの外へ出さない）。
 * ほか（Home / End・文字）は null（入力欄の既定のまま）。
 */
export function paletteKey(
  s: Pick<KeySummary, 'key' | 'isComposing' | 'keyCode' | 'ctrl' | 'meta' | 'alt'> & {
    shift?: boolean;
  },
): PaletteKey | null {
  if (imeComposing(s)) return null;
  if ((s.ctrl || s.meta) && !s.alt && s.shift !== true && s.key.toLowerCase() === 'k') {
    return 'close';
  }
  if (s.ctrl || s.meta || s.alt) return null;
  if (s.key === 'ArrowDown') return 'down';
  if (s.key === 'ArrowUp') return 'up';
  if (s.key === 'Enter') return 'run';
  if (s.key === 'Escape') return 'close';
  if (s.key === 'Tab') return 'stay';
  return null;
}

/**
 * 新しい画面（`?ui=next`）のコマンドパレット（#89 段 B。docs/ui-redesign.md §4.6・§5）の行・検索・キー（純関数）。
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
import { CHART_KEY, type GlobalKey, type KeySummary, PANEL_KEY, THEME_KEY } from './keys';
import { type PinMenuInput, pinMenuRows } from './pins';
import { evalChips, presetChips, type ScenarioRegionInput } from './scenarioRegion';
import { CHART_MODES, type PanelId, type ShellAction } from './shell';
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
  | 'theme';

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
];

const GROUP_NAME: Readonly<Record<PaletteGroup, string>> = Object.fromEntries(
  PALETTE_GROUPS.map((g) => [g.group, g.name]),
) as Record<PaletteGroup, string>;

/** グループの表示名 */
export function paletteGroupName(g: PaletteGroup): string {
  return GROUP_NAME[g];
}

/** パネルの名前（Shell の見出しと同じ） */
export const PANEL_NAMES: Readonly<Record<PanelId, string>> = {
  positions: 'ポジション',
  board: '板',
  scenario: 'シナリオ',
  metrics: '指標',
  smile: 'スマイル',
};
const PANEL_ORDER: readonly PanelId[] = ['positions', 'board', 'scenario', 'metrics', 'smile'];

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
  | { kind: 'theme'; theme: ThemePref };

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
}

export const CHART_NO_LEGS_TEXT = '足が無い';
export const CHART_MINI_TEXT = '舞台がミニ（シートを下げる）';
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
  return out;
}

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

/** 検索の正規化: NFKC → 小文字 → `,` `，` を消す → `−`（U+2212）を `-` に */
export function paletteNorm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[,，]/g, '').replace(/−/g, '-');
}

/**
 * 問い合わせを空白で区切った語が **すべて**「グループ名 + ラベル」（正規化して空白を消したもの）に部分一致する行を、
 * 元の並びのまま返す（得点付けしない。includes だけで、問い合わせから正規表現を作らない）。語が 0 個なら全件。
 */
export function paletteFilter(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const words = paletteNorm(query)
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return items.slice();
  return items.filter((it) => {
    const hay = paletteNorm(GROUP_NAME[it.group] + it.label).replace(/\s+/g, '');
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
  if (s.isComposing || s.key === 'Process' || s.keyCode === 229) return null;
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

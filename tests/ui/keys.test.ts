import { describe, expect, it } from 'vitest';
import { BOARD_PICK_LAYER, OPT_CHART_LAYER } from '../../ui/view/backStack';
import {
  CHART_KEY,
  editableTarget,
  type GlobalKey,
  globalKey,
  type KeySummary,
  PALETTE_KBD,
  PANEL_FOCUS_LABEL,
  PANEL_KEY,
  PANEL_KEYS,
  palettePanelActions,
  panelKeyActions,
  panelKeyFocus,
  pickEscape,
  THEME_KEY,
  toggledTheme,
} from '../../ui/view/keys';
import {
  INITIAL_SHELL,
  type PanelId,
  type ShellState,
  shellReduce,
  type Tier,
} from '../../ui/view/shell';

/** #89 段 A: 全体のキー（1〜5・G・T・Ctrl / ⌘ + K）の判定。docs/ui-redesign.md §4.6 */
const ev = (key: string, o: Partial<KeySummary> = {}): KeySummary => ({
  key,
  ctrl: false,
  meta: false,
  alt: false,
  shift: false,
  isComposing: false,
  keyCode: 0,
  repeat: false,
  defaultPrevented: false,
  editable: false,
  blocked: false,
  overlay: false,
  ...o,
});

const PANEL = (panel: PanelId): GlobalKey => ({ kind: 'panel', panel });
const ALL_KEYS = ['1', '2', '3', '4', '5', 'g', 'G', 't', 'T'];

describe('globalKey', () => {
  it('(a) 1〜6 はパネル（#275: 板 / IV · スマイル / ポジ / シナリオ / 指標 / AI = ドックと同じ順）、g / G は描画域、t / T はテーマ', () => {
    expect(globalKey(ev('1'))).toEqual(PANEL('board'));
    expect(globalKey(ev('2'))).toEqual(PANEL('smile'));
    expect(globalKey(ev('3'))).toEqual(PANEL('positions'));
    expect(globalKey(ev('4'))).toEqual(PANEL('scenario'));
    expect(globalKey(ev('5'))).toEqual(PANEL('metrics'));
    expect(globalKey(ev('6'))).toEqual(PANEL('ai'));
    expect(globalKey(ev('g'))).toEqual({ kind: 'chart' });
    expect(globalKey(ev('G', { shift: true }))).toEqual({ kind: 'chart' });
    expect(globalKey(ev('t'))).toEqual({ kind: 'theme' });
    expect(globalKey(ev('T', { shift: true }))).toEqual({ kind: 'theme' });
    // CapsLock の大文字（Shift なし）も同じ
    expect(globalKey(ev('G'))).toEqual({ kind: 'chart' });
    expect(globalKey(ev('T'))).toEqual({ kind: 'theme' });
  });

  it('(b) Ctrl / ⌘ / Alt 付きの 1・t・g は null', () => {
    for (const key of ['1', 't', 'g', 'G', 'T', '5']) {
      expect(globalKey(ev(key, { ctrl: true }))).toBeNull();
      expect(globalKey(ev(key, { meta: true }))).toBeNull();
      expect(globalKey(ev(key, { alt: true }))).toBeNull();
    }
  });

  it('(c) IME の変換中（isComposing・Process・229）はどのキーも null', () => {
    for (const key of [...ALL_KEYS, 'k']) {
      expect(globalKey(ev(key, { isComposing: true }))).toBeNull();
      expect(globalKey(ev(key, { keyCode: 229 }))).toBeNull();
      expect(globalKey(ev(key, { isComposing: true, ctrl: true }))).toBeNull();
    }
    expect(globalKey(ev('Process'))).toBeNull();
    expect(globalKey(ev('k', { ctrl: true, keyCode: 229 }))).toBeNull();
  });

  it('(d) defaultPrevented は null', () => {
    for (const key of ALL_KEYS) expect(globalKey(ev(key, { defaultPrevented: true }))).toBeNull();
    expect(globalKey(ev('k', { ctrl: true, defaultPrevented: true }))).toBeNull();
  });

  it('(e) 対象が入力欄なら 1・t・Ctrl + K も null', () => {
    for (const key of ALL_KEYS) expect(globalKey(ev(key, { editable: true }))).toBeNull();
    expect(globalKey(ev('k', { ctrl: true, editable: true }))).toBeNull();
    expect(globalKey(ev('k', { meta: true, editable: true }))).toBeNull();
  });

  it('(f) ダイアログ（パレットを含む）なら 1・g・t・Ctrl + K が null', () => {
    for (const key of ALL_KEYS) expect(globalKey(ev(key, { blocked: true }))).toBeNull();
    expect(globalKey(ev('k', { ctrl: true, blocked: true }))).toBeNull();
    expect(globalKey(ev('k', { meta: true, blocked: true }))).toBeNull();
    // ダイアログの上にメニュー / ポップオーバーが重なっていても同じ
    expect(globalKey(ev('k', { ctrl: true, blocked: true, overlay: true }))).toBeNull();
  });

  it('(f) メニュー / ポップオーバーなら 1・g・t は null、Ctrl / ⌘ + K は palette（#89 段 B・AC-B5(i)）', () => {
    for (const key of ALL_KEYS) expect(globalKey(ev(key, { overlay: true }))).toBeNull();
    expect(globalKey(ev('k', { ctrl: true, overlay: true }))).toEqual({ kind: 'palette' });
    expect(globalKey(ev('k', { meta: true, overlay: true }))).toEqual({ kind: 'palette' });
    // 修飾の規則は同じ（Shift・Alt 付きは null）
    expect(globalKey(ev('k', { ctrl: true, shift: true, overlay: true }))).toBeNull();
    expect(globalKey(ev('k', { ctrl: true, alt: true, overlay: true }))).toBeNull();
    // 入力欄は overlay より先に止める
    expect(globalKey(ev('k', { ctrl: true, editable: true, overlay: true }))).toBeNull();
  });

  it('(g) Ctrl + K・⌘ + K は palette、Ctrl + Shift + K・Ctrl + Alt + K は null', () => {
    expect(globalKey(ev('k', { ctrl: true }))).toEqual({ kind: 'palette' });
    expect(globalKey(ev('k', { meta: true }))).toEqual({ kind: 'palette' });
    // CapsLock の 'K'（Shift なし）も palette
    expect(globalKey(ev('K', { ctrl: true }))).toEqual({ kind: 'palette' });
    expect(globalKey(ev('K', { ctrl: true, shift: true }))).toBeNull();
    expect(globalKey(ev('k', { ctrl: true, alt: true }))).toBeNull();
    expect(globalKey(ev('k', { meta: true, alt: true }))).toBeNull();
    expect(globalKey(ev('k', { meta: true, shift: true }))).toBeNull();
    // 修飾なしの k は何もしない
    expect(globalKey(ev('k'))).toBeNull();
  });

  it('(h) 0・6・r・Escape・ArrowRight など他のキーは null', () => {
    for (const key of [
      '0',
      '7',
      '9',
      'r',
      'R',
      'Escape',
      'ArrowRight',
      'Enter',
      ' ',
      '',
      'Unidentified',
      'Dead',
      '!',
    ]) {
      expect(globalKey(ev(key))).toBeNull();
    }
  });

  it('押しっぱなしの自動繰り返し（repeat）は null', () => {
    for (const key of ALL_KEYS) expect(globalKey(ev(key, { repeat: true }))).toBeNull();
    expect(globalKey(ev('k', { ctrl: true, repeat: true }))).toBeNull();
  });

  it('Shift は 1〜5・G・T の結果を変えない（同じ key なら）', () => {
    for (const key of ALL_KEYS) {
      expect(globalKey(ev(key, { shift: true }))).toEqual(globalKey(ev(key)));
    }
  });
});

describe('editableTarget', () => {
  it('INPUT / TEXTAREA / SELECT / contenteditable は true', () => {
    expect(editableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(editableTarget({ tagName: 'textarea' })).toBe(true);
    expect(editableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(editableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });
  it('BUTTON / DIV / null は false', () => {
    expect(editableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(editableTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(editableTarget(null)).toBe(false);
  });
});

describe('panelKeyActions', () => {
  const PANELS: PanelId[] = ['positions', 'board', 'scenario', 'metrics', 'smile', 'ai'];
  const open = (panel: PanelId, tier: Tier) => [{ type: 'open', panel, tier }];
  // Issue #89 の表（3 幅 × 5 キー）
  const table: [PanelId, Tier, unknown[]][] = [
    ['positions', 'phone', open('positions', 'phone')],
    ['board', 'phone', open('board', 'phone')],
    ['scenario', 'phone', open('scenario', 'phone')],
    ['metrics', 'phone', open('metrics', 'phone')],
    ['smile', 'phone', open('smile', 'phone')],
    ['positions', 'tablet', open('positions', 'tablet')],
    ['board', 'tablet', open('board', 'tablet')],
    ['scenario', 'tablet', []],
    ['metrics', 'tablet', open('metrics', 'tablet')],
    ['smile', 'tablet', open('smile', 'tablet')],
    // #280: ポジション・指標は常に見える（AI は左の列）。状態は変えずフォーカスだけ
    ['positions', 'pc', []],
    ['board', 'pc', [{ type: 'market', market: 'board' }]],
    ['scenario', 'pc', []],
    ['metrics', 'pc', []],
    ['smile', 'pc', [{ type: 'market', market: 'smile' }]],
    // #135: AI はスマホ・タブレットは開く、PC は左の列（市場）の入れ替え（#280）
    ['ai', 'phone', [{ type: 'open', panel: 'ai', tier: 'phone' }]],
    ['ai', 'tablet', [{ type: 'open', panel: 'ai', tier: 'tablet' }]],
    ['ai', 'pc', [{ type: 'left' }]],
  ];
  it.each(table)('%s / %s', (panel, tier, want) => {
    expect(panelKeyActions(panel, tier)).toEqual(want);
  });
  it('表は 18 マスすべて（#135 で AI）', () => {
    expect(table).toHaveLength(18);
    for (const p of PANELS) expect(table.filter(([q]) => q === p)).toHaveLength(3);
  });

  const run = (s: ShellState, panel: PanelId, tier: Tier) =>
    panelKeyActions(panel, tier).reduce(shellReduce, s);

  it('スマホで sheet hidden から 2 → board / peek', () => {
    const s: ShellState = { ...INITIAL_SHELL, panel: 'positions', sheet: 'hidden' };
    const next = run(s, 'board', 'phone');
    expect(next.panel).toBe('board');
    expect(next.sheet).toBe('peek');
  });
  it('スマホで board / full のとき 2 → 変わらない（同じ参照）', () => {
    const s: ShellState = { ...INITIAL_SHELL, panel: 'board', sheet: 'full' };
    expect(run(s, 'board', 'phone')).toBe(s);
  });
  it('PC の 2 → 市場が板、5 → スマイル（パネル・シートは変わらない）', () => {
    const s: ShellState = { ...INITIAL_SHELL, market: 'smile' };
    const b = run(s, 'board', 'pc');
    expect(b.market).toBe('board');
    expect(b.panel).toBe(s.panel);
    expect(b.sheet).toBe(s.sheet);
    expect(run(b, 'smile', 'pc').market).toBe('smile');
  });
  it('タブレットの 3 は何もしない（同じ参照）', () => {
    const s: ShellState = { ...INITIAL_SHELL, panel: 'metrics' };
    expect(run(s, 'scenario', 'tablet')).toBe(s);
  });
});

describe('toggledTheme と表示用の定数', () => {
  it('解決済みの反対を明示にする', () => {
    expect(toggledTheme('dark')).toBe('light');
    expect(toggledTheme('light')).toBe('dark');
  });
  it('PANEL_KEYS と PANEL_KEY は互いに逆', () => {
    for (const [k, p] of Object.entries(PANEL_KEYS)) expect(PANEL_KEY[p]).toBe(k);
    expect(Object.keys(PANEL_KEYS)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(CHART_KEY).toBe('G');
    expect(THEME_KEY).toBe('T');
    expect(PALETTE_KBD.length).toBeGreaterThan(0);
  });
});

/** #91 段 C AC-C7: 1〜5 の行き先の枠の読み上げの名前 */
describe('PANEL_FOCUS_LABEL', () => {
  it('6 つのパネル（#135 で AI）すべてに空でない名前があり、互いに違う', () => {
    const keys = Object.keys(PANEL_FOCUS_LABEL).sort();
    expect(keys).toEqual(Object.keys(PANEL_KEY).sort());
    expect(keys).toHaveLength(6);
    const labels = Object.values(PANEL_FOCUS_LABEL);
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(6);
  });
});

describe('#280 レビュー指摘 2・3: パレットの「AI に相談」・キー 6 で閉じたときのフォーカス', () => {
  it('パレットの AI は入れ替えでなく open（PC で開いていても閉じない）、他のパネルはキーと同じ', () => {
    for (const tier of ['phone', 'tablet', 'pc'] as const) {
      expect(palettePanelActions('ai', tier)).toEqual([{ type: 'open', panel: 'ai', tier }]);
      for (const panel of ['board', 'smile', 'positions', 'scenario', 'metrics'] as const)
        expect(palettePanelActions(panel, tier)).toEqual(panelKeyActions(panel, tier));
    }
    const ai = { ...INITIAL_SHELL, left: 'ai' as const };
    for (const a of palettePanelActions('ai', 'pc')) expect(shellReduce(ai, a)).toBe(ai);
  });

  it('PC で AI を出している間の 6 は戻った市場の枠へ（板 → 板、他 → スマイルの枠）。他はそのパネル', () => {
    const at = (s: Partial<ShellState>): ShellState => ({ ...INITIAL_SHELL, ...s });
    expect(panelKeyFocus('ai', 'pc', at({ left: 'ai', market: 'board' }))).toBe('board');
    for (const market of ['smile', 'iv', 'fut'] as const)
      expect(panelKeyFocus('ai', 'pc', at({ left: 'ai', market }))).toBe('smile');
    expect(panelKeyFocus('ai', 'pc', at({}))).toBe('ai');
    expect(panelKeyFocus('ai', 'tablet', at({ left: 'ai' }))).toBe('ai');
    expect(panelKeyFocus('metrics', 'pc', at({ left: 'ai' }))).toBe('metrics');
  });
});

describe('#325 pickEscape（板から追加の帯を Esc で消す）', () => {
  const pe = (key: string, o: Partial<KeySummary> & { claimed?: boolean } = {}) => ({
    ...ev(key, o),
    claimed: o.claimed ?? false,
  });
  it('Escape で一番上が帯の層なら真', () => {
    expect(pickEscape(pe('Escape'), BOARD_PICK_LAYER)).toBe(true);
  });

  it('入力欄の Esc（編集の取りやめ）・先に受けた部品が claimEscape した Esc（タブのつかみの取りやめ）は偽', () => {
    expect(pickEscape(pe('Escape', { editable: true }), BOARD_PICK_LAYER)).toBe(false);
    expect(pickEscape(pe('Escape', { claimed: true }), BOARD_PICK_LAYER)).toBe(false);
  });

  it('一番上が他の層（吹き出し・ダイアログ）・層なしなら偽', () => {
    expect(pickEscape(pe('Escape'), 'overlay:x')).toBe(false);
    expect(pickEscape(pe('Escape'), 'dialog:y')).toBe(false);
    expect(pickEscape(pe('Escape'), null)).toBe(false);
  });

  it('#319 銘柄の推移も同じ規則（層を渡す）: 一番上が推移の層のときだけ', () => {
    expect(pickEscape(pe('Escape'), OPT_CHART_LAYER, OPT_CHART_LAYER)).toBe(true);
    expect(pickEscape(pe('Escape'), BOARD_PICK_LAYER, OPT_CHART_LAYER)).toBe(false);
    expect(pickEscape(pe('Escape'), OPT_CHART_LAYER)).toBe(false);
    expect(pickEscape(pe('Escape', { editable: true }), OPT_CHART_LAYER, OPT_CHART_LAYER)).toBe(
      false,
    );
  });

  it('IME の変換中・部品が処理した Esc・他のキーは偽', () => {
    expect(pickEscape(pe('Escape', { isComposing: true }), BOARD_PICK_LAYER)).toBe(false);
    expect(pickEscape(pe('Process'), BOARD_PICK_LAYER)).toBe(false);
    expect(pickEscape(pe('Escape', { keyCode: 229 }), BOARD_PICK_LAYER)).toBe(false);
    expect(pickEscape(pe('Escape', { defaultPrevented: true }), BOARD_PICK_LAYER)).toBe(false);
    expect(pickEscape(pe('1'), BOARD_PICK_LAYER)).toBe(false);
    expect(pickEscape(pe('Enter'), BOARD_PICK_LAYER)).toBe(false);
  });
});

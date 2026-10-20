import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import { CALENDAR } from '../../ui/calendar';
import { MAX_PINS } from '../../ui/pins';
import { type Action, initialState, MAX_TABS, reduce, type State } from '../../ui/state';
import { atmStrike } from '../../ui/view/board';
import { marketAddLabel, marketAddPlan, monthSegOptions } from '../../ui/view/boardPanel';
import { fmtNum } from '../../ui/view/format';
import { GLOSSARY } from '../../ui/view/glossary';
import {
  PALETTE_GROUPS,
  PALETTE_LIMIT,
  type PaletteInput,
  type PaletteItem,
  paletteFilter,
  paletteItems,
  paletteKey,
  paletteNorm,
  paletteView,
} from '../../ui/view/palette';
import { type PinTarget, pinMenuRows } from '../../ui/view/pins';
import { pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { evalTimeTargets } from '../../ui/view/scenario';
import { evalChips, presetChips, type ScenarioRegionInput } from '../../ui/view/scenarioRegion';
import { TABS_FULL_TEXT, tabsModel } from '../../ui/view/tabs';
import { CLEAR_NO_LEGS_TEXT } from '../../ui/view/topMenu';
import { fixture } from '../support/fixtures';

/** #89 段 B: コマンドパレットの行・検索・キー（AC-B2・AC-B3）。合成の板（架空の値）。 */

const chain = normalizeChain(fixture('latest'));
const [m1, m2] = chain.months;
if (!m1 || !m2) throw new Error('限月が 2 つ要る');

const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);
const loaded = run(initialState, { type: 'loaded', chain, label: 'latest' });
const twoLegs = run(
  loaded,
  { type: 'addBoardLeg', expiry: m1.id, k: 63_500, optionType: 'put', side: 'sell' },
  { type: 'addBoardLeg', expiry: m2.id, k: 71_000, optionType: 'call', side: 'buy' },
);

function scenarioOf(s: State): ScenarioRegionInput {
  const c = s.chain as Chain;
  const pm = positionModel(c, s.legs, s.atmBasis, s.calendar);
  const base = pnlDomains(c, pm.prepared, pm.ctx);
  return {
    scenario: s.scenario,
    futureBasis: s.futureBasis,
    x0: pm.ctx.x0,
    maxDays: base?.maxDays ?? 0,
    evalTime: base?.ctx.evalTime ?? null,
    targets: evalTimeTargets(c, s.legs, CALENDAR),
    dXUnit: 'pct',
  };
}

const target = (no: 1 | 2 | 3, name: string): PinTarget => ({
  no,
  kind: 'ghost',
  name,
  base: null,
  scenario: initialState.scenario,
  period: 'today',
  active: false,
  legCount: 1,
  excluded: 0,
  boardSnapshotAt: null,
});

function inputOf(s: State, o: Partial<PaletteInput> = {}): PaletteInput {
  const tabs = tabsModel(s.tabs, s.activeTab, s.legs.length);
  const atmK = atmStrike(m1 as NonNullable<typeof m1>, s.atmBasis);
  return {
    chartFocusable: s.legs.length > 0,
    chartEmpty: s.legs.length === 0,
    scenario: scenarioOf(s),
    pins: {
      noLegs: s.legs.length === 0,
      pins: [],
      pinLine: s.pinLine,
      pinTabs: tabs.tabs
        .filter((t) => !t.active)
        .map((t) => ({ id: t.id, name: t.name, legCount: t.legCount, pinned: false })),
    },
    chain: s.chain,
    monthId: m1?.id ?? '',
    atmK,
    tabs,
    legCount: s.legs.length,
    bookCount: 2,
    ...o,
  };
}

const ofGroup = (items: readonly PaletteItem[], g: PaletteItem['group']) =>
  items.filter((i) => i.group === g);

describe('paletteItems（AC-B2）', () => {
  const items = paletteItems(inputOf(twoLegs));

  it('(a) グループの並びが表の順（パネル → シナリオ → … → テーマ）', () => {
    const seen: string[] = [];
    for (const it of items) if (seen.at(-1) !== it.group) seen.push(it.group);
    expect(seen).toEqual(PALETTE_GROUPS.map((g) => g.group));
    // 一度出たグループは後で戻らない（グループの中で連続）
    expect(new Set(seen).size).toBe(seen.length);
    // 足 0 本・板なしでもグループの順は崩れない（空のグループは飛ばす）
    const empty = paletteItems(inputOf(loaded, { chain: null, atmK: null }));
    const order = PALETTE_GROUPS.map((g) => g.group);
    const idx = empty.map((i) => order.indexOf(i.group));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it('パネルの行: 1〜6・G のキーの表示、グラフにフォーカスは足 0 本・ミニで押せない', () => {
    const panel = ofGroup(items, 'panel');
    expect(panel.map((i) => [i.label, i.kbd])).toEqual([
      ['ポジション', '1'],
      ['板', '2'],
      ['シナリオ', '3'],
      ['指標', '4'],
      ['IV 推移 · スマイル', '5'],
      ['AI に相談', '6'],
      ['グラフにフォーカス', 'G'],
    ]);
    expect(panel.every((i) => !i.disabled)).toBe(true);
    const mini = paletteItems(inputOf(twoLegs, { chartFocusable: false }));
    const g = mini.find((i) => i.id === 'panel:chart');
    expect(g?.disabled).toBe(true);
    expect(g?.run).toBeNull();
    expect(g?.title).toBeTruthy();
  });

  it('#135: [このポジションを診断] の行（押せない理由は aiChat の diagnoseBlocked。省略なら行を出さない）', () => {
    expect(items.some((i) => i.id === 'panel:diagnose')).toBe(false);
    const ok = paletteItems({ ...inputOf(twoLegs), aiDiagnoseBlocked: null });
    const d = ok.find((i) => i.id === 'panel:diagnose');
    expect(d).toMatchObject({
      label: 'このポジションを診断',
      disabled: false,
      run: { kind: 'diagnose' },
    });
    const no = paletteItems({
      ...inputOf(twoLegs),
      aiDiagnoseBlocked: 'AI は無効です（管理者の設定）',
    });
    expect(no.find((i) => i.id === 'panel:diagnose')).toMatchObject({
      disabled: true,
      run: null,
      title: 'AI は無効です（管理者の設定）',
    });
  });

  it('(b) シナリオの行は presetChips と同じ label・disabled・action。X₀ が NaN なら 3 行とも押せず、リセットは押せる', () => {
    const inp = inputOf(twoLegs);
    const chips = presetChips(inp.scenario);
    const rows = ofGroup(items, 'preset');
    expect(rows.map((r) => r.label)).toEqual(chips.map((c) => c.text));
    expect(rows.map((r) => r.disabled)).toEqual(chips.map((c) => c.disabled));
    expect(rows.map((r) => (r.run?.kind === 'action' ? r.run.action : null))).toEqual(
      chips.map((c) => c.action),
    );
    const nan = paletteItems(inputOf(twoLegs, { scenario: { ...inp.scenario, x0: Number.NaN } }));
    const nanRows = ofGroup(nan, 'preset');
    expect(nanRows.map((r) => r.disabled)).toEqual([false, true, true, true]);
    expect(nanRows.slice(1).every((r) => r.run === null)).toBe(true);
    expect(nanRows[0]?.run).toEqual({ kind: 'action', action: { type: 'resetScenario' } });
  });

  it('(c) 評価時刻の行は evalChips と同じ数・disabled（評価時刻なしは全部押せない）', () => {
    const inp = inputOf(twoLegs);
    const chips = evalChips(inp.scenario);
    const rows = ofGroup(items, 'eval');
    expect(chips.length).toBe(4);
    expect(rows.map((r) => r.label)).toEqual(chips.map((c) => c.text));
    expect(rows.map((r) => r.disabled)).toEqual(chips.map((c) => c.disabled));
    const none = paletteItems(inputOf(twoLegs, { scenario: { ...inp.scenario, evalTime: null } }));
    const noneRows = ofGroup(none, 'eval');
    expect(noneRows.length).toBe(4);
    expect(noneRows.every((r) => r.disabled && r.run === null)).toBe(true);
    expect(ofGroup(paletteItems(inputOf(loaded)), 'eval')).toEqual([]);
  });

  it('(d) ピンの行は pinMenuRows と同じ label・disabled。上限で今の線を残す・を重ねるが押せない', () => {
    const withTabs = run(twoLegs, { type: 'addTab', mode: 'copy' }, { type: 'switchTab', id: 1 });
    const pins = [target(1, 'a'), target(2, 'b'), target(3, 'c')];
    expect(pins.length).toBe(MAX_PINS);
    const base = inputOf(withTabs);
    const inp = { ...base, pins: { ...base.pins, pins } };
    const rows = ofGroup(paletteItems(inp), 'pin');
    const menu = pinMenuRows(inp.pins);
    expect(rows.map((r) => r.label)).toEqual(menu.map((m) => m.label));
    expect(rows.map((r) => r.disabled)).toEqual(menu.map((m) => m.disabled === true));
    expect(rows[0]?.label).toBe('今の線を残す');
    expect(rows[0]?.disabled).toBe(true);
    const over = rows.filter((r) => r.label.endsWith(' を重ねる'));
    expect(over.length).toBe(1);
    expect(over.every((r) => r.disabled)).toBe(true);
    // ピンの線は舞台の ⋯ と同じ checked（期中 / 満期のどちらか）
    expect(rows.filter((r) => r.checked !== undefined).map((r) => [r.label, r.checked])).toEqual(
      menu.filter((m) => m.checked !== undefined).map((m) => [m.label, m.checked]),
    );
    expect(rows.find((r) => r.label === 'ピンの線: 期中')?.checked).toBe(true);
    expect(rows.find((r) => r.label === 'ピンの線: 満期')?.checked).toBe(false);
    // 2 本なら押せる
    const two = ofGroup(
      paletteItems({ ...base, pins: { ...base.pins, pins: pins.slice(0, 2) } }),
      'pin',
    );
    expect(two[0]?.disabled).toBe(false);
    expect(two[0]?.run).toEqual({ kind: 'pinCurrent' });
  });

  it('グラフの行: 線 / 面は押せる、表示をリセットは足 0 本で押せない', () => {
    expect(ofGroup(items, 'chart').map((r) => [r.label, r.disabled])).toEqual([
      ['線', false],
      ['面', false],
      ['表示をリセット', false],
    ]);
    const empty = ofGroup(paletteItems(inputOf(loaded)), 'chart');
    expect(empty.map((r) => r.disabled)).toEqual([false, false, true]);
  });

  it('板の行: ATM へ（ATM が無ければ押せない）', () => {
    expect(ofGroup(items, 'board').map((r) => [r.label, r.disabled])).toEqual([['ATM へ', false]]);
    const none = ofGroup(paletteItems(inputOf(twoLegs, { atmK: null })), 'board');
    expect(none[0]?.disabled).toBe(true);
    expect(none[0]?.title).toBe('板が無い');
  });

  it('(e) 足の行: ラベルの価格は marketAddPlan の建値（売 = bid・買 = ask）、作れない組は出ない、先頭は ATM', () => {
    const month = m1;
    const legs = ofGroup(items, 'leg');
    const monthText = monthSegOptions(chain.months).find((o) => o.value === month.id)?.text;
    expect(monthText).toBeTruthy();
    let expected = 0;
    let quoted = 0;
    for (const s of month.strikes) {
      for (const type of ['put', 'call'] as const) {
        for (const side of ['sell', 'buy'] as const) {
          const leg = marketAddPlan(chain, { expiry: month.id, k: s.k, type, side });
          const row = legs.find((r) => r.id === `leg:${month.id}:${s.k}:${type}:${side}`);
          if (!leg) {
            expect(row).toBeUndefined();
            continue;
          }
          expected++;
          expect(row?.label).toBe(`${marketAddLabel(leg)}（${monthText}）`);
          expect(row?.run).toEqual({
            kind: 'add',
            add: { expiry: month.id, k: s.k, type, side },
          });
          // 両気配の行は 売 = bid・買 = ask（合成の板の値）
          const q = month.rows.find((r) => r.k === s.k)?.[type];
          const price = side === 'sell' ? q?.bid : q?.ask;
          if (s[type].quote === 'two_sided' && price !== null && price !== undefined) {
            quoted++;
            const text = fmtNum(price, Number.isInteger(price) ? 0 : 1);
            expect(row?.label.split('@')[1]?.startsWith(`${text}（`)).toBe(true);
          }
        }
      }
    }
    expect(legs.length).toBe(expected);
    expect(quoted).toBeGreaterThan(10);
    // 板の strikes に無い K は作らない
    const ks = new Set(month.strikes.map((s) => s.k));
    for (const r of legs) {
      expect(r.run?.kind === 'add' && ks.has(r.run.add.k)).toBe(true);
    }
    // 先頭は ATM の行使価格、距離の昇順（同じ距離は K の昇順）、同じ K は 売 P・買 P・売 C・買 C
    const atmK = atmStrike(month, twoLegs.atmBasis);
    expect(atmK).not.toBeNull();
    const kOf = (r: PaletteItem) => (r.run?.kind === 'add' ? r.run.add.k : Number.NaN);
    expect(kOf(legs[0] as PaletteItem)).toBe(atmK);
    const dist = legs.map((r) => [Math.abs(kOf(r) - (atmK as number)), kOf(r)] as const);
    for (let i = 1; i < dist.length; i++) {
      const [d0, k0] = dist[i - 1] as readonly [number, number];
      const [d1, k1] = dist[i] as readonly [number, number];
      expect(d0 < d1 || (d0 === d1 && k0 <= k1)).toBe(true);
    }
    const atAtm = legs.filter((r) => kOf(r) === atmK).map((r) => r.label.slice(0, 3));
    expect(atAtm).toEqual(['売 P', '買 P', '売 C', '買 C'].slice(0, atAtm.length));
  });

  it('足の行: 板なし・無い限月は 0 行（例外を投げない）', () => {
    expect(ofGroup(paletteItems(inputOf(twoLegs, { chain: null })), 'leg')).toEqual([]);
    expect(ofGroup(paletteItems(inputOf(twoLegs, { monthId: '1999-01' })), 'leg')).toEqual([]);
  });

  it('(f) タブが MAX_TABS のとき 空のタブを追加・このタブを複製が押せず title が TABS_FULL_TEXT', () => {
    let s = twoLegs;
    for (let i = 1; i < MAX_TABS; i++) s = run(s, { type: 'addTab', mode: 'empty' });
    expect(s.tabs.length).toBe(MAX_TABS);
    const rows = ofGroup(paletteItems(inputOf(s)), 'tab');
    const add = rows.slice(0, 2);
    expect(add.map((r) => r.label)).toEqual(['空のタブを追加', 'このタブを複製']);
    expect(add.every((r) => r.disabled && r.run === null && r.title === TABS_FULL_TEXT)).toBe(true);
    // 切り替え: 作業中以外の全タブ
    const sw = rows.slice(2);
    expect(sw.length).toBe(MAX_TABS - 1);
    expect(sw.every((r) => r.label.endsWith(' に切り替え') && !r.disabled)).toBe(true);
    // 上限未満なら押せる
    const one = ofGroup(items, 'tab');
    expect(one.map((r) => r.disabled)).toEqual([false, false]);
    expect(one[0]?.run).toEqual({ kind: 'action', action: { type: 'addTab', mode: 'empty' } });
  });

  it('(g) 足 0 本で全クリアが押せない（理由は ⋯ と同じ）。作業の行の並び', () => {
    const rows = ofGroup(paletteItems(inputOf(loaded)), 'work');
    expect(rows.map((r) => r.label)).toEqual([
      '保存一覧（2）…',
      '保存一覧に保存…',
      '全クリア',
      '設定…',
    ]);
    const clear = rows[2];
    expect(clear?.disabled).toBe(true);
    expect(clear?.title).toBe(CLEAR_NO_LEGS_TEXT);
    expect(ofGroup(items, 'work')[2]?.disabled).toBe(false);
    const unread = ofGroup(paletteItems(inputOf(loaded, { bookCount: null })), 'work');
    expect(unread[0]?.label).toBe('保存一覧…');
  });

  it('テーマの行: 切り替え T・端末に合わせる・ダーク・ライト', () => {
    expect(ofGroup(items, 'theme').map((r) => [r.label, r.kbd ?? null])).toEqual([
      ['切り替え', 'T'],
      ['端末に合わせる', null],
      ['ダーク', null],
      ['ライト', null],
    ]);
  });

  it('(h) 実行の記述はデータ（JSON の往復で同じ）。押せない行は run が null、押せる行は非 null', () => {
    for (const inp of [
      inputOf(twoLegs),
      inputOf(loaded),
      inputOf(loaded, { chain: null, atmK: null }),
    ]) {
      const list = paletteItems(inp);
      expect(JSON.parse(JSON.stringify(list))).toEqual(list);
      for (const it of list) expect(it.disabled).toBe(it.run === null);
    }
  });

  it('行の id は一意で、利用者の文字（タブ名）を含まない。同じ入力なら同じ出力', () => {
    const named = run(twoLegs, { type: 'addTab', mode: 'empty' }, { type: 'switchTab', id: 1 });
    const tab2 = named.tabs.find((t) => t.id !== 1);
    const s = run(named, { type: 'renameTab', id: tab2?.id ?? 0, name: '秘密のタブ' });
    const list = paletteItems(inputOf(s));
    expect(list.some((r) => r.label === '秘密のタブ に切り替え')).toBe(true);
    expect(new Set(list.map((r) => r.id)).size).toBe(list.length);
    expect(list.every((r) => !r.id.includes('秘密'))).toBe(true);
    expect(paletteItems(inputOf(s))).toEqual(list);
  });
});

describe('paletteFilter（AC-B3）', () => {
  const items = paletteItems(inputOf(twoLegs));

  it('(a) 空・空白だけの問い合わせは全件・元の順', () => {
    expect(paletteFilter(items, '')).toEqual(items);
    expect(paletteFilter(items, '   　')).toEqual(items);
  });

  it('(b) 売 p 64000・売P64,000・全角の ６４，０００ が 売 P 64,000 @… の行に当たる', () => {
    const k = m1.strikes.find((s) => s.k === 64_000);
    expect(k).toBeDefined();
    const target = items.find((r) => r.id === `leg:${m1.id}:64000:put:sell`);
    expect(target?.label.startsWith('売 P 64,000 @')).toBe(true);
    for (const q of ['売 p 64000', '売P64,000', '６４，０００', '売 Ｐ ６４，０００']) {
      expect(paletteFilter(items, q)).toContain(target);
    }
  });

  it('(c) 急落 はシナリオの 1 行だけ', () => {
    const hit = paletteFilter(items, '急落');
    expect(hit.length).toBe(1);
    expect(hit[0]?.group).toBe('preset');
  });

  it('(d) 語の AND: テーマ ダーク はダークの 1 行', () => {
    const hit = paletteFilter(items, 'テーマ ダーク');
    expect(hit.map((r) => r.label)).toEqual(['ダーク']);
    // 片方だけの語ではもっと当たる
    expect(paletteFilter(items, 'テーマ').length).toBe(4);
  });

  it('#130: IV・iv・ＩＶ で IV 推移（とスマイル）のパネルの行（キー 5）が候補に出る、スマイル でも出る', () => {
    const row = items.find((r) => r.id === 'panel:smile');
    expect(row?.label).toBe('IV 推移 · スマイル');
    for (const q of ['IV', 'iv', 'ＩＶ', 'IV 推移', 'スマイル']) {
      expect(paletteFilter(items, q)).toContain(row);
    }
  });

  it('(e) 当たらない語で 0 件', () => {
    expect(paletteFilter(items, 'zzz')).toEqual([]);
    expect(paletteFilter(items, '急落 zzz')).toEqual([]);
  });

  it('(f) 並べ替えない（当たった行が元の順の部分列）。語を足すと部分集合', () => {
    const hit = paletteFilter(items, '64');
    expect(hit.length).toBeGreaterThan(1);
    let at = -1;
    for (const r of hit) {
      const i = items.indexOf(r);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
    const narrower = paletteFilter(items, '64 売');
    expect(narrower.every((r) => hit.includes(r))).toBe(true);
    expect(narrower.length).toBeLessThan(hit.length);
  });

  it('大小・U+2212 の違いは結果を変えない。正規表現の記号は文字として扱う', () => {
    expect(paletteFilter(items, 'atm')).toEqual(paletteFilter(items, 'ATM'));
    expect(paletteFilter(items, 'ATM').map((r) => r.label)).toEqual(['ATM へ']);
    expect(paletteFilter(items, '−10%')).toEqual(paletteFilter(items, '-10%'));
    expect(paletteFilter(items, '-10%').length).toBe(1);
    expect(paletteFilter(items, '.*')).toEqual([]);
    expect(paletteFilter(items, '(')).toEqual(
      items.filter((r) => paletteNorm(r.label).includes('(')),
    );
  });

  it('paletteNorm: NFKC・小文字・カンマ・U+2212', () => {
    expect(paletteNorm('Ａｂ６４，０００,1')).toBe('ab640001');
    expect(paletteNorm('−10%')).toBe('-10%');
    expect(paletteNorm('（11月限）')).toBe('(11月限)');
  });
});

describe('用語の行（#167 AC-5）', () => {
  const items = paletteItems(inputOf(twoLegs));
  const terms = items.filter((r) => r.group === 'term');
  const ids = (q: string) => paletteFilter(items, q).map((r) => r.id);

  it('(a) 用語の行は 24 行・グループは並びの最後・行の順は GLOSSARY と同じ', () => {
    expect(PALETTE_GROUPS.at(-1)).toEqual({ group: 'term', name: '用語' });
    expect(terms.length).toBe(24);
    expect(terms.map((r) => r.label)).toEqual(GLOSSARY.map((t) => t.title));
    expect(items.slice(-24)).toEqual(terms);
    // 足 0 本・板なしでも 24 行
    expect(
      paletteItems(inputOf(loaded, { chain: null, atmK: null })).filter((r) => r.group === 'term')
        .length,
    ).toBe(24);
    for (const r of terms) {
      expect(r.disabled).toBe(false);
      expect(r.keywords?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('(b) 記号・読み・カナ・英語・半角カナで当たる', () => {
    const cases: [string, string][] = [
      ['σ', 'term:iv'],
      ['シグマ', 'term:iv'],
      ['しぐま', 'term:iv'],
      ['sigma', 'term:iv'],
      ['ｼｸﾞﾏ', 'term:iv'],
      ['Δs', 'term:skew'],
      ['デルタs', 'term:skew'],
      ['でるたS', 'term:skew'],
      ['スキュー', 'term:skew'],
      ['skew', 'term:skew'],
      ['Δσ', 'term:iv-shift'],
      ['デルタσ', 'term:iv-shift'],
      ['デルタシグマ', 'term:iv-shift'],
      ['追証', 'term:margin-line'],
      ['ベガ', 'term:vega'],
      ['ガンマ', 'term:gamma'],
      ['Γ', 'term:gamma'],
      ['シータ', 'term:theta'],
      ['θ', 'term:theta'],
      ['ベータ', 'term:beta'],
      ['β', 'term:beta'],
      ['ヒストリカル', 'term:hv'],
      ['span', 'term:var-span'],
    ];
    for (const [q, id] of cases) expect(ids(q), q).toContain(id);
    // Δs と Δσ は取り違えない
    expect(ids('Δs')).not.toContain('term:iv-shift');
    expect(ids('デルタσ')).not.toContain('term:skew');
  });

  it('(c) ? / ？ で始まる問い合わせは用語の行だけ（? だけなら 24 行）', () => {
    expect(paletteFilter(items, '?')).toEqual(terms);
    expect(paletteFilter(items, '？')).toEqual(terms);
    expect(paletteFilter(items, ' ? ')).toEqual(terms);
    const hit = paletteFilter(items, '?シグマ');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((r) => r.group === 'term')).toBe(true);
    expect(hit.map((r) => r.id)).toContain('term:iv');
    // AC-10: `?シグマ` の先頭（Enter で開く行）は IV
    expect(hit[0]?.id).toBe('term:iv');
    // 用語に当たらない語は 0 件（コマンドは出さない）
    expect(paletteFilter(items, '?急落')).toEqual([]);
    // #179: 旧名でも追証マップに当たる。`?追証` の先頭（Enter で開く行）は今までどおり追証の線で、追証マップも並ぶ
    expect(paletteFilter(items, '?持ちこたえ').map((r) => r.id)).toEqual(['term:hold-map']);
    const call = paletteFilter(items, '?追証').map((r) => r.id);
    expect(call[0]).toBe('term:margin-line');
    expect(call).toContain('term:hold-map');
    expect(paletteFilter(items, '？ テーマ')).toEqual([]);
  });

  it('(d) 既存のコマンドの問い合わせの結果が変わらない（用語の行を足しても）', () => {
    const cmds = items.filter((r) => r.group !== 'term');
    for (const q of [
      '急落',
      'テーマ ダーク',
      'テーマ',
      'ATM',
      '-10%',
      '−10%',
      '64',
      '売 p 64000',
      '.*',
    ]) {
      expect(paletteFilter(items, q), q).toEqual(paletteFilter(cmds, q));
    }
    expect(paletteFilter(items, '急落').length).toBe(1);
    expect(paletteFilter(items, 'ATM').map((r) => r.label)).toEqual(['ATM へ']);
    // 足 0 本の「全クリア」は押せない 1 行だけ（ui:check の #89 AC-B5(b)。「クリア」だけだと用語の JSCC にも当たる）
    const empty = paletteFilter(paletteItems(inputOf(loaded)), '全クリア');
    expect(empty.map((r) => [r.id, r.disabled])).toEqual([['work:clear', true]]);
    expect(ids('クリア')).toContain('term:jscc');
  });

  it('(e) 用語の行の実行は {kind: term, id}、id は term:<用語の id>', () => {
    for (const [i, r] of terms.entries()) {
      const t = GLOSSARY[i];
      expect(r.id).toBe(`term:${t?.id}`);
      expect(r.run).toEqual({ kind: 'term', id: t?.id });
    }
  });

  it('paletteNorm: カタカナをひらがなに（半角カナも NFKC の後に）', () => {
    expect(paletteNorm('シグマ')).toBe('しぐま');
    expect(paletteNorm('ｼｸﾞﾏ')).toBe('しぐま');
    expect(paletteNorm('ヴァ・ー')).toBe('ゔぁ・ー');
  });
});

describe('paletteView', () => {
  const items = paletteItems(inputOf(twoLegs));

  it('先頭 50 行と残りの件数・状態の文', () => {
    expect(items.length).toBeGreaterThan(PALETTE_LIMIT);
    const v = paletteView(items);
    expect(v.shown).toEqual(items.slice(0, PALETTE_LIMIT));
    expect(v.rest).toBe(items.length - PALETTE_LIMIT);
    expect(v.status).toBe(`${items.length} 件 · ほか ${v.rest} 件（文字で絞り込む）`);
    const few = paletteView(items.slice(0, 3));
    expect(few).toEqual({ shown: items.slice(0, 3), rest: 0, status: '3 件' });
    expect(paletteView([])).toEqual({ shown: [], rest: 0, status: '該当なし' });
    const exact = paletteView(items.slice(0, PALETTE_LIMIT));
    expect(exact.rest).toBe(0);
    expect(exact.status).toBe(`${PALETTE_LIMIT} 件`);
  });
});

describe('paletteKey', () => {
  const k = (key: string, o: Partial<Parameters<typeof paletteKey>[0]> = {}) =>
    paletteKey({ key, isComposing: false, keyCode: 0, ctrl: false, meta: false, alt: false, ...o });

  it('↓ / ↑ / Enter / Esc / Tab だけ（Home / End・文字は入力欄の既定）', () => {
    expect(k('ArrowDown')).toBe('down');
    expect(k('ArrowUp')).toBe('up');
    expect(k('Enter')).toBe('run');
    expect(k('Escape')).toBe('close');
    expect(k('Tab')).toBe('stay');
    for (const key of ['Home', 'End', 'a', '1', 'g', 't', 'PageDown', 'ArrowLeft', ' ']) {
      expect(k(key)).toBeNull();
    }
  });

  it('IME の変換中（isComposing・Process・229）はどのキーも null（確定の Enter で実行しない・取り消しの Esc で閉じない）', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab']) {
      expect(k(key, { isComposing: true })).toBeNull();
      expect(k(key, { keyCode: 229 })).toBeNull();
    }
    expect(k('Process')).toBeNull();
  });

  it('Ctrl / ⌘ + K は close（開け閉め・ブラウザの既定を止める）。Shift / Alt 付き・変換中は null', () => {
    expect(k('k', { ctrl: true })).toBe('close');
    expect(k('k', { meta: true })).toBe('close');
    expect(k('K', { ctrl: true })).toBe('close');
    expect(k('k', { ctrl: true, alt: true })).toBeNull();
    expect(k('k', { ctrl: true, shift: true })).toBeNull();
    expect(k('k', { ctrl: true, isComposing: true })).toBeNull();
    expect(k('k')).toBeNull();
  });

  it('Ctrl / ⌘ / Alt 付きは null', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      expect(k(key, { ctrl: true })).toBeNull();
      expect(k(key, { meta: true })).toBeNull();
      expect(k(key, { alt: true })).toBeNull();
    }
  });
});

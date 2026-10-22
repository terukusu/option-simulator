import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { fmtIv, fmtNum } from '../../ui/view/format';
import { smilePickRow } from '../../ui/view/smile';
import {
  SMILE_ACT_HINT,
  SMILE_AXIS_OPTIONS,
  SMILE_EFF_ACT_HINT,
  SMILE_LEGEND_HINT,
  SMILE_LINE_CLASS,
  smileAct,
  smileLegend,
} from '../../ui/view/smilePanel';
import { fixture } from '../support/fixtures';

/** #85 AC-4: 新しい画面のスマイルの表示モデル。合成の板・架空の値。 */

const chain = normalizeChain(fixture('latest'));
const [m1] = chain.months;
if (!m1) throw new Error('限月が無い');

describe('AC-4(a) 操作行', () => {
  it('未選択は案内の文', () => {
    expect(smileAct(m1, null)).toEqual({ hint: '点をタップで選ぶ · 長押しで連続 · , .' });
    expect(SMILE_ACT_HINT).toBe('点をタップで選ぶ · 長押しで連続 · , .');
  });

  it('板に無い K は案内', () => {
    expect(smileAct(m1, 1)).toEqual({ hint: SMILE_ACT_HINT });
  });

  it('選択中は K・種別（OTM 側）・IV 1 桁・bid / ask（無ければ —）', () => {
    let quoted = 0;
    let missing = 0;
    for (const s of m1.strikes) {
      const a = smileAct(m1, s.k);
      const row = smilePickRow(m1, s.k);
      if (!row || 'hint' in a) throw new Error('操作行が無い');
      expect(a.k).toBe(s.k);
      expect(a.type).toBe(s.otmType);
      expect(a.title).toBe(`${fmtNum(s.k, 0)} ${s.otmType}`);
      expect(a.iv).toBe(`IV ${fmtIv(s.smileIv)}`);
      expect(a.unstable).toBe(s.unstable);
      expect(a.bid).toBe(row.bid === null ? '—' : fmtNum(row.bid, 0));
      expect(a.ask).toBe(row.ask === null ? '—' : fmtNum(row.ask, 0));
      if (row.bid === null) {
        missing++;
        expect(a.sellLabel).toContain('気配なし');
      } else quoted++;
    }
    expect(quoted).toBeGreaterThan(0);
    expect(missing).toBeGreaterThan(0);
  });

  it('IV 不安定の行は unstable', () => {
    const u = m1.strikes.find((s) => s.unstable);
    if (!u) throw new Error('IV 不安定の行が無い');
    const a = smileAct(m1, u.k);
    expect('hint' in a ? null : a.unstable).toBe(true);
  });
});

describe('AC-4(b) 凡例', () => {
  it('ΔX = 0（シナリオ ATM なし）ではシナリオ ATM の項目なし', () => {
    const items = smileLegend('B', null);
    expect(items.map((i) => i.text)).toEqual([
      '● mid',
      '● bid',
      '● ask',
      '─ 節点',
      '┄ 補間・外挿',
      '× IV 不安定',
      '┆ ATM（B）',
    ]);
  });

  it('ΔX ≠ 0 ではシナリオ ATM と K', () => {
    const items = smileLegend('A', 67500);
    expect(items.at(-1)).toEqual({
      key: 'atm2',
      text: '┆ シナリオ ATM 67,500',
      short: '┆シナリオ',
      cls: SMILE_LINE_CLASS.scenario,
    });
    expect(items.at(-2)?.text).toBe('┆ ATM（A）');
  });
});

describe('レビュー S2 凡例は隠さず短くする', () => {
  it('どの項目にも短い形があり、ⓘ に全項目の意味', () => {
    const items = smileLegend('B', 67500);
    expect(items.map((i) => i.short)).toEqual([
      '●mid',
      '●bid',
      '●ask',
      '─節点',
      '┄補間',
      '×不安定',
      '┆ATM',
      '┆シナリオ',
    ]);
    for (const i of items) expect(i.short.length).toBeLessThanOrEqual(i.text.length);
    for (const s of ['mid', '節点', '補間・外挿', 'IV 不安定', 'ATM', 'シナリオ ATM']) {
      expect(SMILE_LEGEND_HINT).toContain(s);
    }
  });
});

describe('AC-4(c) 線の種類', () => {
  it('ATM / シナリオ ATM / 選択は別のクラス（凡例の印も同じ）', () => {
    const cls = Object.values(SMILE_LINE_CLASS);
    expect(new Set(cls).size).toBe(3);
    expect(SMILE_LINE_CLASS).toEqual({ atm: 'atm', scenario: 'atm2', pick: 'sel' });
    expect(smileLegend('B', 1).find((i) => i.key === 'atm')?.cls).toBe(SMILE_LINE_CLASS.atm);
  });

  it('横軸の Seg: Δ の aria-label はデルタ', () => {
    expect(SMILE_AXIS_OPTIONS.map((o) => o.text)).toEqual(['行使価格', 'moneyness', 'Δ']);
    expect(SMILE_AXIS_OPTIONS[2].label).toBe('デルタ');
  });
});

describe('#259 効率の線の凡例・操作行の案内', () => {
  it('S-1 [効率] オフなら効率の項目なし、オンでシナリオ点の実線、今の線があれば今の破線（最後に）', () => {
    expect(smileLegend('B', null).some((i) => i.key.startsWith('eff'))).toBe(false);
    const on = smileLegend('B', 67500, { now: false });
    expect(on.at(-1)).toEqual({
      key: 'eff',
      text: '─ 効率（シナリオ点）',
      short: '─効率',
      cls: 'eff',
    });
    const now = smileLegend('B', null, { now: true });
    expect(now.slice(-2).map((i) => [i.text, i.short, i.cls])).toEqual([
      ['─ 効率（シナリオ点）', '─効率', 'eff'],
      ['┄ 効率（今）', '┄今', 'eff now'],
    ]);
    expect(SMILE_LEGEND_HINT).toContain('─ 効率（シナリオ点）');
    expect(SMILE_LEGEND_HINT).toContain('┄ 効率（今）');
  });

  it('S-4 [効率] オンで未選択なら効率の定義と注意、選択中は今のまま', () => {
    expect(smileAct(m1, null, true)).toEqual({ hint: SMILE_EFF_ACT_HINT });
    expect(SMILE_EFF_ACT_HINT).toBe(
      '効率 = プレミアム ÷ 必要証拠金（1 枚売り）· 高い所ほど値動きの損失も大きい',
    );
    expect(smileAct(m1, null, false)).toEqual({ hint: SMILE_ACT_HINT });
    const s = m1.strikes.find((r) => r.smileIv !== null) as (typeof m1.strikes)[number];
    expect(smileAct(m1, s.k, true)).toEqual(smileAct(m1, s.k));
  });
});

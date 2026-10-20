/**
 * #200 AC4: AI のツール technicals（ui/view/aiTechnicals.ts）。合成の先物の足（scripts/synthFutBars.ts。架空の値）で、
 * 画面の段と同じ計算（model/technicals.ts の indicators）・基準率の規則・入力の検査・大きさを確かめる。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TECH_PARAMS, indicators, resample4h, resampleWeekly } from '../../model';
import { synthTechnicalsData } from '../../scripts/synthFutBars';
import {
  TECH_HORIZON,
  TECH_RECENT,
  techBars,
  techFrame,
  technicalsTool,
  techParamsOf,
} from '../../ui/view/aiTechnicals';
import { runTool } from '../../ui/view/aiTools';
import { indPaneModel } from '../../ui/view/indicators';

const data = synthTechnicalsData();
// biome-ignore lint/suspicious/noExplicitAny: 結果の JSON を添字で読む（形は pytest が tools.py の形で検査する）
const run = (input: Record<string, unknown> = {}): any => technicalsTool(data, input);

describe('足', () => {
  it('週足 = 日足を束ねる、4 時間足 = 1 時間足を束ねる（画面と同じ関数）', () => {
    expect(techBars(data, 'daily')).toBe(data.daily);
    expect(techBars(data, 'weekly')).toEqual(resampleWeekly(data.daily));
    expect(techBars(data, '4h')).toEqual(resample4h(data.hourly));
    // 合成の 1 時間足は 1 取引日 21 本 → 4 時間足 5 本
    expect(techBars(data, '4h').length * 21).toBe(data.hourly.length * 5);
  });
});

describe('結果', () => {
  it('既定 = 週足・日足・4 時間足 × 3 指標。今の値は画面の段と同じ計算（丸めただけ）', () => {
    const r = run();
    expect(r.frames.map((f: { tf: string }) => f.tf)).toEqual(['weekly', 'daily', '4h']);
    expect(r.params).toEqual({
      rsi: 14,
      macd: [12, 26, 9],
      stoch: [14, 3, 3],
      ema: [5, 25, 75],
      rsi_zones: [30, 70],
      stoch_zones: [20, 80],
    });
    const daily = r.frames[1];
    const ind = indicators(data.daily);
    const last = data.daily.length - 1;
    expect(daily.n_bars).toBe(data.daily.length);
    expect(daily.close_x).toBe(data.daily[last]?.c);
    expect(daily.horizon_bars).toBe(TECH_HORIZON.daily);
    expect(daily.rsi.rsi).toBe(Math.round((ind.rsi[last] as number) * 10) / 10);
    expect(daily.macd.hist_yen).toBe(Math.round(ind.macd.hist[last] as number));
    expect(daily.stoch.stoch_k).toBe(Math.round((ind.stoch.k[last] as number) * 10) / 10);
    expect(daily.rsi.recent).toHaveLength(TECH_RECENT);
    expect(daily.rsi.recent.at(-1)).toBe(daily.rsi.rsi);
    expect(daily.macd.recent_hist_yen).toHaveLength(TECH_RECENT);
    expect(daily.stoch.recent_k).toHaveLength(TECH_RECENT);
    // 生の足の列は返さない（数値の配列は直近 20 本の 3 つだけ）
    expect(JSON.stringify(r)).not.toContain('"o":');
  });
  it('状態: ゾーンは今の値から、続いた本数・交差から何本目', () => {
    const f = run({ timeframes: ['daily'] }).frames[0];
    const z = f.rsi.rsi >= 70 ? 'high' : f.rsi.rsi <= 30 ? 'low' : 'mid';
    expect(f.rsi.zone).toBe(z);
    expect(f.rsi.bars_in_zone).toBeGreaterThanOrEqual(1);
    expect(f.macd.above_signal).toBe(f.macd.hist_yen >= 0);
    expect(f.macd.bars_since_cross === null || f.macd.bars_since_cross >= 1).toBe(true);
  });
  it('基準率: 条件なし・条件ごとに件数・中央値・p10 ≤ 中央値 ≤ p90・件数 < 20 は insufficient', () => {
    for (const f of run().frames) {
      const rates = Object.values(f.base_rates) as {
        n: number;
        median_pct: number | null;
        p10_pct: number | null;
        p90_pct: number | null;
        insufficient: boolean;
      }[];
      expect(rates.length).toBe(5);
      for (const b of rates) {
        expect(b.insufficient).toBe(b.n < 20);
        if (b.n === 0) continue;
        expect(b.p10_pct as number).toBeLessThanOrEqual(b.median_pct as number);
        expect(b.median_pct as number).toBeLessThanOrEqual(b.p90_pct as number);
      }
      // 条件つきの件数は条件なし以下（同じ窓の規則）
      expect(f.base_rates.rsi.n).toBeLessThanOrEqual(f.base_rates.all.n + 0);
      expect(f.base_rates.rsi.condition).toBe(`rsi_${f.rsi.zone}`);
    }
  });
  it('基準率は最後の足を使わない（最後の足の値を変えても分布は変わらない）', () => {
    const bars = data.daily.map((b) => ({ ...b }));
    const a = techFrame(bars, 'daily', ['rsi'], 5) as { base_rates: { all: unknown } };
    const last = bars.at(-1) as (typeof bars)[number];
    bars[bars.length - 1] = { ...last, c: last.c * 1.5, h: last.c * 1.5 };
    const b = techFrame(bars, 'daily', ['rsi'], 5) as { base_rates: { all: unknown } };
    expect(b.base_rates.all).toEqual(a.base_rates.all);
  });
  it('限月交代をまたぐ窓は基準率から除く（rolls_excluded）。最新の足は確定前のことがある印', () => {
    const f = run({ timeframes: ['weekly'] }).frames[0];
    expect(f.last_bar_may_be_partial).toBe(true);
    // 合成の足は四半期ごとに限月が替わる = 週足 4 本先の窓の一部が交代をまたぐ
    expect(f.base_rates.all.rolls_excluded).toBeGreaterThan(0);
    // 限月を 1 つにすると除かれない（件数は除いた分だけ増える = 窓の選び方は同じ規則）
    const one = { daily: data.daily.map((b) => ({ ...b, m: '2026-12' })), hourly: [] };
    const g = (
      technicalsTool(one, { timeframes: ['weekly'] }) as {
        frames: { base_rates: { all: { n: number; rolls_excluded: number } } }[];
      }
    ).frames[0];
    expect(g?.base_rates.all.rolls_excluded).toBe(0);
    expect(g?.base_rates.all.n).toBeGreaterThan(f.base_rates.all.n);
  });
  it('指標・足を絞る、horizon_bars', () => {
    const r = run({ timeframes: ['4h', 'weekly'], indicators: ['stoch'], horizon_bars: 3 });
    expect(r.frames.map((f: { tf: string }) => f.tf)).toEqual(['weekly', '4h']);
    expect(Object.keys(r.frames[0])).toEqual([
      'tf',
      'n_bars',
      'last_t',
      'close_x',
      'horizon_bars',
      'last_bar_may_be_partial',
      'stoch',
      'base_rates',
    ]);
    expect(r.frames[0].horizon_bars).toBe(3);
    expect(Object.keys(r.frames[0].base_rates)).toEqual(['all', 'stoch']);
    expect(r.frames[1].last_t).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(r.frames[0].last_t).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('大きさ: 1 足あたり 1.5k トークン（JSON 3,750 字 ≈ 2.5 字 / トークンの目安）以下', () => {
    const all = JSON.stringify(run());
    for (const tf of ['weekly', 'daily', '4h']) {
      const one = JSON.stringify(run({ timeframes: [tf] }));
      expect(one.length).toBeLessThan(3750);
    }
    expect(all.length).toBeLessThan(3 * 3750);
  });
});

describe('EMA の 3 本（#206）', () => {
  it('値・距離・並び順・交差は画面と同じ emaSet（丸めただけ）', () => {
    const f = run({ timeframes: ['daily'], indicators: ['ema'] }).frames[0];
    const ind = indicators(data.daily);
    const last = data.daily.length - 1;
    const c = data.daily[last]?.c as number;
    const series = [ind.ema.short, ind.ema.mid, ind.ema.long];
    expect(f.ema.lines.map((l: { period: number }) => l.period)).toEqual([5, 25, 75]);
    f.ema.lines.forEach((l: { ema_x: number; dist_yen: number; dist_pct: number }, k: number) => {
      const v = series[k]?.[last] as number;
      expect(l.ema_x).toBe(Math.round(v));
      expect(l.dist_yen).toBe(Math.round(c - v));
      expect(l.dist_pct).toBe(Math.round((c / v - 1) * 1000) / 10);
    });
    const [s, m, l] = series.map((x) => x[last] as number) as [number, number, number];
    expect(f.ema.order).toBe(s > m && m > l ? 'up' : s < m && m < l ? 'down' : 'mixed');
    expect(f.ema.bars_in_order).toBeGreaterThanOrEqual(1);
    expect(f.ema.crosses.map((x: { pair: string }) => x.pair)).toEqual([
      'short_mid',
      'mid_long',
      'short_long',
    ]);
    expect(f.ema.crosses[0].shorter_above).toBe(s >= m);
    expect(f.ema.crosses[1].shorter_above).toBe(m >= l);
    expect(f.base_rates.ema.condition).toBe(`ema_order_${f.ema.order}`);
    expect(Object.keys(f.base_rates)).toEqual(['all', 'ema']);
  });
  it('ウォームアップ: 長期の EMA に足りない足では値・並び順・基準率が無い（間違った値を出さない）', () => {
    const few = { daily: data.daily.slice(0, 40), hourly: [] };
    // biome-ignore lint/suspicious/noExplicitAny: 結果の JSON を添字で読む
    const f: any = (technicalsTool(few, { timeframes: ['daily'], indicators: ['ema'] }) as any)
      .frames[0];
    expect(f.ema.lines[0].ema_x).not.toBeNull();
    expect(f.ema.lines[2]).toEqual({ period: 75, ema_x: null, dist_yen: null, dist_pct: null });
    expect(f.ema.order).toBeNull();
    expect(f.ema.bars_in_order).toBe(0);
    expect(f.ema.crosses[1]).toEqual({
      pair: 'mid_long',
      shorter_above: null,
      bars_since_cross: null,
    });
    expect(f.base_rates.ema).toBeUndefined();
  });
});

describe('入力の検査と失敗', () => {
  it('知らないキー・足・指標は bad_input、範囲の外は out_of_range、データなしは no_data', () => {
    expect(run({ cmd: 1 })).toEqual({ error: 'bad_input' });
    expect(run({ timeframes: ['1m'] })).toEqual({ error: 'bad_input' });
    expect(run({ timeframes: [] })).toEqual({ error: 'bad_input' });
    expect(run({ indicators: ['bollinger'] })).toEqual({ error: 'bad_input' });
    expect(run({ horizon_bars: 2.5 })).toEqual({ error: 'bad_input' });
    expect(run({ horizon_bars: 21 })).toEqual({ error: 'out_of_range' });
    expect(run({ horizon_bars: 0 })).toEqual({ error: 'out_of_range' });
    expect(technicalsTool(null, {})).toEqual({ error: 'no_data' });
    expect(technicalsTool({ daily: [], hourly: [] }, {})).toEqual({ error: 'no_data' });
  });
  it('runTool から呼べる（足が無くても使える）', () => {
    const env = { technicals: data } as unknown as Parameters<typeof runTool>[2];
    const r = runTool('technicals', { timeframes: ['daily'] }, env) as { frames: unknown[] };
    expect(r.frames).toHaveLength(1);
    expect(runTool('technicals', {}, { ...env, technicals: null })).toEqual({ error: 'no_data' });
  });
  it('足りない足（指標の計算に足りない）でも形は同じで値は null', () => {
    const few = { daily: data.daily.slice(0, 5), hourly: [] };
    const f = technicalsTool(few, { timeframes: ['daily'] }) as {
      frames: { rsi: { rsi: number | null }; macd: { hist_yen: number | null } }[];
    };
    expect(f.frames[0]?.rsi.rsi).toBeNull();
    expect(f.frames[0]?.macd.hist_yen).toBeNull();
  });
});

describe('dev の偽の AI（scripts/devFixtures.mjs。Anthropic を呼ばない）', () => {
  it('「RSI」で technicals を呼び、結果から件数つきの文を返す', async () => {
    const { synthAiReply } = await import('../../scripts/devFixtures.mjs');
    const ask = synthAiReply({
      kind: 'chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: '日足の RSI は？' }] }],
    });
    expect(ask.tool).toMatchObject({ name: 'technicals', input: { timeframes: ['daily'] } });
    const result = run({ timeframes: ['daily'] });
    const reply = synthAiReply({
      kind: 'chat',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '日足の RSI は？' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't', name: 'technicals', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't',
              content: [{ type: 'text', text: JSON.stringify(result) }],
            },
          ],
        },
      ],
    });
    expect(reply.text).toContain(`件数 ${result.frames[0].base_rates.rsi.n}`);
    expect(reply.text).toContain('予想ではなく材料');
  });
});

describe('期間（#205）: 段とツールが同じ期間を使う', () => {
  const p = {
    rsi: 9,
    macdFast: 8,
    macdSlow: 21,
    macdSignal: 5,
    stochK: 9,
    stochSmooth: 2,
    stochD: 4,
    emaShort: 4,
    emaMid: 10,
    emaLong: 30,
  };
  it('データの params で計算し、出力の params はその期間。値は段（indicators と indPaneModel）と同じ', () => {
    // biome-ignore lint/suspicious/noExplicitAny: 結果の JSON を添字で読む
    const r: any = technicalsTool({ ...data, params: p }, { timeframes: ['daily'] });
    expect(r.params).toEqual({
      rsi: 9,
      macd: [8, 21, 5],
      stoch: [9, 2, 4],
      ema: [4, 10, 30],
      rsi_zones: [30, 70],
      stoch_zones: [20, 80],
    });
    const ind = indicators(data.daily, p);
    const last = data.daily.length - 1;
    const f = r.frames[0];
    expect(f.rsi.rsi).toBe(Math.round((ind.rsi[last] as number) * 10) / 10);
    expect(f.macd.hist_yen).toBe(Math.round(ind.macd.hist[last] as number));
    expect(f.stoch.stoch_k).toBe(Math.round((ind.stoch.k[last] as number) * 10) / 10);
    // 既定の期間とは値が違う（期間が効いている）
    const d = run({ timeframes: ['daily'] }).frames[0];
    expect(f.rsi.recent).not.toEqual(d.rsi.recent);
    // 段の見出しも同じ期間
    const pane = indPaneModel({
      ind,
      kind: 'rsi',
      n: data.daily.length,
      viewport: [0, last],
      width: 360,
      marginLeft: 50,
    });
    expect(pane.title).toBe(`RSI（${r.params.rsi}）`);
  });
  it('基準率もその期間の状態で数える（techFrame に同じ期間を渡したのと同じ）', () => {
    // biome-ignore lint/suspicious/noExplicitAny: 結果の JSON を添字で読む
    const r: any = technicalsTool({ ...data, params: p }, { timeframes: ['daily'] });
    // biome-ignore lint/suspicious/noExplicitAny: 結果の JSON を添字で読む
    const f: any = techFrame(
      data.daily,
      'daily',
      ['rsi', 'macd', 'stoch', 'ema'],
      TECH_HORIZON.daily,
      p,
    );
    expect(r.frames[0].base_rates).toEqual(f.base_rates);
  });
  it('params が無い・不正（短期 ≥ 長期・範囲外）→ 既定', () => {
    expect(techParamsOf(null)).toEqual(DEFAULT_TECH_PARAMS);
    expect(techParamsOf({ ...data, params: { ...p, macdFast: 30 } })).toEqual(DEFAULT_TECH_PARAMS);
    expect(techParamsOf({ ...data, params: { ...p, rsi: 101 } })).toEqual(DEFAULT_TECH_PARAMS);
    expect(techParamsOf({ ...data, params: { ...p, emaMid: 40 } })).toEqual(DEFAULT_TECH_PARAMS);
    expect(techParamsOf({ ...data, params: p })).toEqual(p);
  });
});

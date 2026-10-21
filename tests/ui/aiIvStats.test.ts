/**
 * #138・#158 AC2: AI のツール iv_stats（ui/view/aiIvStats.ts）。結果のキー・丸め・節の選択・失敗・今の値の代え方・件数の
 * 少ない集計の印・大きさ。値はすべて架空（合成の日次の値。scripts/devFixtures.mjs の synthAtmDaily と、手で組んだ列）。
 */
import { describe, expect, it } from 'vitest';
import type { AtmDailyDay } from '../../data/atmDaily';
import { validateAtmDailyJson } from '../../data/atmDaily';
import { buildCalendar } from '../../data/calendar';
import bundledJson from '../../data/calendar/calendar.json';
import { SYNTH_IV_NOW, synthAtmDaily } from '../../scripts/devFixtures.mjs';
import {
  IV_SECTIONS,
  type IvStatsData,
  ivStatsTool,
  MOVE_EDGES,
  moveBucket,
} from '../../ui/view/aiIvStats';

const NONE = new Set<string>();
type R = Record<string, any>;

/** 平日だけの日次の値（2025-01-06（月）から n 日。限月は替わらない。架空の値） */
function weekdays(n: number, iv: (i: number) => number, f1: (i: number) => number): AtmDailyDay[] {
  const out: AtmDailyDay[] = [];
  let t = Date.parse('2025-01-06T00:00:00Z');
  while (out.length < n) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const i = out.length;
      const d = new Date(t).toISOString().slice(0, 10);
      out.push({
        d,
        t: Date.parse(`${d}T06:00:00Z`) / 1000,
        iv: iv(i),
        f1: f1(i),
        l1: '2030-01-10',
        f2: f1(i) * 1.001,
        l2: '2030-02-14',
      });
    }
    t += 86_400_000;
  }
  return out;
}

const synth = (): IvStatsData => {
  const r = validateAtmDailyJson(synthAtmDaily(SYNTH_IV_NOW));
  if (!r.ok) throw new Error('合成の日次の値が検証に通らない');
  return { days: r.value.days, now: null };
};
const nonTrading = buildCalendar(bundledJson, 'bundled').nonTradingDays;

/** 結果の数値の葉（キーの名前つき） */
function leaves(v: unknown, key = '', out: [string, number][] = []): [string, number][] {
  if (typeof v === 'number') out.push([key, v]);
  else if (Array.isArray(v)) for (const x of v) leaves(x, key, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) leaves(x, k, out);
  }
  return out;
}

describe('iv_stats の結果', () => {
  it('4 節のキー・丸め（% と pt は小数 1 桁・β は 2 桁・日と件数は整数）・大きさ', () => {
    const res = ivStatsTool(synth(), nonTrading, {}) as R;
    expect(Object.keys(res)).toEqual(['data', ...IV_SECTIONS]);
    expect(res.data.now_source).toBe('daily_close');
    expect(res.level.windows.map((w: R) => w.window)).toEqual(['1y', '3y', 'all']);
    expect(res.level.changes.map((c: R) => c.days)).toEqual([1, 5, 20]);
    expect(res.moves.buckets.length).toBe(MOVE_EDGES.length + 1);
    expect(res.moves.beta.map((b: R) => b.window)).toEqual(['all', '1y']);
    expect(res.hv.windows.map((w: R) => w.days)).toEqual([5, 20, 60]);
    for (const [k, v] of leaves(res)) {
      expect(Number.isFinite(v)).toBe(true);
      if (/_pt$/.test(k) && /^(down|up|all)_pt$/.test(k)) expect(Math.round(v * 100) / 100).toBe(v);
      else if (/_(pct|pt)$/.test(k)) expect(Math.round(v * 10) / 10).toBe(v);
      else expect(Number.isInteger(v)).toBe(true);
    }
    // 生の日次の列は返さない・大きさ（JSON の字数）
    expect(JSON.stringify(res)).not.toContain('"f1"');
    expect(JSON.stringify(res).length).toBeLessThan(6000);
  });

  it('合成のデータの反応（下げで IV が上がる）が β の正の値と区分の中央値に出る', () => {
    const res = ivStatsTool(synth(), nonTrading, { sections: ['moves'] }) as R;
    const all = res.moves.beta[0];
    // synthAtmDaily: 1% の下げで約 1.2pt・上げで約 0.6pt 下げる反応 + 平均への回帰と雑音（架空）
    expect(all.down_pt).toBeGreaterThan(0.5);
    expect(all.up_pt).toBeGreaterThan(0);
    expect(all.down_pt).toBeGreaterThan(all.up_pt);
    const down3 = res.moves.buckets[2]; // −5〜−3%
    if (down3.n > 0) expect(down3.iv_change_median_pt).toBeGreaterThan(0);
    expect(res.moves.overlapping).toBe(true);
    expect(res.moves.horizon_days).toBe(2);
  });

  it('sections で節を選ぶ（順は level・spikes・moves・hv）', () => {
    const d = synth();
    expect(Object.keys(ivStatsTool(d, NONE, { sections: ['hv'] }))).toEqual(['data', 'hv']);
    expect(Object.keys(ivStatsTool(d, NONE, { sections: ['hv', 'level'] }))).toEqual([
      'data',
      'level',
      'hv',
    ]);
  });

  it('失敗: 知らないキー・節の名前・型は bad_input、しきい値の範囲外は out_of_range、データなしは no_data', () => {
    const d = synth();
    for (const bad of [
      { x: 1 },
      { sections: ['iv'] },
      { sections: [] },
      { sections: 'level' },
      { sections: ['level', 'level', 'hv', 'moves', 'spikes'] },
      { spike_rise_pct: '30' },
      { spike_rise_pct: Number.NaN },
    ]) {
      expect(ivStatsTool(d, NONE, bad)).toEqual({ error: 'bad_input' });
    }
    expect(ivStatsTool(d, NONE, { spike_rise_pct: 9.9 })).toEqual({ error: 'out_of_range' });
    expect(ivStatsTool(d, NONE, { spike_rise_pct: 101 })).toEqual({ error: 'out_of_range' });
    expect(ivStatsTool(null, NONE, {})).toEqual({ error: 'no_data' });
    expect(ivStatsTool({ days: [], now: null }, NONE, {})).toEqual({ error: 'no_data' });
  });
});

describe('今の値と水準', () => {
  // IV = 10, 11, …, 29（20 日）。F は一定
  const days = weekdays(
    20,
    (i) => 10 + i,
    () => 30000,
  );
  const last = days[19] as AtmDailyDay;

  it('1 時間足の終値が最後の日次の終値より後なら intraday（変化は昨日の終値から）', () => {
    const r = ivStatsTool({ days, now: { t: last.t + 3600 * 20, iv: 24.5 } }, NONE, {
      sections: ['level'],
    }) as R;
    expect(r.data).toMatchObject({
      first_d: '2025-01-06',
      last_d: last.d,
      n_days: 20,
      last_close_pct: 29,
      now_source: 'intraday',
      iv_now_pct: 24.5,
    });
    expect(r.data.now_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // 24.5 以下の日 = 10〜24 の 15 日 / 20
    const all = r.level.windows[2];
    expect(all).toMatchObject({
      window: 'all',
      n: 20,
      percentile_pct: 75,
      min_pct: 10,
      max_pct: 29,
    });
    expect(all.p50_pct).toBe(19.5);
    // 1 日: 24.5 − 29 = −4.5pt（−15.5%）。過去の 1 日の変化は全部 +1 → 分位 0
    expect(r.level.changes[0]).toEqual({
      days: 1,
      iv_change_pt: -4.5,
      iv_change_pct: -15.5,
      percentile_pct: 0,
      n: 19,
    });
    // 20 日: 最初の行（10）から +14.5pt。過去の 20 行差は 0 件 → 分位 null
    expect(r.level.changes[2]).toEqual({
      days: 20,
      iv_change_pt: 14.5,
      iv_change_pct: 145,
      percentile_pct: null,
      n: 0,
    });
  });

  it('今の値が無い・最後の終値より前なら最後の日次の終値（変化は終値どうし）', () => {
    for (const now of [null, { t: last.t - 60, iv: 50 }, { t: last.t + 60, iv: Number.NaN }]) {
      const r = ivStatsTool({ days, now }, NONE, { sections: ['level'] }) as R;
      expect(r.data.now_source).toBe('daily_close');
      expect(r.data.iv_now_pct).toBe(29);
      expect(r.level.changes[1]).toMatchObject({ days: 5, iv_change_pt: 5, percentile_pct: 100 });
      expect(r.level.windows[2].percentile_pct).toBe(100);
    }
  });

  it('窓: 1y は最後の日から暦日 365 日以内', () => {
    // 平日 300 日 ≈ 暦日 418 日。1y の窓は最初の約 2 か月を含まない
    const long = weekdays(
      300,
      (i) => 10 + (i % 7),
      () => 30000,
    );
    const r = ivStatsTool({ days: long, now: null }, NONE, { sections: ['level'] }) as R;
    const [y1, y3, all] = r.level.windows;
    expect(all.n).toBe(300);
    expect(y3.n).toBe(300);
    const lastD = long[299]?.d as string;
    const from = new Date(Date.parse(`${lastD}T00:00:00Z`) - 365 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(y1.n).toBe(long.filter((x) => x.d > from).length);
    expect(y1.n).toBeLessThan(300);
  });
});

describe('2 日の動き・HV', () => {
  it('区分の境（dx_from_pct ≤ 変化 < dx_to_pct）', () => {
    expect(moveBucket(-8.01)).toBe(0);
    expect(moveBucket(-8)).toBe(1);
    expect(moveBucket(-0.5)).toBe(4);
    expect(moveBucket(1)).toBe(5);
    expect(moveBucket(5)).toBe(7);
    expect(moveBucket(12)).toBe(7);
  });

  it('既知の 2 日の動きの区分・最新・件数の少ない区分の印', () => {
    // F は −2% を 2 日続けて 2 日止まるの繰り返し（架空）
    const f: number[] = [];
    let s = 30000;
    for (let i = 0; i < 41; i++) {
      f.push(s);
      s *= i % 4 < 2 ? 0.98 : 1;
    }
    const days = weekdays(
      41,
      (i) => 20 + (i % 4 < 2 ? i % 4 : 0),
      (i) => f[i] as number,
    );
    const r = ivStatsTool({ days, now: null }, NONE, { sections: ['moves'] }) as R;
    expect(r.moves.n).toBe(39);
    const n = r.moves.buckets.map((b: R) => b.n);
    expect(n.reduce((a: number, b: number) => a + b, 0)).toBe(39);
    for (const b of r.moves.buckets) expect(b.insufficient).toBe(b.n < 20);
    expect(r.moves.latest.d1).toBe(days[40]?.d);
    expect(r.moves.latest.bucket).toBe(moveBucket(r.moves.latest.dx_pct));
    // β は 20 組未満の側が null
    for (const b of r.moves.beta) {
      if (b.n_down < 20) expect(b.down_pt).toBeNull();
      if (b.n_up < 20) expect(b.up_pt).toBeNull();
    }
  });

  it('HV: ±a の交互の対数変化 → a·sqrt(245)、IV − HV はその日の終値 − HV', () => {
    const a = 0.01;
    const days = weekdays(
      70,
      () => 25,
      (i) => 30000 * Math.exp(i % 2 === 0 ? 0 : a),
    );
    const r = ivStatsTool({ days, now: { t: (days[69] as AtmDailyDay).t + 7200, iv: 40 } }, NONE, {
      sections: ['hv'],
    }) as R;
    const hv = Math.round(a * Math.sqrt(245) * 1000) / 10; // 15.7
    expect(r.hv.days_per_year).toBe(245);
    expect(r.hv.as_of_d).toBe(days[69]?.d);
    expect(r.hv.iv_pct).toBe(25);
    for (const w of r.hv.windows) {
      expect(w.hv_pct).toBe(hv);
      // 今の値（40）ではなく同じ日の終値（25）と比べる
      expect(w.iv_minus_hv_pt).toBe(Math.round((25 - a * Math.sqrt(245) * 100) * 10) / 10);
    }
    // 差は毎日同じ → 分位 100、中央値 = 今の差
    expect(r.hv.iv_minus_hv20_percentile_pct).toBe(100);
    expect(r.hv.n_hv20).toBe(69 - 19);
  });

  it('スパイク: 件数の少ない要約は insufficient・今の上昇率', () => {
    const iv = (i: number) => (i === 30 ? 30 : i === 31 ? 22 : i === 32 ? 18 : 20);
    const days = weekdays(60, iv, () => 30000);
    const r = ivStatsTool({ days, now: { t: (days[59] as AtmDailyDay).t + 3600, iv: 28 } }, NONE, {
      sections: ['spikes'],
    }) as R;
    expect(r.spikes.n).toBe(1);
    expect(r.spikes.recent[0]).toMatchObject({
      start_d: days[30]?.d,
      peak_d: days[30]?.d,
      base_pct: 20,
      peak_pct: 30,
      rise_pct: 50,
      days_to_peak: 0,
      half_d: days[31]?.d,
      days_to_half: 1,
      days_to_90pct: 2,
      ongoing: false,
    });
    expect(r.spikes.summary.days_to_half).toMatchObject({
      n: 1,
      median_days: 1,
      insufficient: true,
    });
    expect(r.spikes.after_peak[0]).toMatchObject({ days: 5, n: 1, median_pct: -33.3 });
    // 今 28 / 直近 10 本の最低 20 = +40% ≥ 30% → スパイクの中
    expect(r.spikes.now_rise_from_low_pct).toBe(40);
    expect(r.spikes.now_in_spike).toBe(true);
    const calm = ivStatsTool({ days, now: null }, NONE, {
      sections: ['spikes'],
      spike_rise_pct: 60,
    }) as R;
    expect(calm.spikes).toMatchObject({ n: 0, now_in_spike: false, rise_threshold_pct: 60 });
  });
});

describe('dev の偽の AI（scripts/devFixtures.mjs。Anthropic を呼ばない）', () => {
  it('「分位」で iv_stats を呼び、結果から件数つきの文を返す', async () => {
    const { synthAiReply } = await import('../../scripts/devFixtures.mjs');
    const q = '今の IV は過去の分位でどの辺？';
    const ask = synthAiReply({
      kind: 'chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: q }] }],
    });
    expect(ask.tool).toMatchObject({ name: 'iv_stats', input: { sections: ['level', 'spikes'] } });
    const result = ivStatsTool(synth(), nonTrading, { sections: ['level', 'spikes'] }) as R;
    const reply = synthAiReply({
      kind: 'chat',
      messages: [
        { role: 'user', content: [{ type: 'text', text: q }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't', name: 'iv_stats', input: {} }],
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
    expect(reply.text).toContain(`${result.level.windows[0].percentile_pct}%`);
    expect(reply.text).toContain(`${result.spikes.summary.days_to_half.n} 回`);
    expect(reply.text).toContain('予想ではなく材料');
  });
});

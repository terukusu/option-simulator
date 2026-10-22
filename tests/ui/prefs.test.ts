import { describe, expect, it } from 'vitest';
import { DEFAULT_TECH_PARAMS } from '../../model';
import {
  AI_PROFILE_MAX,
  DEFAULT_MARGIN_PREFS,
  DEFAULT_PREFS,
  isAiProfile,
  type MarginPrefs,
  PREFS_KEY,
  PREFS_SCHEMA_VERSION,
  readPrefs,
  resolveTheme,
  serializePrefs,
  type ThemePref,
  techParamsOfPrefs,
  techParamsOr,
} from '../../ui/prefs';

/** #81: 端末の設定（option-simulator.prefs。版 1: テーマ + #131 の証拠金）。作業の保存とは別のキー。 */
const M0 = DEFAULT_MARGIN_PREFS;
const DEF = { theme: 'auto', margin: M0 };
/** 証拠金の既定のキー（書き出しの末尾） */
const M0_JSON =
  '"margin_k_pct":100,"margin_r_pct":5,"margin_iv_up_pct":50,"margin_iv_down_pct":25,"margin_ignore_long_options":true';

describe('readPrefs', () => {
  it('キーと版', () => {
    expect(PREFS_KEY).toBe('option-simulator.prefs');
    expect(PREFS_SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_PREFS).toEqual(DEF);
    expect(M0).toEqual({
      capitalYen: null,
      allowedLossYen: null,
      factorPct: 100,
      rangePct: 5,
      ivUpPct: 50,
      ivDownPct: 25,
      ignoreLongOptions: true,
    });
  });

  it('無い・JSON でない・形が違う・値が不正 → 既定（書いてよい）', () => {
    const bad = [
      null,
      '',
      'not json',
      '{',
      'null',
      '[]',
      '"dark"',
      '1',
      '{}',
      '{"schema_version":1}',
      '{"schema_version":1,"theme":"sepia"}',
      '{"schema_version":1,"theme":1}',
      '{"schema_version":1,"theme":"DARK"}',
      '{"schema_version":"1","theme":"dark"}',
      '{"schema_version":1.5,"theme":"dark"}',
      '{"schema_version":0,"theme":"dark"}',
      '{"schema_version":-1,"theme":"dark"}',
      '{"theme":"dark"}',
    ];
    for (const text of bad) {
      expect(readPrefs(text), String(text)).toEqual({ prefs: DEF, writable: true });
    }
  });

  it('新しい版（> 1）→ 既定を返し、書いてはいけない（このセッションでは書かない）', () => {
    expect(readPrefs('{"schema_version":2,"theme":"light","capital_yen":12345678}')).toEqual({
      prefs: DEF,
      writable: false,
    });
    expect(readPrefs('{"schema_version":99}')).toEqual({ prefs: DEF, writable: false });
  });

  it('書き出し → 読み取りで同じ値（往復）', () => {
    for (const theme of ['auto', 'dark', 'light'] as const satisfies readonly ThemePref[]) {
      const text = serializePrefs({ theme, margin: M0 });
      expect(text).toBe(`{"schema_version":1,"theme":"${theme}",${M0_JSON}}`);
      expect(readPrefs(text)).toEqual({ prefs: { theme, margin: M0 }, writable: true });
    }
  });

  it('余計なキーは読み取りでも書き出しでも写さない', () => {
    const read = readPrefs('{"schema_version":1,"theme":"dark","extra":"x"}');
    expect(read).toEqual({ prefs: { theme: 'dark', margin: M0 }, writable: true });
    const loose = { theme: 'light', margin: { ...M0, extra: 2 }, extra: 1 } as unknown as {
      theme: ThemePref;
      margin: MarginPrefs;
    };
    expect(serializePrefs(loose)).toBe(`{"schema_version":1,"theme":"light",${M0_JSON}}`);
  });
});

/** #131 AC15: 証拠金の設定（資金・掛け目・幅）の往復と、項目ごとの既定 */
describe('証拠金の設定（#131 AC15）', () => {
  const custom: MarginPrefs = {
    capitalYen: 12_345_678,
    allowedLossYen: null,
    factorPct: 150,
    rangePct: 10.5,
    ivUpPct: 37.5,
    ivDownPct: 0,
    ignoreLongOptions: false,
  };

  it('往復: 書き出し → 読み取りで同じ値（JSON のキーは capital_yen・margin_*。#150 のキー）', () => {
    const text = serializePrefs({ theme: 'dark', margin: custom });
    expect(JSON.parse(text)).toEqual({
      schema_version: 1,
      theme: 'dark',
      capital_yen: 12_345_678,
      margin_k_pct: 150,
      margin_r_pct: 10.5,
      margin_iv_up_pct: 37.5,
      margin_iv_down_pct: 0,
      margin_ignore_long_options: false,
    });
    expect(readPrefs(text)).toEqual({ prefs: { theme: 'dark', margin: custom }, writable: true });
    // 範囲の両端
    const ends: MarginPrefs = {
      capitalYen: 1e12,
      allowedLossYen: null,
      factorPct: 50,
      rangePct: 30,
      ivUpPct: 200,
      ivDownPct: 90,
      ignoreLongOptions: true,
    };
    expect(readPrefs(serializePrefs({ theme: 'auto', margin: ends })).prefs.margin).toEqual(ends);
    const lows: MarginPrefs = {
      capitalYen: 1,
      allowedLossYen: null,
      factorPct: 300,
      rangePct: 1,
      ivUpPct: 0,
      ivDownPct: 0,
      ignoreLongOptions: false,
    };
    expect(readPrefs(serializePrefs({ theme: 'auto', margin: lows })).prefs.margin).toEqual(lows);
  });

  it('資金が未設定（null）ならキーを書かない。0 も未設定として読む', () => {
    const text = serializePrefs({ theme: 'auto', margin: M0 });
    expect(text).not.toContain('capital');
    expect(readPrefs('{"schema_version":1,"theme":"auto","capital_yen":0}').prefs.margin).toEqual(
      M0,
    );
  });

  it('証拠金のキーの無い版 1（#131 より前の保存）→ テーマはそのまま、証拠金は既定', () => {
    expect(readPrefs('{"schema_version":1,"theme":"light"}')).toEqual({
      prefs: { theme: 'light', margin: M0 },
      writable: true,
    });
  });

  it('不正値（負・NaN・文字列・範囲外・小数の資金）→ その項目だけ既定、他の項目とテーマは残る', () => {
    const bad: [string, unknown][] = [
      ['capital_yen', -1],
      ['capital_yen', 1.5],
      ['capital_yen', 1e12 + 1],
      ['capital_yen', '12345678'],
      ['capital_yen', null],
      ['margin_k_pct', 49],
      ['margin_k_pct', 301],
      ['margin_k_pct', '120'],
      ['margin_r_pct', 0],
      ['margin_r_pct', -8],
      ['margin_r_pct', 31],
      ['margin_iv_up_pct', -1],
      ['margin_iv_up_pct', 201],
      ['margin_iv_up_pct', true],
      ['margin_iv_down_pct', -0.5],
      ['margin_iv_down_pct', 91],
      ['margin_iv_down_pct', [4]],
    ];
    const keyOf: Record<string, keyof MarginPrefs> = {
      capital_yen: 'capitalYen',
      margin_k_pct: 'factorPct',
      margin_r_pct: 'rangePct',
      margin_iv_up_pct: 'ivUpPct',
      margin_iv_down_pct: 'ivDownPct',
    };
    const good = JSON.parse(serializePrefs({ theme: 'dark', margin: custom }));
    for (const [k, v] of bad) {
      const text = JSON.stringify({ ...good, [k]: v });
      const r = readPrefs(text);
      const key = keyOf[k] as keyof MarginPrefs;
      expect(r.writable, `${k}=${String(v)}`).toBe(true);
      expect(r.prefs.theme).toBe('dark');
      expect(r.prefs.margin, `${k}=${String(v)}`).toEqual({ ...custom, [key]: M0[key] });
    }
    // NaN・∞ は JSON に出ないので、書き出しの側で既定にする（読み取りと同じ範囲）
    const nan = serializePrefs({
      theme: 'auto',
      margin: {
        capitalYen: Number.NaN,
        allowedLossYen: Number.NaN,
        factorPct: Number.NaN,
        rangePct: Infinity,
        ivUpPct: -1,
        ivDownPct: 99,
        ignoreLongOptions: 'false' as unknown as boolean,
      },
    });
    expect(nan).toBe(`{"schema_version":1,"theme":"auto",${M0_JSON}}`);
  });

  it('テーマが不正なら全体を既定（今までの規則のまま。証拠金のキーも既定）', () => {
    const text = JSON.stringify({
      ...JSON.parse(serializePrefs({ theme: 'dark', margin: custom })),
      theme: 'sepia',
    });
    expect(readPrefs(text)).toEqual({ prefs: DEF, writable: true });
  });
});

/** #180: 許容損失（追証マップの 2 本目の境目）。資金と同じ扱い（円の整数・0 / 空 = 未設定） */
describe('#180 許容損失の設定', () => {
  const withCap: MarginPrefs = { ...M0, capitalYen: 4_000_000, factorPct: 120 };

  it('許容損失のキーが無い古い保存 → 未設定（null）、資金などほかの値は変わらない', () => {
    const old = JSON.parse(serializePrefs({ theme: 'dark', margin: withCap }));
    expect(old).not.toHaveProperty('allowed_loss_yen');
    expect(readPrefs(JSON.stringify(old))).toEqual({
      prefs: { theme: 'dark', margin: withCap },
      writable: true,
    });
    expect(readPrefs(JSON.stringify(old)).prefs.margin.allowedLossYen).toBeNull();
  });

  it('往復: allowed_loss_yen で書き、読むと同じ値。未設定ならキーを書かない', () => {
    const m: MarginPrefs = { ...withCap, allowedLossYen: 300_000 };
    const text = serializePrefs({ theme: 'auto', margin: m });
    expect(JSON.parse(text).allowed_loss_yen).toBe(300_000);
    expect(readPrefs(text).prefs.margin).toEqual(m);
    expect(serializePrefs({ theme: 'auto', margin: withCap })).not.toContain('allowed_loss');
  });

  it('0・負・小数・範囲外・文字列 → 未設定、ほかの値は残る', () => {
    const good = JSON.parse(serializePrefs({ theme: 'dark', margin: withCap }));
    for (const v of [0, -1, 1.5, 1e12 + 1, '300000', null, Number.NaN]) {
      const r = readPrefs(JSON.stringify({ ...good, allowed_loss_yen: v }));
      expect(r.prefs.margin, String(v)).toEqual(withCap);
    }
    const bad = serializePrefs({ theme: 'dark', margin: { ...withCap, allowedLossYen: 2.5 } });
    expect(bad).not.toContain('allowed_loss');
  });
});

describe('#149 買いの OP の設定', () => {
  it('#149 買いの OP の設定: 無い・不正 → 既定（オン）、オフを往復、版は 1', () => {
    const custom: MarginPrefs = {
      capitalYen: 5_000_000,
      allowedLossYen: null,
      factorPct: 150,
      rangePct: 10,
      ivUpPct: 12,
      ivDownPct: 2,
      ignoreLongOptions: false,
    };
    const good = JSON.parse(serializePrefs({ theme: 'dark', margin: custom }));
    expect(good.schema_version).toBe(1);
    expect(good.margin_ignore_long_options).toBe(false);
    // オフの往復・オンの往復
    expect(readPrefs(JSON.stringify(good)).prefs.margin).toEqual(custom);
    const on = { ...custom, ignoreLongOptions: true };
    expect(readPrefs(serializePrefs({ theme: 'dark', margin: on })).prefs.margin).toEqual(on);
    // キーなし（#149 より前の保存）→ オン、他の項目はそのまま
    const { margin_ignore_long_options: _, ...noKey } = good;
    expect(readPrefs(JSON.stringify(noKey))).toEqual({
      prefs: { theme: 'dark', margin: on },
      writable: true,
    });
    // boolean でない値 → オン、他の項目とテーマは残る
    for (const v of ['false', 0, 1, null, [], {}]) {
      const r = readPrefs(JSON.stringify({ ...good, margin_ignore_long_options: v }));
      expect(r.writable, String(v)).toBe(true);
      expect(r.prefs.theme).toBe('dark');
      expect(r.prefs.margin, JSON.stringify(v)).toEqual(on);
    }
    // 書き出しは常に書く（boolean でなければ既定 = オン）
    expect(serializePrefs({ theme: 'auto', margin: M0 })).toContain(
      '"margin_ignore_long_options":true',
    );
    const broken = { ...M0, ignoreLongOptions: 0 as unknown as boolean };
    expect(
      JSON.parse(serializePrefs({ theme: 'auto', margin: broken })).margin_ignore_long_options,
    ).toBe(true);
  });
});

describe('#150 IV の幅は比率のキー、古い pt のキーは読まない、版は 1', () => {
  // #149 までのキー（掛け目・R・IV の pt）だけの保存。資金・買いの OP のキーは今のまま
  const OLD =
    '{"schema_version":1,"theme":"auto","margin_factor_pct":150,"margin_range_pct":10,"margin_iv_up_pt":12,"margin_iv_down_pt":2,"capital_yen":5000000,"margin_ignore_long_options":false}';

  it('#150 古いキーは読まない: 掛け目・R・IV は新しい既定、資金・買いの OP は残る', () => {
    const r = readPrefs(OLD);
    expect(r.writable).toBe(true);
    expect(r.prefs).toEqual({
      theme: 'auto',
      margin: { ...M0, capitalYen: 5_000_000, ignoreLongOptions: false },
    });
    expect(r.prefs.margin).toMatchObject({
      factorPct: 100,
      rangePct: 5,
      ivUpPct: 50,
      ivDownPct: 25,
    });
  });

  it('#150 書き出しに古いキーは無く、新しいキーを書く。版は 1', () => {
    const text = serializePrefs(readPrefs(OLD).prefs);
    for (const old of [
      'margin_factor_pct',
      'margin_range_pct',
      'margin_iv_up_pt',
      'margin_iv_down_pt',
    ]) {
      expect(text).not.toContain(old);
    }
    const o = JSON.parse(text);
    expect(o.schema_version).toBe(1);
    expect(o).toMatchObject({
      margin_k_pct: 100,
      margin_r_pct: 5,
      margin_iv_up_pct: 50,
      margin_iv_down_pct: 25,
      capital_yen: 5_000_000,
      margin_ignore_long_options: false,
    });
  });

  it('#150 新しいキーの往復と範囲（IV の上げ 0〜200%・下げ 0〜90%。小数可、外はその項目だけ既定）', () => {
    for (const [up, down] of [
      [0, 0],
      [200, 90],
      [12.5, 33.3],
    ] as const) {
      const margin: MarginPrefs = { ...M0, ivUpPct: up, ivDownPct: down };
      expect(readPrefs(serializePrefs({ theme: 'dark', margin })).prefs.margin).toEqual(margin);
    }
    const base = JSON.parse(
      serializePrefs({ theme: 'dark', margin: { ...M0, ivUpPct: 80, ivDownPct: 40 } }),
    );
    for (const [k, v] of [
      ['margin_iv_up_pct', 201],
      ['margin_iv_up_pct', -1],
      ['margin_iv_down_pct', 91],
      ['margin_iv_down_pct', -0.1],
    ] as const) {
      const m = readPrefs(JSON.stringify({ ...base, [k]: v })).prefs.margin;
      if (k === 'margin_iv_up_pct') expect(m, `${k}=${v}`).toEqual({ ...M0, ivDownPct: 40 });
      else expect(m, `${k}=${v}`).toEqual({ ...M0, ivUpPct: 80 });
    }
  });
});

describe('resolveTheme', () => {
  it('auto は端末の設定、dark / light はそのまま', () => {
    expect(resolveTheme('auto', true)).toBe('light');
    expect(resolveTheme('auto', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('#135 AI の免責の文を見た（ai_disclaimer_seen）', () => {
  it('無い・true でない → 未（キーを書かない）、true を往復、古い版 1 の保存を読める', () => {
    const old = JSON.stringify({ schema_version: 1, theme: 'dark' });
    const r = readPrefs(old);
    expect(r.prefs.aiDisclaimerSeen).toBeUndefined();
    expect(r.writable).toBe(true);
    expect(serializePrefs(r.prefs)).not.toContain('ai_disclaimer_seen');
    for (const v of ['yes', 1, null, false]) {
      const x = readPrefs(
        JSON.stringify({ schema_version: 1, theme: 'dark', ai_disclaimer_seen: v }),
      );
      expect(x.prefs.aiDisclaimerSeen).toBeUndefined();
    }
    const seen = serializePrefs({ ...r.prefs, aiDisclaimerSeen: true });
    expect(JSON.parse(seen).ai_disclaimer_seen).toBe(true);
    expect(JSON.parse(seen).schema_version).toBe(PREFS_SCHEMA_VERSION);
    expect(readPrefs(seen).prefs.aiDisclaimerSeen).toBe(true);
    expect(readPrefs(seen).prefs.theme).toBe('dark');
  });
});

/** #205: テクニカル指標の期間（端末の設定。版は 1 のまま、既定と違う項目だけ書く） */
describe('テクニカル指標の期間（#205）', () => {
  const T = { ...DEFAULT_TECH_PARAMS };
  const custom = {
    rsi: 9,
    macdFast: 8,
    macdSlow: 21,
    macdSignal: 5,
    stochK: 9,
    stochSmooth: 1,
    stochD: 4,
    emaShort: 8,
    emaMid: 21,
    emaLong: 55,
  };

  it('移行: キーの無い古い設定（#205 より前）→ 持たない = 既定。書き出しにもキーが出ない', () => {
    const read = readPrefs(`{"schema_version":1,"theme":"dark",${M0_JSON}}`);
    expect(read.writable).toBe(true);
    expect(read.prefs.technicals).toBeUndefined();
    expect(techParamsOfPrefs(read.prefs)).toEqual(T);
    expect(serializePrefs(read.prefs)).not.toContain('tech_');
    expect(techParamsOfPrefs(DEFAULT_PREFS)).toEqual(T);
  });

  it('往復: 既定と違う項目だけ tech_* に書き、読むと同じ値。版は 1', () => {
    const text = serializePrefs({ theme: 'auto', margin: M0, technicals: custom });
    const o = JSON.parse(text);
    expect(o.schema_version).toBe(PREFS_SCHEMA_VERSION);
    expect(PREFS_SCHEMA_VERSION).toBe(1);
    expect(o).toMatchObject({
      tech_rsi: 9,
      tech_macd_fast: 8,
      tech_macd_slow: 21,
      tech_macd_signal: 5,
      tech_stoch_k: 9,
      tech_stoch_slowing: 1,
      tech_stoch_d: 4,
      tech_ema_short: 8,
      tech_ema_mid: 21,
      tech_ema_long: 55,
    });
    expect(readPrefs(text).prefs.technicals).toEqual(custom);
    // 1 つだけ変えた → そのキーだけ
    const one = JSON.parse(
      serializePrefs({ theme: 'auto', margin: M0, technicals: { ...T, rsi: 21 } }),
    );
    expect(Object.keys(one).filter((k) => k.startsWith('tech_'))).toEqual(['tech_rsi']);
    expect(techParamsOfPrefs(readPrefs(JSON.stringify(one)).prefs)).toEqual({ ...T, rsi: 21 });
    // 既定どおり → キーなし
    expect(serializePrefs({ theme: 'auto', margin: M0, technicals: T })).not.toContain('tech_');
  });

  it('不正な項目はその項目だけ既定。MACD の短期 ≥ 長期は MACD の 3 つを既定', () => {
    const r = readPrefs(
      '{"schema_version":1,"theme":"auto","tech_rsi":1,"tech_stoch_k":"9","tech_stoch_d":4.5,"tech_stoch_slowing":2}',
    );
    expect(r.prefs.technicals).toEqual({ ...T, stochSmooth: 2 });
    const m = readPrefs(
      '{"schema_version":1,"theme":"auto","tech_macd_fast":30,"tech_macd_slow":20,"tech_macd_signal":7,"tech_rsi":9}',
    );
    expect(m.prefs.technicals).toEqual({ ...T, rsi: 9 });
    // 書き出し: 組が不正なら書かない（= 既定）
    const bad = { ...T, macdFast: 40 };
    expect(serializePrefs({ theme: 'auto', margin: M0, technicals: bad })).not.toContain('tech_');
    expect(techParamsOr(bad)).toEqual(T);
  });

  it('#206 EMA: #205 の保存（EMA のキーなし）→ EMA は既定 5・25・75、他の期間はそのまま', () => {
    const r = readPrefs('{"schema_version":1,"theme":"auto","tech_rsi":9}');
    expect(r.prefs.technicals).toEqual({ ...T, rsi: 9, emaShort: 5, emaMid: 25, emaLong: 75 });
    // EMA だけを変えた → EMA のキーだけ
    const one = JSON.parse(
      serializePrefs({ theme: 'auto', margin: M0, technicals: { ...T, emaLong: 100 } }),
    );
    expect(Object.keys(one).filter((k) => k.startsWith('tech_'))).toEqual(['tech_ema_long']);
  });

  it('#206 EMA: 短期 < 中期 < 長期でない → EMA の 3 つを既定（他の項目は残す）。範囲外はその項目だけ既定', () => {
    const r = readPrefs(
      '{"schema_version":1,"theme":"auto","tech_ema_short":30,"tech_ema_mid":20,"tech_ema_long":60,"tech_rsi":9}',
    );
    expect(r.prefs.technicals).toEqual({ ...T, rsi: 9 });
    // 長期 101 は範囲外 → 長期だけ既定（75）。8 < 21 < 75 なので短期・中期は残る
    const r2 = readPrefs(
      '{"schema_version":1,"theme":"auto","tech_ema_short":8,"tech_ema_mid":21,"tech_ema_long":101}',
    );
    expect(r2.prefs.technicals).toEqual({ ...T, emaShort: 8, emaMid: 21 });
    // 長期の既定 75 より中期が大きい組で長期が範囲外 → 順序が崩れるので EMA の 3 つを既定
    const r3 = readPrefs(
      '{"schema_version":1,"theme":"auto","tech_ema_short":8,"tech_ema_mid":80,"tech_ema_long":0}',
    );
    expect(r3.prefs.technicals).toEqual(T);
  });
});

describe('#207 先物推移の指標の段の高さ（fut_pane_h_*）', () => {
  it('移行: キーの無い古い設定 → 持たない = 既定。書き出しにもキーが出ない', () => {
    const read = readPrefs(`{"schema_version":1,"theme":"dark",${M0_JSON}}`);
    expect(read.writable).toBe(true);
    expect(read.prefs.futPaneH).toBeUndefined();
    expect(serializePrefs(read.prefs)).not.toContain('fut_pane_h');
  });
  it('往復: 覚えた段だけ書き、読むと同じ値。版は 1 のまま', () => {
    const text = serializePrefs({ theme: 'auto', margin: M0, futPaneH: { rsi: 90, stoch: 40 } });
    const o = JSON.parse(text);
    expect(o.schema_version).toBe(PREFS_SCHEMA_VERSION);
    expect(o.fut_pane_h_rsi).toBe(90);
    expect(o.fut_pane_h_stoch).toBe(40);
    expect('fut_pane_h_macd' in o).toBe(false);
    expect(readPrefs(text).prefs.futPaneH).toEqual({ rsi: 90, stoch: 40 });
  });
  it('不正（範囲外・小数・文字列）は段ごとに既定（読まない・書かない）。ほかの設定は残る', () => {
    const read = readPrefs(
      `{"schema_version":1,"theme":"light",${M0_JSON},"fut_pane_h_rsi":23,"fut_pane_h_macd":70.5,"fut_pane_h_stoch":"80"}`,
    );
    expect(read.prefs.theme).toBe('light');
    expect(read.prefs.futPaneH).toBeUndefined();
    const mixed = readPrefs(
      `{"schema_version":1,"theme":"dark",${M0_JSON},"fut_pane_h_rsi":2001,"fut_pane_h_macd":120}`,
    );
    expect(mixed.prefs.futPaneH).toEqual({ macd: 120 });
    const out = JSON.parse(
      serializePrefs({ theme: 'dark', margin: M0, futPaneH: { rsi: Number.NaN, macd: 28 } }),
    );
    expect(out.fut_pane_h_macd).toBe(28);
    expect('fut_pane_h_rsi' in out).toBe(false);
  });
});

describe('#214 テクニカルの線の太さ（tech_ema_width_px・tech_pane_width_px）', () => {
  it('移行: キーの無い古い設定 → 持たない = 既定。書き出しにもキーが出ない', () => {
    const read = readPrefs(`{"schema_version":1,"theme":"dark",${M0_JSON},"tech_rsi":10}`);
    expect(read.writable).toBe(true);
    expect(read.prefs.techLineWidths).toBeUndefined();
    expect(techParamsOfPrefs(read.prefs).rsi).toBe(10);
    expect(serializePrefs(read.prefs)).not.toContain('width');
  });
  it('往復: 既定と違う項目だけ px で書き、読むと同じ値。既定の項目は書かない。版は 1 のまま', () => {
    const text = serializePrefs({
      theme: 'auto',
      margin: M0,
      techLineWidths: { ema: 2, pane: 1.25 },
    });
    const o = JSON.parse(text);
    expect(o.schema_version).toBe(PREFS_SCHEMA_VERSION);
    expect(o.tech_ema_width_px).toBe(2);
    expect('tech_pane_width_px' in o).toBe(false);
    expect(readPrefs(text).prefs.techLineWidths).toEqual({ ema: 2 });
    const both = serializePrefs({
      theme: 'auto',
      margin: M0,
      techLineWidths: { ema: 1.5, pane: 3 },
    });
    expect(readPrefs(both).prefs.techLineWidths).toEqual({ ema: 1.5, pane: 3 });
    const def = serializePrefs({
      theme: 'auto',
      margin: M0,
      techLineWidths: { ema: 1, pane: 1.25 },
    });
    expect(def).not.toContain('width');
  });
  it('作業中の版の段のキー（tech_line_width）は px に読み替え、書き出しは px のキーだけ', () => {
    const thin = readPrefs(`{"schema_version":1,"theme":"auto","tech_line_width":"thin"}`).prefs;
    expect(thin.techLineWidths).toEqual({ pane: 1 });
    const thick = readPrefs(`{"schema_version":1,"theme":"auto","tech_line_width":"thick"}`).prefs;
    expect(thick.techLineWidths).toEqual({ ema: 2, pane: 2 });
    const out = JSON.parse(serializePrefs(thick));
    expect(out.tech_ema_width_px).toBe(2);
    expect(out.tech_pane_width_px).toBe(2);
    expect('tech_line_width' in out).toBe(false);
    const normal = readPrefs(
      `{"schema_version":1,"theme":"auto","tech_line_width":"normal"}`,
    ).prefs;
    expect(normal.techLineWidths).toBeUndefined();
    // px のキーがあれば段のキーは読まない
    const mixed = readPrefs(
      `{"schema_version":1,"theme":"auto","tech_line_width":"thick","tech_pane_width_px":3}`,
    ).prefs;
    expect(mixed.techLineWidths).toEqual({ pane: 3 });
  });
  it('不正（選択肢に無い数・文字・null）→ 項目ごとに既定。ほかの設定（期間・段の高さ・証拠金）は残る', () => {
    for (const bad of ['0.75', '"2"', 'null', '4', '"thick"']) {
      const read = readPrefs(
        `{"schema_version":1,"theme":"light","capital_yen":3000000,"tech_ema_mid":30,"fut_pane_h_rsi":90,"tech_ema_width_px":${bad},"tech_pane_width_px":2}`,
      );
      expect(read.prefs.techLineWidths).toEqual({ pane: 2 });
      expect(read.prefs.theme).toBe('light');
      expect(read.prefs.margin.capitalYen).toBe(3000000);
      expect(techParamsOfPrefs(read.prefs).emaMid).toBe(30);
      expect(read.prefs.futPaneH).toEqual({ rsi: 90 });
    }
    const out = serializePrefs({
      theme: 'dark',
      margin: M0,
      techLineWidths: { ema: 0.5, pane: 7 },
    });
    expect(out).not.toContain('width');
  });
});

describe('AI に渡す自分の前提（#156 AC1）', () => {
  const base = { schema_version: 1, theme: 'auto' };
  it('書いて読める（入れた文字列のまま）・未設定ならキーを書かない', () => {
    const text = '資金 500 万円。\n深い OTM の売りが基本。';
    const s = serializePrefs({ ...DEFAULT_PREFS, aiProfile: text });
    expect(JSON.parse(s).ai_profile).toBe(text);
    expect(readPrefs(s).prefs.aiProfile).toBe(text);
    expect(JSON.parse(serializePrefs(DEFAULT_PREFS))).not.toHaveProperty('ai_profile');
    expect(readPrefs(JSON.stringify(base)).prefs.aiProfile).toBeUndefined();
  });
  it('不正（文字列でない・空白だけ・上限を超える）→ 無し。ほかの設定はそのまま', () => {
    for (const v of [42, null, '  ', 'あ'.repeat(AI_PROFILE_MAX + 1)]) {
      const r = readPrefs(JSON.stringify({ ...base, theme: 'dark', ai_profile: v }));
      expect(r.prefs.aiProfile).toBeUndefined();
      expect(r.prefs.theme).toBe('dark');
      expect(r.writable).toBe(true);
    }
    expect(
      readPrefs(JSON.stringify({ ...base, ai_profile: 'あ'.repeat(AI_PROFILE_MAX) })).prefs
        .aiProfile,
    ).toHaveLength(AI_PROFILE_MAX);
    expect(
      JSON.parse(serializePrefs({ ...DEFAULT_PREFS, aiProfile: 'あ'.repeat(AI_PROFILE_MAX + 1) })),
    ).not.toHaveProperty('ai_profile');
  });
  it('isAiProfile', () => {
    expect(isAiProfile('a')).toBe(true);
    expect(isAiProfile(' ')).toBe(false);
    expect(isAiProfile(1)).toBe(false);
  });
});

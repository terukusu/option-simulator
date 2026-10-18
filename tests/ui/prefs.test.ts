import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARGIN_PREFS,
  DEFAULT_PREFS,
  type MarginPrefs,
  PREFS_KEY,
  PREFS_SCHEMA_VERSION,
  readPrefs,
  resolveTheme,
  serializePrefs,
  type ThemePref,
} from '../../ui/prefs';

/** #81: 端末の設定（option-simulator.prefs。版 1: テーマ + #131 の証拠金）。作業の保存とは別のキー。 */
const M0 = DEFAULT_MARGIN_PREFS;
const DEF = { theme: 'auto', margin: M0 };
/** 証拠金の既定のキー（書き出しの末尾） */
const M0_JSON =
  '"margin_factor_pct":120,"margin_range_pct":8,"margin_iv_up_pt":8,"margin_iv_down_pt":4,"margin_ignore_long_options":true';

describe('readPrefs', () => {
  it('キーと版', () => {
    expect(PREFS_KEY).toBe('option-simulator.prefs');
    expect(PREFS_SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_PREFS).toEqual(DEF);
    expect(M0).toEqual({
      capitalYen: null,
      factorPct: 120,
      rangePct: 8,
      ivUpPt: 8,
      ivDownPt: 4,
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
    factorPct: 150,
    rangePct: 10.5,
    ivUpPt: 12,
    ivDownPt: 0,
    ignoreLongOptions: false,
  };

  it('往復: 書き出し → 読み取りで同じ値（JSON のキーは capital_yen・margin_*）', () => {
    const text = serializePrefs({ theme: 'dark', margin: custom });
    expect(JSON.parse(text)).toEqual({
      schema_version: 1,
      theme: 'dark',
      capital_yen: 12_345_678,
      margin_factor_pct: 150,
      margin_range_pct: 10.5,
      margin_iv_up_pt: 12,
      margin_iv_down_pt: 0,
      margin_ignore_long_options: false,
    });
    expect(readPrefs(text)).toEqual({ prefs: { theme: 'dark', margin: custom }, writable: true });
    // 範囲の両端
    const ends: MarginPrefs = {
      capitalYen: 1e12,
      factorPct: 50,
      rangePct: 30,
      ivUpPt: 50,
      ivDownPt: 30,
      ignoreLongOptions: true,
    };
    expect(readPrefs(serializePrefs({ theme: 'auto', margin: ends })).prefs.margin).toEqual(ends);
    const lows: MarginPrefs = {
      capitalYen: 1,
      factorPct: 300,
      rangePct: 1,
      ivUpPt: 0,
      ivDownPt: 0,
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
      ['margin_factor_pct', 49],
      ['margin_factor_pct', 301],
      ['margin_factor_pct', '120'],
      ['margin_range_pct', 0],
      ['margin_range_pct', -8],
      ['margin_range_pct', 31],
      ['margin_iv_up_pt', -1],
      ['margin_iv_up_pt', 51],
      ['margin_iv_up_pt', true],
      ['margin_iv_down_pt', -0.5],
      ['margin_iv_down_pt', 31],
      ['margin_iv_down_pt', [4]],
    ];
    const keyOf: Record<string, keyof MarginPrefs> = {
      capital_yen: 'capitalYen',
      margin_factor_pct: 'factorPct',
      margin_range_pct: 'rangePct',
      margin_iv_up_pt: 'ivUpPt',
      margin_iv_down_pt: 'ivDownPt',
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
        factorPct: Number.NaN,
        rangePct: Infinity,
        ivUpPt: -1,
        ivDownPt: 99,
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

describe('#149 買いの OP の設定', () => {
  it('#149 買いの OP の設定: 無い・不正 → 既定（オン）、オフを往復、版は 1', () => {
    const custom: MarginPrefs = {
      capitalYen: 5_000_000,
      factorPct: 150,
      rangePct: 10,
      ivUpPt: 12,
      ivDownPt: 2,
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

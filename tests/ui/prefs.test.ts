import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  PREFS_KEY,
  PREFS_SCHEMA_VERSION,
  readPrefs,
  resolveTheme,
  serializePrefs,
  type ThemePref,
} from '../../ui/prefs';

/** #81: 端末の設定（option-simulator.prefs。版 1: テーマだけ）。作業の保存とは別のキー。 */
describe('readPrefs', () => {
  it('キーと版', () => {
    expect(PREFS_KEY).toBe('option-simulator.prefs');
    expect(PREFS_SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_PREFS).toEqual({ theme: 'auto' });
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
      expect(readPrefs(text), String(text)).toEqual({ prefs: { theme: 'auto' }, writable: true });
    }
  });

  it('新しい版（> 1）→ 既定を返し、書いてはいけない（このセッションでは書かない）', () => {
    expect(readPrefs('{"schema_version":2,"theme":"light"}')).toEqual({
      prefs: { theme: 'auto' },
      writable: false,
    });
    expect(readPrefs('{"schema_version":99}')).toEqual({
      prefs: { theme: 'auto' },
      writable: false,
    });
  });

  it('書き出し → 読み取りで同じ値（往復）', () => {
    for (const theme of ['auto', 'dark', 'light'] as const satisfies readonly ThemePref[]) {
      const text = serializePrefs({ theme });
      expect(text).toBe(`{"schema_version":1,"theme":"${theme}"}`);
      expect(readPrefs(text)).toEqual({ prefs: { theme }, writable: true });
    }
  });

  it('余計なキーは読み取りでも書き出しでも写さない', () => {
    const read = readPrefs('{"schema_version":1,"theme":"dark","extra":"x"}');
    expect(read).toEqual({ prefs: { theme: 'dark' }, writable: true });
    const loose = { theme: 'light', extra: 1 } as unknown as { theme: ThemePref };
    expect(serializePrefs(loose)).toBe('{"schema_version":1,"theme":"light"}');
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

import { describe, expect, it } from 'vitest';
import { ChainLoadError } from '../../data';
import { describeLoadError, initialSource, loaderNote, MAX_ERROR_LINES } from '../../ui/load';

/** #34 AC-1: 最初に読むデータ元。 */
describe('initialSource', () => {
  it('dev は合成の latest、本番は API（bigquery）', () => {
    expect(initialSource(true)).toEqual({ kind: 'fixture', name: 'latest' });
    expect(initialSource(false)).toEqual({ kind: 'api' });
  });
});

/** #34 AC-3: 失敗の文言は種別ごと。応答の本文は含めない（ChainLoadError は本文を持たない）。 */
describe('describeLoadError', () => {
  const SECRET = /secret/;

  it('503 / その他の HTTP / ログイン切れ / 通信エラー / 検証エラーで別の文言', () => {
    const v503 = describeLoadError(
      new ChainLoadError('板を読めない（api: HTTP 503）', [], { kind: 'http', status: 503 }),
    );
    const v500 = describeLoadError(
      new ChainLoadError('板を読めない（api: HTTP 500）', [], { kind: 'http', status: 500 }),
    );
    const auth = describeLoadError(
      new ChainLoadError('ログインが切れた（api）', [], { kind: 'auth', status: 401 }),
    );
    const net = describeLoadError(
      new ChainLoadError('板を読めない（api: 通信エラー）', [], { kind: 'network' }),
    );
    const bad = describeLoadError(new ChainLoadError('板の JSON が不正（api）', ['$.x: 必須']));

    expect(v503.message).toMatch(/API が板を返せない/);
    expect(v503.message).toMatch(/HTTP 503/);
    expect(v500.message).toBe('板を読めない（HTTP 500）');
    expect(auth.message).toMatch(/ログインが切れた/);
    expect(auth.message).toMatch(/読み直/);
    expect(net.message).toBe('板を読めない（通信エラー）');
    expect(bad).toEqual({ message: '板の JSON が不正（api）', errors: ['$.x: 必須'] });

    const messages = [v503, v500, auth, net, bad].map((v) => v.message);
    expect(new Set(messages).size).toBe(messages.length);
    for (const v of [v503, v500, auth, net]) expect(v.errors).toEqual([]);
    for (const m of messages) expect(m).not.toMatch(SECRET);
  });

  it('検証エラーの明細は最大 MAX_ERROR_LINES 件', () => {
    const errs = Array.from({ length: MAX_ERROR_LINES + 5 }, (_, i) => `$.months[${i}]: 不正`);
    const v = describeLoadError(new ChainLoadError('板の JSON が不正（api）', errs));
    expect(v.errors).toHaveLength(MAX_ERROR_LINES + 1);
    expect(v.errors.at(-1)).toBe('ほか 5 件');
  });

  it('ChainLoadError 以外は固定の文言（例外の本文を出さない）', () => {
    const v = describeLoadError(new Error('secret stack'));
    expect(v.message).toBe('板を読めない（JSON として読めないか、正規化に失敗）');
    expect(v.message).not.toMatch(SECRET);
    expect(v.errors).toEqual([]);
  });
});

/** #48 AC-1: 読み込みの行の文言（読んだファイル名は「表示中」に出す）。 */
describe('loaderNote', () => {
  it('読み込み中 > データ元あり > なし', () => {
    expect(loaderNote(true, 'board.json')).toBe('読み込み中…');
    expect(loaderNote(false, 'board.json')).toBe('表示中: board.json');
    expect(loaderNote(false, 'API')).toBe('表示中: API');
    expect(loaderNote(false, null)).toBe('');
    expect(loaderNote(false, '')).toBe('');
  });
});

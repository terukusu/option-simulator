import { describe, expect, it } from 'vitest';
import { type EncodedImage, type EncodeResult, latestPicker } from '../../ui/imageEncode';

/**
 * #318 レビュー S2: 画像の選択は最後に選んだものだけを採る（世代番号）。古い作り直しの結果は捨てて dispose、
 * 作り直しの例外は not_image（「作り直し中」で固まらない）。ui/imageEncode.ts の latestPicker（DOM は使わない偽の encode）
 */

const img = (name: string) => ({ base64: name }) as unknown as EncodedImage;

function deferred() {
  let resolve!: (r: EncodeResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<EncodeResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('latestPicker', () => {
  it('先に選んだ画像が後で終わっても、最後に選んだ画像だけを採り、古い方は dispose する', async () => {
    const a = deferred();
    const b = deferred();
    const queue = [a, b];
    const disposed: string[] = [];
    const picker = latestPicker(
      () => (queue.shift() as ReturnType<typeof deferred>).promise,
      (i) => disposed.push(i.base64),
    );
    const pa = picker.pick(new Blob(['a']));
    const pb = picker.pick(new Blob(['b']));
    b.resolve({ ok: true, image: img('B') });
    a.resolve({ ok: true, image: img('A') });
    expect(await pb).toEqual({ kind: 'ok', image: img('B') });
    expect(await pa).toEqual({ kind: 'stale' });
    expect(disposed).toEqual(['A']);
  });

  it('作り直しの例外は not_image（reject にしない）', async () => {
    const picker = latestPicker(async () => {
      throw new Error('decode failed');
    });
    expect(await picker.pick(new Blob(['x']))).toEqual({ kind: 'error', error: 'not_image' });
  });

  it('失敗の種類はそのまま（too_large・huge）', async () => {
    const picker = latestPicker(async () => ({ ok: false, error: 'huge' }));
    expect(await picker.pick(new Blob(['x']))).toEqual({ kind: 'error', error: 'huge' });
  });

  it('cancel（ダイアログを閉じた）の後に終わった結果は捨てて dispose する', async () => {
    const d = deferred();
    const disposed: string[] = [];
    const picker = latestPicker(
      () => d.promise,
      (i) => disposed.push(i.base64),
    );
    const p = picker.pick(new Blob(['x']));
    picker.cancel();
    d.resolve({ ok: true, image: img('X') });
    expect(await p).toEqual({ kind: 'stale' });
    expect(disposed).toEqual(['X']);
  });
});

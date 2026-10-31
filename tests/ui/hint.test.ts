import { describe, expect, it } from 'vitest';
import { hintAbove, hintAlign, hintNext, revealDelta } from '../../ui/view/hint';

/** #63: 説明の吹き出し（ⓘ）の開閉と寄せ。 */
describe('hintNext（開閉）', () => {
  it('toggle で開く・もう一度で閉じる', () => {
    expect(hintNext(false, 'toggle')).toBe(true);
    expect(hintNext(true, 'toggle')).toBe(false);
  });

  it('外側のタップ・Esc で閉じる（閉じているときは閉じたまま）', () => {
    expect(hintNext(true, 'outside')).toBe(false);
    expect(hintNext(true, 'escape')).toBe(false);
    expect(hintNext(false, 'outside')).toBe(false);
    expect(hintNext(false, 'escape')).toBe(false);
  });

  it('ほかの出来事（他の ⓘ が開いた）で閉じる', () => {
    expect(hintNext(true, 'other')).toBe(false);
    expect(hintNext(false, 'other')).toBe(false);
  });
});

describe('hintAlign（左右の寄せ）', () => {
  it('ボタンの中心が行の左半分なら start、右半分なら end', () => {
    expect(hintAlign(20, 0, 360)).toBe('start');
    expect(hintAlign(179, 0, 360)).toBe('start');
    expect(hintAlign(181, 0, 360)).toBe('end');
    expect(hintAlign(350, 0, 360)).toBe('end');
  });

  it('行が画面の途中から始まっても行の中で判定する', () => {
    expect(hintAlign(900, 800, 1200)).toBe('start');
    expect(hintAlign(1100, 800, 1200)).toBe('end');
  });

  it('幅 0 の行（測れない）は start', () => {
    expect(hintAlign(10, 0, 0)).toBe('start');
  });
});

/** #107: 開いた全文のポップオーバーをスクロールする祖先（.panel-body）の中で見せる量。 */
describe('revealDelta（祖先の scrollTop の増分）', () => {
  it('入っていれば 0', () => {
    expect(revealDelta(120, 300, 100, 500)).toBe(0);
    expect(revealDelta(120, 500, 100, 500)).toBe(0);
  });

  it('下にはみ出す量だけ正', () => {
    expect(revealDelta(300, 560, 100, 500)).toBe(60);
  });

  it('上端を越えて動かさない（host の高さが足りないときは上端を揃える）', () => {
    expect(revealDelta(150, 700, 100, 400)).toBe(50);
    expect(revealDelta(100, 700, 100, 400)).toBe(0);
  });

  it('負にならない・NaN は 0', () => {
    expect(revealDelta(50, 700, 100, 400)).toBe(0);
    expect(revealDelta(Number.NaN, 700, 100, 400)).toBe(0);
    expect(revealDelta(150, Number.NaN, 100, 400)).toBe(0);
    expect(revealDelta(150, 700, 100, Number.NaN)).toBe(0);
  });
});

/** #320 第 2 弾: 窓の下端で切れる吹き出しはボタンの上に開く */
describe('hintAbove（上に開くか）', () => {
  it('下に入れば下のまま', () => {
    // ボタン 700〜718・すき間 4・高さ 150 → 下は 722〜872
    expect(hintAbove(700, 718, 4, 150, 0, 900)).toBe(false);
    expect(hintAbove(700, 718, 4, 178, 0, 900)).toBe(false);
  });

  it('下で切れ、上に入れば上', () => {
    // ボタン 705〜723・すき間 4・高さ 413 → 下は 727〜1140（切れる）、上は 288〜701
    expect(hintAbove(705, 723, 4, 413, 0, 900)).toBe(true);
  });

  it('境目: 上の余地がちょうど高さ + すき間なら上（ボタンの高さを余地から引かない）', () => {
    // 窓 800・ボタン 417〜435・すき間 4・高さ 413 → 下は 852 まで（切れる）、上は 0〜413 でちょうど入る
    // （ボタンの高さ 18 を余地から引くと 18px 足りないと見誤る）
    expect(hintAbove(417, 435, 4, 413, 0, 800)).toBe(true);
    // 1px 足りなければ下のまま
    expect(hintAbove(416, 434, 4, 413, 0, 800)).toBe(false);
  });

  it('上にも入らなければ下のまま（今までどおり）', () => {
    expect(hintAbove(200, 218, 4, 913, 0, 900)).toBe(false);
  });

  it('不正な値は下のまま', () => {
    expect(hintAbove(Number.NaN, 718, 4, 413, 0, 900)).toBe(false);
    expect(hintAbove(705, 723, 4, 0, 0, 900)).toBe(false);
  });
});

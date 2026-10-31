import { describe, expect, it } from 'vitest';
import {
  BACK_INITIAL,
  type BackEffect,
  type BackEvent,
  type BackState,
  BOARD_PICK_LAYER,
  backReduce,
  backTarget,
  backTop,
} from '../../ui/view/backStack';

/**
 * #320 第 1 弾: 戻る（スマホの戻るジェスチャー・ブラウザの戻る）で開いているものを一番上から 1 つ閉じる純関数。
 * 糊（ui/next/backStack.ts）は効果（push / go / close）を history と各層の閉じ方へ流すだけ。
 */

/** 出来事を順に流し、最後の状態と効果の全部を返す */
function run(
  events: readonly BackEvent[],
  from: BackState = BACK_INITIAL,
): { state: BackState; effects: BackEffect[] } {
  let state = from;
  const effects: BackEffect[] = [];
  for (const e of events) {
    const r = backReduce(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const open = (id: string, activation = true): BackEvent => ({ type: 'open', id, activation });
const close = (id: string): BackEvent => ({ type: 'close', id });
const settle: BackEvent = { type: 'settle' };
const pop = (back: number): BackEvent => ({ type: 'popstate', back });

/** 1 つ開いて落ち着いた状態 */
const oneOpen = run([open('a'), settle]).state;

describe('backReduce', () => {
  it('(a) 利用者の操作の中で開く → push が 1 回、back = 深さ', () => {
    const r = run([open('a'), settle]);
    expect(r.effects).toEqual([{ kind: 'push', back: 1 }]);
    expect(r.state.hist).toBe(1);
    const r2 = run([open('b'), settle], r.state);
    expect(r2.effects).toEqual([{ kind: 'push', back: 2 }]);
    expect(r2.state.hist).toBe(2);
    expect(backTop(r2.state)).toBe('b');
  });

  it('(a) 開いただけでは効果なし（後始末を待つ）', () => {
    expect(backReduce(BACK_INITIAL, open('a')).effects).toEqual([]);
  });

  it('(b) popstate(深さ − 1) → 一番上の層だけ閉じる（go しない）', () => {
    const two = run([open('a'), open('b'), settle]).state;
    const r = backReduce(two, pop(1));
    expect(r.effects).toEqual([{ kind: 'close', ids: ['b'] }]);
    expect(r.state.hist).toBe(1);
    expect(backTop(r.state)).toBe('a');
    // 部品が閉じて close を送っても、層は既に無いので何もしない（二重に戻らない）
    const r2 = run([close('b'), settle], r.state);
    expect(r2.effects).toEqual([]);
  });

  it('(c) UI で閉じる → 後始末で go(−1)、その go の popstate は何も閉じない', () => {
    const r = run([close('a'), settle], oneOpen);
    expect(r.effects).toEqual([{ kind: 'go', n: -1 }]);
    expect(r.state.awaiting).toBe(0);
    const r2 = backReduce(r.state, pop(0));
    expect(r2.effects).toEqual([]);
    expect(r2.state).toEqual({ layers: [], hist: 0, awaiting: null });
  });

  it('(d) 同じ tick の「閉じて開く」（吹き出し A → 吹き出し B）→ 効果なし（深さ同じ）', () => {
    const r = run([close('a'), open('b'), settle], oneOpen);
    expect(r.effects).toEqual([]);
    expect(r.state.hist).toBe(1);
    expect(backTop(r.state)).toBe('b');
    // その後の戻るは B を閉じる
    expect(backReduce(r.state, pop(0)).effects).toEqual([{ kind: 'close', ids: ['b'] }]);
  });

  it('(e) 後始末の go(−1) が終わる前に別の層が開く → push は popstate の後、新しい層を閉じない', () => {
    // パレットを閉じた後始末が先に走り、その後でダイアログが開く
    const r = run([close('a'), settle, open('dlg'), settle], oneOpen);
    expect(r.effects).toEqual([{ kind: 'go', n: -1 }]);
    // go の popstate が来て、保留していた push を出す。何も閉じない
    const r2 = backReduce(r.state, pop(0));
    expect(r2.effects).toEqual([{ kind: 'push', back: 1 }]);
    expect(r2.state.hist).toBe(1);
    expect(backTop(r2.state)).toBe('dlg');
  });

  it('(e) 閉じると開くが同じ後始末に入れば差し引き 0（履歴の深さは 1 のまま）', () => {
    const r = run([close('a'), open('dlg'), settle], oneOpen);
    expect(r.effects).toEqual([]);
    expect(r.state.hist).toBe(1);
  });

  it('(f) 2 つ同時に閉じる → go(−2)', () => {
    const two = run([open('a'), open('b'), settle]).state;
    const r = run([close('b'), close('a'), settle], two);
    expect(r.effects).toEqual([{ kind: 'go', n: -2 }]);
    expect(backReduce(r.state, pop(0)).effects).toEqual([]);
  });

  it('(g) 進む（back = 深さ + 1）→ go(−1)、何も開かない', () => {
    const r = backReduce(BACK_INITIAL, pop(1));
    expect(r.effects).toEqual([{ kind: 'go', n: -1 }]);
    expect(r.state.layers).toEqual([]);
    const r2 = backReduce(r.state, pop(0));
    expect(r2.effects).toEqual([]);
    expect(r2.state).toEqual(BACK_INITIAL);
  });

  it('(h) 再読み込みの後の古い項目（スタックは空、back > 0）→ 戻す方向の効果だけで何も開かない', () => {
    for (const back of [1, 2, 3]) {
      const r = backReduce(BACK_INITIAL, pop(back));
      expect(r.effects).toEqual([{ kind: 'go', n: -back }]);
      expect(r.state.layers).toEqual([]);
      expect(r.state.hist).toBe(0);
    }
    // 空のスタックで back = 0 の項目へ戻っても何もしない
    expect(backReduce(BACK_INITIAL, pop(0)).effects).toEqual([]);
  });

  it('(i) 操作なしで開く層 → push しない・閉じても go しない', () => {
    const r = run([open('confirm', false), settle]);
    expect(r.effects).toEqual([]);
    expect(r.state.hist).toBe(0);
    const r2 = run([close('confirm'), settle], r.state);
    expect(r2.effects).toEqual([]);
  });

  it('(j) pushState の失敗 → その層は積まない層に落ち、閉じても go しない', () => {
    const r = run([open('a'), settle]);
    expect(r.effects).toEqual([{ kind: 'push', back: 1 }]);
    const failed = backReduce(r.state, { type: 'pushFailed', back: 1 });
    expect(failed.effects).toEqual([]);
    expect(failed.state.hist).toBe(0);
    expect(backTarget(failed.state)).toBe(0);
    const r2 = run([close('a'), settle], failed.state);
    expect(r2.effects).toEqual([]);
  });

  it('(j) 2 段目の push が失敗 → 1 段目はそのまま、2 段目から上を積まない層に', () => {
    const r = run([open('a'), open('b'), open('c'), settle]);
    expect(r.effects).toEqual([
      { kind: 'push', back: 1 },
      { kind: 'push', back: 2 },
      { kind: 'push', back: 3 },
    ]);
    const failed = backReduce(r.state, { type: 'pushFailed', back: 2 });
    expect(failed.state.hist).toBe(1);
    expect(failed.state.layers.map((l) => l.entry)).toEqual([true, false, false]);
    expect(run([settle], failed.state).effects).toEqual([]);
  });

  it('(k) popstate が来ないときは unstick で保留していた push を出す', () => {
    const r = run([close('a'), settle, open('b'), settle], oneOpen);
    expect(r.state.awaiting).toBe(0);
    const r2 = backReduce(r.state, { type: 'unstick' });
    expect(r2.effects).toEqual([{ kind: 'push', back: 1 }]);
    expect(r2.state.awaiting).toBeNull();
  });

  it('(l) entry の層の上の積まない層は、戻る 1 回で一緒に閉じる', () => {
    const r = run([open('a'), settle, open('x', false), settle]);
    expect(r.effects).toEqual([{ kind: 'push', back: 1 }]);
    const r2 = backReduce(r.state, pop(0));
    expect(r2.effects).toEqual([{ kind: 'close', ids: ['x', 'a'] }]);
    expect(r2.state.layers).toEqual([]);
  });

  it('保留中は後始末を何度しても効果なし。保留と違う popstate は利用者の戻るとして扱う', () => {
    const two = run([open('a'), open('b'), settle]).state;
    const r = run([close('b'), settle, settle], two);
    expect(r.effects).toEqual([{ kind: 'go', n: -1 }]);
    expect(r.state.awaiting).toBe(1);
    // go の結果より先に利用者がもう 1 つ戻った（back = 0）→ a を閉じる
    const r2 = backReduce(r.state, pop(0));
    expect(r2.effects).toEqual([{ kind: 'close', ids: ['a'] }]);
    expect(r2.state.awaiting).toBeNull();
  });

  it('層が開いているときの進む → 層を閉じずに go で戻す', () => {
    const r = backReduce(oneOpen, pop(2));
    expect(r.effects).toEqual([{ kind: 'go', n: -1 }]);
    expect(r.state.layers.map((l) => l.id)).toEqual(['a']);
    expect(r.state.awaiting).toBe(1);
    const r2 = backReduce(r.state, pop(1));
    expect(r2.effects).toEqual([]);
    expect(backTop(r2.state)).toBe('a');
  });

  it('戻る先より層が少なくても、層を全部閉じて hist = 戻った先', () => {
    const s: BackState = { layers: [{ id: 'a', entry: true }], hist: 3, awaiting: null };
    const r = backReduce(s, pop(0));
    expect(r.effects).toEqual([{ kind: 'close', ids: ['a'] }]);
    expect(r.state).toEqual({ layers: [], hist: 0, awaiting: null });
  });

  it('保留していないときの unstick は何もしない', () => {
    const r = backReduce(oneOpen, { type: 'unstick' });
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(oneOpen);
  });

  it('open / close は冪等（同じ出来事の 2 回目は何もしない）', () => {
    const r = run([open('a'), open('a'), settle]);
    expect(r.effects).toEqual([{ kind: 'push', back: 1 }]);
    expect(r.state.layers).toHaveLength(1);
    const r2 = run([close('a'), close('a'), settle], r.state);
    expect(r2.effects).toEqual([{ kind: 'go', n: -1 }]);
    expect(backReduce(BACK_INITIAL, close('zzz')).state).toBe(BACK_INITIAL);
  });

  it('途中の層を閉じても、閉じた層だけ外れる（深さは entry の層の数）', () => {
    const three = run([open('a'), open('b'), open('c'), settle]).state;
    const r = run([close('b'), settle], three);
    expect(r.effects).toEqual([{ kind: 'go', n: -1 }]);
    expect(r.state.layers.map((l) => l.id)).toEqual(['a', 'c']);
    expect(backTop(r.state)).toBe('c');
  });

  it('静かな状態では hist = entry の層の数', () => {
    const seq: BackEvent[] = [
      open('a'),
      settle,
      open('b'),
      open('c', false),
      settle,
      close('b'),
      settle,
      pop(1),
      open('d'),
      settle,
    ];
    let s = BACK_INITIAL;
    for (const e of seq) {
      s = backReduce(s, e).state;
      if (e.type === 'settle' && s.awaiting === null) expect(s.hist).toBe(backTarget(s));
    }
    expect(backTop(s)).toBe('d');
    expect(backTop(BACK_INITIAL)).toBeNull();
  });

  it('#320 第 2 弾 AC-2-2: 説明カードを 3 つ積み、× で全部閉じる → go(−3) が 1 回', () => {
    const three = run([open('term:1'), settle, open('term:2'), settle, open('term:3'), settle]);
    expect(three.state.hist).toBe(3);
    expect(three.effects).toEqual([
      { kind: 'push', back: 1 },
      { kind: 'push', back: 2 },
      { kind: 'push', back: 3 },
    ]);
    const r = run([close('term:3'), close('term:2'), close('term:1'), settle], three.state);
    expect(r.effects).toEqual([{ kind: 'go', n: -3 }]);
    // その go の popstate では何も閉じない
    expect(backReduce(r.state, pop(0)).effects).toEqual([]);
  });

  it('#320 第 2 弾: 吹き出しの上の説明カード 3 つ → 戻る 3 回で用語を 1 つずつ、4 回目で吹き出し', () => {
    let s = run([
      open('overlay:p'),
      settle,
      open('term:1'),
      settle,
      open('term:2'),
      settle,
      open('term:3'),
      settle,
    ]).state;
    const closed: string[] = [];
    for (const back of [3, 2, 1, 0]) {
      const r = backReduce(s, pop(back));
      s = r.state;
      for (const ef of r.effects) if (ef.kind === 'close') closed.push(...ef.ids);
    }
    expect(closed).toEqual(['term:3', 'term:2', 'term:1', 'overlay:p']);
  });

  it('#325 板から追加の層: 開く → 足が入って閉じる → 後始末で go(−1)、その popstate では何も閉じない', () => {
    const opened = run([open(BOARD_PICK_LAYER), settle]);
    expect(opened.effects).toEqual([{ kind: 'push', back: 1 }]);
    const r = run([close(BOARD_PICK_LAYER), settle], opened.state);
    expect(r.effects).toEqual([{ kind: 'go', n: -1 }]);
    const r2 = backReduce(r.state, pop(0));
    expect(r2.effects).toEqual([]);
    expect(r2.state).toEqual({ layers: [], hist: 0, awaiting: null });
  });

  it('#325 板から追加の層: 戻るで閉じる → 帯の閉じ方だけ呼び、その後の close・後始末で push も go も無い', () => {
    const opened = run([open(BOARD_PICK_LAYER), settle]).state;
    const back = backReduce(opened, pop(0));
    expect(back.effects).toEqual([{ kind: 'close', ids: [BOARD_PICK_LAYER] }]);
    // 帯が消えて effect の cleanup が close を送っても、層は既に無い（履歴を積み増さない・戻しすぎない）
    const r = run([close(BOARD_PICK_LAYER), settle], back.state);
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual({ layers: [], hist: 0, awaiting: null });
  });

  it('#325 板から追加の層の上の K の吹き出し → 戻る 1 回目は吹き出し、2 回目で帯', () => {
    let s = run([open(BOARD_PICK_LAYER), settle, open('overlay:k'), settle]).state;
    const closed: string[] = [];
    for (const b of [1, 0]) {
      const r = backReduce(s, pop(b));
      s = r.state;
      for (const ef of r.effects) if (ef.kind === 'close') closed.push(...ef.ids);
    }
    expect(closed).toEqual(['overlay:k', BOARD_PICK_LAYER]);
  });

  it('#325 帯の上の K の吹き出しを開いたまま bid で足が入る → 吹き出しと帯を同じ後始末で閉じて go(−2)、その popstate で何も閉じない', () => {
    const two = run([open(BOARD_PICK_LAYER), settle, open('overlay:k'), settle]);
    expect(two.state.hist).toBe(2);
    // closeOverlay（同期）→ 描画後の cleanup で帯の層
    const r = run([close('overlay:k'), close(BOARD_PICK_LAYER), settle], two.state);
    expect(r.effects).toEqual([{ kind: 'go', n: -2 }]);
    const r2 = backReduce(r.state, pop(0));
    expect(r2.effects).toEqual([]);
    expect(r2.state).toEqual({ layers: [], hist: 0, awaiting: null });
  });

  it('#325 帯の上の K の吹き出しを閉じる後始末と帯を閉じる後始末が分かれても、go(−1) を 2 回で履歴の段が 0 に戻る', () => {
    const two = run([open(BOARD_PICK_LAYER), settle, open('overlay:k'), settle]).state;
    const a = run([close('overlay:k'), settle], two);
    expect(a.effects).toEqual([{ kind: 'go', n: -1 }]);
    // go の popstate を待つ間に帯が閉じる → 後始末は保留、popstate の後に go(−1)
    const b = run([close(BOARD_PICK_LAYER), settle], a.state);
    expect(b.effects).toEqual([]);
    const c = backReduce(b.state, pop(1));
    expect(c.effects).toEqual([{ kind: 'go', n: -1 }]);
    const d = backReduce(c.state, pop(0));
    expect(d.effects).toEqual([]);
    expect(d.state).toEqual({ layers: [], hist: 0, awaiting: null });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #123: ui/next/live.ts の liveHold は pointerup / pointercancel が来なくても、窓の blur・タブが隠れたとき
 * （visibilitychange で hidden）に離す。DOM は EventTarget で模し、rAF は手で進める
 */
type Live = typeof import('../../ui/next/live');

let frames: FrameRequestCallback[] = [];
let win: EventTarget & { setTimeout: typeof setTimeout };
let doc: EventTarget & { visibilityState: DocumentVisibilityState };

/** 溜まった rAF を n フレーム分進める */
function step(n: number) {
  for (let i = 0; i < n; i++) {
    const fs = frames;
    frames = [];
    for (const f of fs) f(0);
  }
}

async function load(): Promise<Live> {
  vi.resetModules();
  return import('../../ui/next/live');
}

beforeEach(() => {
  frames = [];
  win = Object.assign(new EventTarget(), { setTimeout });
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => {
    frames.push(f);
    return frames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('liveHold の解除（#123）', () => {
  it('返り値を呼ぶと 2 フレーム後に off（従来どおり）', async () => {
    const live = await load();
    const release = live.liveHold();
    expect(live.liveActive()).toBe(true);
    release();
    step(1);
    expect(live.liveActive()).toBe(true);
    step(1);
    expect(live.liveActive()).toBe(false);
  });

  it('pointerup が来ないまま窓の blur で離す', async () => {
    const live = await load();
    live.liveHold();
    win.dispatchEvent(new Event('blur'));
    step(2);
    expect(live.liveActive()).toBe(false);
  });

  it('visibilitychange で hidden になると離す（visible のままの visibilitychange では離さない）', async () => {
    const live = await load();
    live.liveHold();
    doc.dispatchEvent(new Event('visibilitychange'));
    step(2);
    expect(live.liveActive()).toBe(true);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    step(2);
    expect(live.liveActive()).toBe(false);
  });

  it('blur の後に返り値を呼んでも release は 1 回だけ（2 本目の hold は残る）', async () => {
    const live = await load();
    const r1 = live.liveHold();
    live.liveHold();
    win.dispatchEvent(new Event('blur'));
    // 2 本とも blur で離す
    step(2);
    expect(live.liveActive()).toBe(false);
    const r3 = live.liveHold();
    r1(); // 離し済みの返り値は何もしない
    step(2);
    expect(live.liveActive()).toBe(true);
    r3();
    step(2);
    expect(live.liveActive()).toBe(false);
  });

  it('離したら blur・visibilitychange の購読を外す', async () => {
    const live = await load();
    const offWin = vi.spyOn(win, 'removeEventListener');
    const offDoc = vi.spyOn(doc, 'removeEventListener');
    live.liveHold()();
    expect(offWin.mock.calls.map((c) => c[0])).toEqual(['blur']);
    expect(offDoc.mock.calls.map((c) => c[0])).toEqual(['visibilitychange']);
  });
});

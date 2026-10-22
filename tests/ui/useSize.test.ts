import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #123: ui/next/useSize.ts の watchSize。シートの高さの補間が走っている間は大きさを反映せず、終わり（finished の
 * resolve / reject）で 1 回だけ反映する。DOM（Element・CSSTransition・KeyframeEffect・ResizeObserver・rAF・
 * document.getAnimations）はクラスと関数で模す
 */
type Mod = typeof import('../../ui/next/useSize');

class FakeElement {
  constructor(
    public sel: string,
    public clientWidth = 300,
    public clientHeight = 200,
  ) {}
  matches(s: string) {
    return s.split(',').some((x) => x.trim() === this.sel);
  }
}
class FakeEffect {
  constructor(public target: FakeElement | null) {}
}
class FakeTransition {
  playState = 'running';
  finished: Promise<unknown>;
  resolve!: () => void;
  reject!: () => void;
  effect: FakeEffect;
  constructor(
    target: FakeElement,
    public transitionProperty = 'height',
  ) {
    this.effect = new FakeEffect(target);
    this.finished = new Promise<void>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

let frames: FrameRequestCallback[] = [];
let anims: FakeTransition[] = [];
let roCb: (() => void) | null = null;
let disconnected = false;

function step() {
  const fs = frames;
  frames = [];
  for (const f of fs) f(0);
}
/** ResizeObserver の通知 → 次のフレーム */
function resize() {
  roCb?.();
  step();
}
const flush = () => new Promise((r) => setTimeout(r, 0));

async function load(): Promise<Mod> {
  vi.resetModules();
  return import('../../ui/next/useSize');
}

beforeEach(() => {
  frames = [];
  anims = [];
  roCb = null;
  disconnected = false;
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('KeyframeEffect', FakeEffect);
  vi.stubGlobal('CSSTransition', FakeTransition);
  vi.stubGlobal('document', { getAnimations: () => anims });
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => {
    frames.push(f);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        roCb = cb;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function watch(m: Mod, el: FakeElement) {
  const seen: string[] = [];
  const stop = m.watchSize(el as unknown as HTMLElement, (w, h) => seen.push(`${w}x${h}`));
  return { seen, stop };
}

describe('watchSize（#123）', () => {
  it('最初に 1 回、補間が無ければ通知の次のフレームで反映する（切り捨て）', async () => {
    const m = await load();
    const el = new FakeElement('div', 300.7, 200.2);
    const { seen } = watch(m, el);
    expect(seen).toEqual(['300x200']);
    el.clientHeight = 150;
    resize();
    expect(seen).toEqual(['300x200', '300x150']);
  });

  it('シートの高さの補間の間は反映せず、finished で 1 回だけ最新の大きさを反映する', async () => {
    const m = await load();
    const el = new FakeElement('div');
    const { seen } = watch(m, el);
    const t = new FakeTransition(new FakeElement('section.scenario'));
    anims = [t];
    for (const h of [190, 170, 150]) {
      el.clientHeight = h;
      resize();
    }
    expect(seen).toEqual(['300x200']);
    anims = [];
    t.resolve();
    await flush();
    step();
    expect(seen).toEqual(['300x200', '300x150']);
  });

  it('取り消し（finished の reject）でも反映する。続けて逆向きの補間が始まればそれも待つ', async () => {
    const m = await load();
    const el = new FakeElement('div');
    const { seen } = watch(m, el);
    const t1 = new FakeTransition(new FakeElement('section.panel.side'));
    anims = [t1];
    el.clientHeight = 180;
    resize();
    const t2 = new FakeTransition(new FakeElement('section.panel.side'));
    anims = [t2];
    t1.reject();
    await flush();
    step(); // t2 が走っている → 待つ
    expect(seen).toEqual(['300x200']);
    el.clientHeight = 120;
    anims = [];
    t2.resolve();
    await flush();
    step();
    expect(seen).toEqual(['300x200', '300x120']);
  });

  it('シート以外の height の補間・height 以外の補間・止まった補間では待たない', async () => {
    const m = await load();
    const el = new FakeElement('div');
    const { seen } = watch(m, el);
    const other = new FakeTransition(new FakeElement('details.fold'));
    const color = new FakeTransition(new FakeElement('section.scenario'), 'color');
    const idle = new FakeTransition(new FakeElement('section.scenario'));
    idle.playState = 'finished';
    anims = [other, color, idle];
    el.clientWidth = 280;
    resize();
    expect(seen).toEqual(['300x200', '280x200']);
  });

  it('止めた後は補間が終わっても反映しない（observer も外す）', async () => {
    const m = await load();
    const el = new FakeElement('div');
    const { seen, stop } = watch(m, el);
    const t = new FakeTransition(new FakeElement('section.scenario'));
    anims = [t];
    el.clientHeight = 100;
    resize();
    stop();
    expect(disconnected).toBe(true);
    anims = [];
    t.resolve();
    await flush();
    step();
    expect(seen).toEqual(['300x200']);
  });
});

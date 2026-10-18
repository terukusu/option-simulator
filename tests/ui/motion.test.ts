import { describe, expect, it } from 'vitest';
import { PIN_SETTLE_MS } from '../../ui/pins';
import {
  LINE_MS,
  LIVE_INITIAL,
  LIVE_SETTLE_MS,
  type LiveEvent,
  type LiveState,
  liveBurst,
  liveNext,
  liveOn,
} from '../../ui/view/motion';
import { MARKER_BAND_PX } from '../../ui/view/stage';

/** #91 段 C: 連続の変更の間だけ補間を切る `.live` の規則（docs/ui-redesign.md §6・§10.1「動き」） */
describe('liveNext / liveOn', () => {
  it('LIVE_SETTLE_MS はピンの線の PIN_SETTLE_MS と同じ 120ms', () => {
    expect(LIVE_SETTLE_MS).toBe(PIN_SETTLE_MS);
    expect(LIVE_SETTLE_MS).toBe(120);
  });

  it('初期値は off', () => {
    expect(LIVE_INITIAL).toEqual({ holds: 0, pulseAt: Number.NEGATIVE_INFINITY });
    expect(liveOn(LIVE_INITIAL, 0)).toBe(false);
    expect(liveOn(LIVE_INITIAL, 1e9)).toBe(false);
  });

  it('hold の間は on、release で off（時刻によらない）', () => {
    const h = liveNext(LIVE_INITIAL, { kind: 'hold' });
    expect(h.holds).toBe(1);
    expect(liveOn(h, 0)).toBe(true);
    expect(liveOn(h, 1e9)).toBe(true);
    const r = liveNext(h, { kind: 'release' });
    expect(r.holds).toBe(0);
    expect(liveOn(r, 1e9)).toBe(false);
  });

  it('2 本の hold は 2 回の release で off（ピンチ）', () => {
    let s = liveNext(LIVE_INITIAL, { kind: 'hold' });
    s = liveNext(s, { kind: 'hold' });
    s = liveNext(s, { kind: 'release' });
    expect(liveOn(s, 0)).toBe(true);
    s = liveNext(s, { kind: 'release' });
    expect(liveOn(s, 0)).toBe(false);
  });

  it('release が hold より多くても holds は 0 未満にならない', () => {
    let s = liveNext(LIVE_INITIAL, { kind: 'release' });
    s = liveNext(s, { kind: 'release' });
    expect(s.holds).toBe(0);
    s = liveNext(s, { kind: 'hold' });
    expect(liveOn(s, 0)).toBe(true);
  });

  it('パルスから LIVE_SETTLE_MS 未満は on、ちょうど・以降は off', () => {
    const s = liveNext(LIVE_INITIAL, { kind: 'pulse', now: 1000 });
    expect(liveOn(s, 1000)).toBe(true);
    expect(liveOn(s, 1000 + LIVE_SETTLE_MS - 0.5)).toBe(true);
    expect(liveOn(s, 1000 + LIVE_SETTLE_MS)).toBe(false);
    expect(liveOn(s, 5000)).toBe(false);
  });

  it('パルスは最後の 1 回だけが効く（古い時刻へは戻らない）', () => {
    let s = liveNext(LIVE_INITIAL, { kind: 'pulse', now: 1000 });
    s = liveNext(s, { kind: 'pulse', now: 1100 });
    expect(s.pulseAt).toBe(1100);
    expect(liveOn(s, 1200)).toBe(true);
    s = liveNext(s, { kind: 'pulse', now: 900 });
    expect(s.pulseAt).toBe(1100);
  });

  it('非有限の now のパルスは無視（同じ参照）', () => {
    const s = liveNext(LIVE_INITIAL, { kind: 'pulse', now: 1000 });
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(liveNext(s, { kind: 'pulse', now })).toBe(s);
    }
  });

  it('非有限の now の liveOn は hold だけで決まる', () => {
    const p = liveNext(LIVE_INITIAL, { kind: 'pulse', now: 1000 });
    expect(liveOn(p, Number.NaN)).toBe(false);
    expect(liveOn(liveNext(p, { kind: 'hold' }), Number.NaN)).toBe(true);
  });

  it('性質: hold → release の対で元の holds に戻る・入力を書き換えない', () => {
    const evs: LiveEvent[] = [
      { kind: 'hold' },
      { kind: 'pulse', now: 10 },
      { kind: 'hold' },
      { kind: 'release' },
      { kind: 'pulse', now: 50 },
    ];
    let s: LiveState = LIVE_INITIAL;
    for (const e of evs) {
      const before = { ...s };
      const n = liveNext(s, e);
      expect(s).toEqual(before);
      const back = liveNext(liveNext(n, { kind: 'hold' }), { kind: 'release' });
      expect(back.holds).toBe(n.holds);
      s = n;
    }
    expect(s).toEqual({ holds: 1, pulseAt: 50 });
  });
});

describe('動きのトークン（tokens.css）', () => {
  // Node の型を入れていないので、fs は cssTokens.test.ts と同じく process.getBuiltinModule で読む
  const fs = (
    globalThis as unknown as {
      process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
    }
  ).process.getBuiltinModule('node:fs');
  const css = fs.readFileSync(new URL('../../ui/next/css/tokens.css', import.meta.url), 'utf8');
  it('--dur-line は LINE_MS と同じ ms', () => {
    expect(css).toContain(`--dur-line: ${LINE_MS}ms;`);
  });
  it('--marker-rise は MARKER_BAND_PX と同じ px', () => {
    expect(css).toContain(`--marker-rise: ${MARKER_BAND_PX}px;`);
  });
  it('reduced-motion で動きの時間がすべて 0ms', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const t of ['--dur-fast', '--dur', '--dur-ro', '--dur-line']) {
      expect(reduced).toContain(`${t}: 0ms;`);
    }
  });
});

/** 連打（前の線の変化から LINE_MS 未満で続く離散の変更）は連続の変更として補間を切る（#91 段 C。§6） */
describe('liveBurst', () => {
  it('LINE_MS は tokens.css の --dur-line と同じ 220ms', () => {
    expect(LINE_MS).toBe(220);
  });
  it('前の変化から LINE_MS 未満は連打、ちょうど・以降と初回は連打でない', () => {
    expect(liveBurst(Number.NEGATIVE_INFINITY, 1000)).toBe(false);
    expect(liveBurst(1000, 1000)).toBe(true);
    expect(liveBurst(1000, 1000 + LINE_MS - 0.5)).toBe(true);
    expect(liveBurst(1000, 1000 + LINE_MS)).toBe(false);
    expect(liveBurst(1000, 5000)).toBe(false);
  });
  it('非有限の now は連打でない', () => {
    expect(liveBurst(1000, Number.NaN)).toBe(false);
  });
});

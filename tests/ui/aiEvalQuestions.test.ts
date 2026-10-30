// AI の評価の問の組（#240）: 前回の実行との差で問を対応づける id が組の中で一意で、aiEval.mjs の行が全部 id を持つ。
// 同じ case の問が複数ある組（[AI に聞く] の put_sell 3 問・定型の put_sell 2 問・テクニカルの put_sell 2 問）を
// 出現順ではなく id で比べるため
import { describe, expect, it } from 'vitest';
import { DOC_QUESTIONS } from '../../scripts/aiEvalDocs';
import { QUESTION_IDS } from '../../scripts/aiEvalQuestions';

// ファイルは Node の fs で読む（@types/node を足さないため型はここで最小限に書く。pwa.test.ts と同じ）
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');

describe('問の id', () => {
  it('組ごとに一意で、空でない', () => {
    for (const [kind, ids] of Object.entries(QUESTION_IDS)) {
      expect(ids.length, kind).toBeGreaterThan(0);
      expect(new Set(ids).size, kind).toBe(ids.length);
      for (const id of ids) expect(id, kind).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('同じ case の問が複数あっても id で分かれる（テクニカル・[AI に聞く]）', () => {
    expect(QUESTION_IDS.technicals).toEqual([
      'oscillators-daily-4h',
      'oscillators-weekly',
      'stoch-rsi-4h',
      'ema-trend',
    ]);
    expect(QUESTION_IDS.ask).toEqual(['tile-maxloss', 'tile-bep', 'tile-premium', 'tail', 'iv']);
  });

  it('aiEval.mjs の rows.push はどれも id を持つ（文書の問の id は aiEvalDocs.ts）', () => {
    const src = fs.readFileSync(new URL('../../scripts/aiEval.mjs', import.meta.url), 'utf8');
    const pushes = src.split('rows.push({').slice(1);
    expect(pushes.length).toBeGreaterThanOrEqual(12);
    for (const p of pushes) {
      const obj = p.slice(0, p.indexOf('});'));
      expect(obj).toMatch(/\bid: `[a-z_]+:/);
    }
    expect(DOC_QUESTIONS.length).toBe(15);
  });
});

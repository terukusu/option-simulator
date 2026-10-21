// AI の評価の文書の質問（#240、EPIC #141 の終了条件 7）: 計算の前提 10 問・各問に想定の節と答えの要点。
// 想定の節が read_doc の索引にあることは api/tests/test_ai_docs.py が確かめる
import { describe, expect, it } from 'vitest';
import { DOC_QUESTIONS } from '../../scripts/aiEvalDocs';

describe('DOC_QUESTIONS', () => {
  it('計算の前提 10・操作の案内 3・文書に無いこと 1', () => {
    const n = (k: string) => DOC_QUESTIONS.filter((q) => q.kind === k).length;
    expect(n('premise')).toBe(10);
    expect(n('howto')).toBe(3);
    expect(n('absent')).toBe(1);
  });

  it('終了条件 7 の例（β・IV の動き方・30 日固定・テールの倍率）を含む', () => {
    const premise = DOC_QUESTIONS.filter((q) => q.kind === 'premise');
    for (const re of [/β/, /sticky/, /30 日固定/, /テール表.*倍率/]) {
      expect(premise.some((q) => re.test(q.text))).toBe(true);
    }
  });

  it('id は一意で、問の文も重ならない', () => {
    expect(new Set(DOC_QUESTIONS.map((q) => q.id)).size).toBe(DOC_QUESTIONS.length);
    expect(new Set(DOC_QUESTIONS.map((q) => q.text)).size).toBe(DOC_QUESTIONS.length);
    for (const q of DOC_QUESTIONS) expect(q.id).toMatch(/^[a-z0-9-]+$/);
  });

  it('想定の節は <file>:<節の番号> の形（absent は null）・答えの要点がある', () => {
    for (const q of DOC_QUESTIONS) {
      expect(q.points.length).toBeGreaterThan(0);
      if (q.kind === 'absent') {
        expect(q.expect).toBeNull();
        continue;
      }
      expect(q.expect?.length).toBeGreaterThan(0);
      for (const e of q.expect ?? [])
        expect(e).toMatch(/^(user-guide|design):[0-9]{1,2}(\.[0-9]{1,2}){0,3}$/);
      // 計算の前提の要点は節の中身を具体的に書く（人の照合表に使う）
      if (q.kind === 'premise') expect(q.points.length).toBeGreaterThan(30);
    }
  });
});

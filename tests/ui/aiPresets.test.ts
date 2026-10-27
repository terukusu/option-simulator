import { describe, expect, it } from 'vitest';
import { MAX_USER_TEXT } from '../../ui/view/aiChat';
import { checkNumbers } from '../../ui/view/aiNumbers';
import { AI_PRESET_IDS, AI_PRESETS, PRESET_PREFIX } from '../../ui/view/aiPresets';

/**
 * #140 AC1・AC3: 定型の質問（ui/view/aiPresets.ts）の表。ID・ボタンの文字・並び、文の形（先頭・上限・数字を含まない）、
 * 中継の許可リスト（PRESET_TOPICS）・system prompt の先頭の文（PRESET_PREFIX）・スキルの節との突き合わせ。
 */

/** Node の fs（@types/node を足さないため型はここで最小限に書く。tests/ui/aiAsk.test.ts と同じ） */
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');
const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('#140 AC1 定型の質問の表', () => {
  it('6 つ（ID・ボタンの文字・並びが固定）', () => {
    expect(AI_PRESETS.map((p) => p.id)).toEqual([...AI_PRESET_IDS]);
    expect(AI_PRESETS.map((p) => p.label)).toEqual([
      '崩れ方',
      '反論',
      '板の前提',
      'ヘッジ案',
      '出口',
      'IV の位置',
    ]);
  });

  it('文は「［定型］<名前>」の行で始まり、続けて質問。上限以下', () => {
    for (const p of AI_PRESETS) {
      const [head, ...rest] = p.text.split('\n');
      expect(head).toBe(`${PRESET_PREFIX}${p.label}`);
      expect(rest.join('').trim()).not.toBe('');
      expect(p.text.length).toBeLessThanOrEqual(MAX_USER_TEXT);
    }
  });

  it('文に照合の対象になる数字を含まない（算用数字が無い）', () => {
    for (const p of AI_PRESETS) {
      expect(p.text).not.toMatch(/[0-9０-９]/);
      expect(checkNumbers(p.text, []).tokens).toEqual([]);
    }
  });

  it('[反論] は理由を三つ、[IV の位置] は材料だけ（判断は本人）を頼む', () => {
    const by = new Map(AI_PRESETS.map((p) => [p.id, p.text]));
    expect(by.get('rebut')).toContain('三つ');
    expect(by.get('iv')).toContain('材料');
    expect(by.get('iv')).toContain('判断は自分で');
  });
});

describe('#140 AC3 中継との突き合わせ', () => {
  it('allowlist.py の PRESET_TOPICS と同じ並び', () => {
    const py = read('api/src/simulator_api/ai/allowlist.py');
    const m = /^PRESET_TOPICS = \(([^)]*)\)/m.exec(py);
    expect(m, 'PRESET_TOPICS が無い').not.toBeNull();
    const ids = [...(m?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(ids).toEqual([...AI_PRESET_IDS]);
  });

  it('relay.py の PRESET_PREFIX と同じ文、スキル presets に定型ごとの節', () => {
    const relay = read('api/src/simulator_api/ai/relay.py');
    expect(relay).toContain(`PRESET_PREFIX = "${PRESET_PREFIX}"`);
    const skill = read('api/src/simulator_api/ai/plugin/skills/presets/SKILL.md');
    for (const p of AI_PRESETS) expect(skill).toContain(`\n## ${p.label}\n`);
  });
});

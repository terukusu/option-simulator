import { describe, expect, it } from 'vitest';
import { MAX_USER_TEXT } from '../../ui/view/aiChat';
import { checkNumbers, displayedValues } from '../../ui/view/aiNumbers';
import {
  AI_PRESET_IDS,
  AI_PRESETS,
  PRESET_PREFIX,
  SHAPE_PRESET_LABEL,
  shapePreset,
  shapePresetText,
} from '../../ui/view/aiPresets';
import { SHAPE_IDS, shapeOf } from '../../ui/view/templates';

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
  it('6 つ（ID・ボタンの文字・並びが固定）。形の相談（shape。#20）はチップに出さない', () => {
    expect(AI_PRESETS.map((p) => p.id)).toEqual(AI_PRESET_IDS.filter((id) => id !== 'shape'));
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

  it('relay.py の PRESET_PREFIX と同じ文、スキル presets に定型ごとの節（形の相談を含む）', () => {
    const relay = read('api/src/simulator_api/ai/relay.py');
    expect(relay).toContain(`PRESET_PREFIX = "${PRESET_PREFIX}"`);
    const skill = read('api/src/simulator_api/ai/plugin/skills/presets/SKILL.md');
    for (const p of AI_PRESETS) expect(skill).toContain(`\n## ${p.label}\n`);
    expect(skill).toContain(`\n## ${SHAPE_PRESET_LABEL}\n`);
    // system prompt が形の相談で simulator:proposals も読ませる
    expect(relay).toContain(`「${SHAPE_PRESET_LABEL}」`);
  });
});

describe('#20 第 2 弾 形の相談（定型 shape）の文', () => {
  it('kind preset の ID shape・足は要らない・名前は「形の相談」', () => {
    const p = shapePreset('short_strangle', '2026-12');
    expect(p.id).toBe('shape');
    expect(p.label).toBe(SHAPE_PRESET_LABEL);
    expect(p.needsLegs).toBe(false);
    expect(p.text).toBe(shapePresetText('short_strangle', '2026-12'));
  });

  it('文は「［定型］形の相談」で始まり、形の名前と型の ID と限月を含む', () => {
    expect(shapePresetText('short_strangle', '2026-12')).toBe(
      [
        '［定型］形の相談',
        'ストラングル売り（short_strangle）・限月 2026-12',
        '今の板でこの形を組む候補（距離の違い）を比べ、提案のカードで出してください。判断は自分でします。',
      ].join('\n'),
    );
    for (const id of SHAPE_IDS) {
      const t = shapePresetText(id, '2027-01');
      const [head, second] = t.split('\n');
      expect(head).toBe(`${PRESET_PREFIX}${SHAPE_PRESET_LABEL}`);
      expect(second).toContain(`（${id}）`);
      expect(second).toContain(shapeOf(id).short ?? shapeOf(id).name);
      expect(second).toContain('2027-01');
      expect(t.length).toBeLessThanOrEqual(MAX_USER_TEXT);
    }
  });

  it('限月の ID のほかに数字を含まない（照合の出所にならない = 数字の札は全部 ignored・表示の値は空）', () => {
    for (const id of SHAPE_IDS) {
      for (const month of ['2026-12', '2027-03']) {
        const t = shapePresetText(id, month);
        // 限月の ID を除くと算用数字が無い（put レシオの「（1 買 2 売）」も入れない）
        expect(t.replace(month, '')).not.toMatch(/[0-9０-９]/);
        const tokens = checkNumbers(t, []).tokens;
        expect(tokens.length).toBeGreaterThan(0);
        expect(tokens.every((x) => x.status === 'ignored')).toBe(true);
        expect(displayedValues(t)).toEqual({});
      }
    }
  });
});

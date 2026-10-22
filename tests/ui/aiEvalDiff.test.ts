// AI の評価の前回の実行との差（#240、EPIC #141 の終了条件 14）: モード・前回の選び方・件数の差・問ごとの pass ↔ FAIL
import { describe, expect, it } from 'vitest';
import {
  diffRuns,
  type EvalRow,
  evalMode,
  formatDiff,
  pickPrevious,
  type RunEntry,
  rowKeys,
  runCounts,
} from '../../scripts/aiEvalDiff';

describe('evalMode', () => {
  it('--*-only と --saved は固定の順で + つなぎ', () => {
    expect(evalMode(['--docs-only'])).toBe('docs');
    expect(evalMode(['--saved'])).toBe('saved');
    expect(evalMode(['--quote-only'])).toBe('quote');
    expect(evalMode(['--iv-only', '--tech-only'])).toBe('tech+iv');
  });
  it('何も無ければ all。--cases（並べ替え）・--repeat（1 以外）・--no-followups を足す', () => {
    expect(evalMode([])).toBe('all');
    expect(evalMode(['--repeat', '1'])).toBe('all');
    expect(evalMode(['--cases', 'put_sell,calendar', '--repeat', '2', '--no-followups'])).toBe(
      'all cases=calendar,put_sell repeat=2 no-followups',
    );
    // --*-only があると診断の組は流れないので --cases などはモードに入れない
    expect(evalMode(['--docs-only', '--cases', 'put_sell'])).toBe('docs');
  });
});

const row = (kind: string, c: string, pass: boolean, extra: Partial<EvalRow> = {}): EvalRow => ({
  kind,
  case: c,
  rep: 0,
  pass,
  unmatched: [],
  ...extra,
});
const file = (mode: string | undefined, credential: string, rows: EvalRow[] = []) => ({
  summary: { ...(mode !== undefined && { mode }), credential },
  rows,
});

describe('pickPrevious', () => {
  const entries: RunEntry[] = [
    { dir: '2026-10-20T00-00-00-000Z', file: file('docs', 'api_key') },
    { dir: '2026-10-21T00-00-00-000Z', file: file('docs', 'api_key') },
    { dir: '2026-10-21T06-00-00-000Z', file: file('docs', 'fake') },
    { dir: '2026-10-21T07-00-00-000Z', file: file('all', 'api_key') },
    { dir: '2026-10-21T08-00-00-000Z', file: file(undefined, 'api_key') },
    { dir: '2026-10-21T09-00-00-000Z', file: null },
    { dir: '2026-10-23T00-00-00-000Z', file: file('docs', 'api_key') },
  ];
  const now = '2026-10-22T00-00-00-000Z';
  it('今回より前・同じモード・fake かどうかが同じものの最新', () => {
    expect(pickPrevious(entries, { dir: now, mode: 'docs', fake: false })?.dir).toBe(
      '2026-10-21T00-00-00-000Z',
    );
    expect(pickPrevious(entries, { dir: now, mode: 'docs', fake: true })?.dir).toBe(
      '2026-10-21T06-00-00-000Z',
    );
    expect(pickPrevious(entries, { dir: now, mode: 'all', fake: false })?.dir).toBe(
      '2026-10-21T07-00-00-000Z',
    );
  });
  it('mode の無い古い summary・読めない summary は選ばない。無ければ null', () => {
    expect(pickPrevious(entries, { dir: now, mode: 'saved', fake: false })).toBeNull();
    expect(pickPrevious(entries.slice(4, 6), { dir: now, mode: 'all', fake: false })).toBeNull();
    expect(pickPrevious([], { dir: now, mode: 'docs', fake: false })).toBeNull();
  });
});

describe('rowKeys・runCounts', () => {
  it('id があればそれ、無ければ kind:case（rep 0 以外は #rep）、重なりは (2)', () => {
    const rows = [
      row('docs', 'put_sell', true, { id: 'docs:iv30' }),
      row('technicals', 'put_sell', true),
      row('technicals', 'put_sell', false),
      row('diagnose', 'calendar', true, { rep: 1 }),
    ];
    expect(rowKeys(rows)).toEqual([
      'docs:iv30',
      'technicals:put_sell',
      'technicals:put_sell(2)',
      'diagnose:calendar#1',
    ]);
  });
  it('一致は matchedTotal か matched の和、不一致は文書の行を除く', () => {
    const rows = [
      row('diagnose', 'a', true, { matched: [2, 3], unmatched: ['1'] }),
      row('followup', 'a', false, { matchedTotal: 4, unmatched: ['2', '3'] }),
      row('docs', 'a', true, { unmatched: ['9', '9'] }),
    ];
    expect(runCounts(rows)).toEqual({ pass: 2, total: 3, matched: 9, unmatched: 3 });
  });
});

describe('diffRuns・formatDiff', () => {
  const prev = [
    row('docs', 'p', true, { id: 'docs:a' }),
    row('docs', 'p', false, { id: 'docs:b' }),
    row('docs', 'p', true, { id: 'docs:gone' }),
    row('saved', 'x', true, { matchedTotal: 3, unmatched: [] }),
  ];
  const now = [
    row('docs', 'p', false, { id: 'docs:a' }),
    row('docs', 'p', true, { id: 'docs:b' }),
    row('docs', 'p', true, { id: 'docs:new' }),
    row('saved', 'x', true, { matchedTotal: 5, unmatched: ['1'] }),
  ];
  it('件数の差と pass ↔ FAIL・新しい問・無くなった問', () => {
    const d = diffRuns(prev, now);
    expect(d.prev).toEqual({ pass: 3, total: 4, matched: 3, unmatched: 0 });
    expect(d.now).toEqual({ pass: 3, total: 4, matched: 5, unmatched: 1 });
    expect(d.toFail).toEqual(['docs:a']);
    expect(d.toPass).toEqual(['docs:b']);
    expect(d.added).toEqual(['docs:new']);
    expect(d.removed).toEqual(['docs:gone']);
  });
  it('標準出力の行（前回なし / 差）', () => {
    expect(formatDiff('docs', null, null)).toEqual(['前回との差（モード docs）: 前回なし']);
    const lines = formatDiff('docs', '2026-10-21T00-00-00-000Z', diffRuns(prev, now));
    expect(lines[0]).toBe('前回との差（モード docs・前回 2026-10-21T00-00-00-000Z）:');
    expect(lines[1]).toBe('  正答 3/4 → 3/4（±0）');
    expect(lines[2]).toBe('  数値の一致 3 → 5（+2）・不一致 0 → 1（+1）');
    expect(lines).toContain('  pass → FAIL: docs:a');
    expect(lines).toContain('  FAIL → pass: docs:b');
    expect(lines).toContain('  新しい問: docs:new');
    expect(lines).toContain('  無くなった問: docs:gone');
    // 変化が無ければ「なし」で、新しい / 無くなった問の行は出さない
    const same = formatDiff('docs', 'p', diffRuns(now, now));
    expect(same).toContain('  pass → FAIL: なし');
    expect(same.some((l) => l.includes('新しい問'))).toBe(false);
  });
});

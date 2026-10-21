/**
 * AI の評価（scripts/aiEval.mjs）の前回の実行との差（#240、EPIC #141 の終了条件 14）。純関数（ファイルを読まない）。
 *
 * - モード = 実行の引数のうち問の組を変えるもの。summary.json の summary.mode に残し、同じモードの前回とだけ比べる
 * - 前回 = fixtures/local/ai_eval/<時刻>/ のうち、今回より前・同じモード・偽の送信先（credential が fake）かどうかが
 *   同じものの最新（ディレクトリの名前は ISO の時刻の置き換えなので辞書順 = 時刻順）。mode の無い古い summary は選ばない
 * - 件数: 正答 = pass の行の数。数値の一致 = 各行の matchedTotal（診断は matched の和）の合計、不一致 = unmatched の
 *   数の合計（文書の行は照合の対象外なので数えない = summary.unmatched_total と同じ）
 */

export interface EvalRow {
  kind: string;
  case?: string;
  rep?: number;
  /** 安定な名前（文書の問は docs:<id>）。無ければ kind・case・rep から作る */
  id?: string;
  pass: boolean;
  matched?: number[];
  matchedTotal?: number;
  unmatched?: string[];
}

export interface EvalSummaryFile {
  summary?: { mode?: string; credential?: string } | null;
  rows?: EvalRow[];
}

/** 問の組を変える引数（この順でモードの文字列に並べる） */
export const ONLY_FLAGS = [
  '--tech-only',
  '--iv-only',
  '--propose-only',
  '--docs-only',
  '--ask-only',
  '--profile-only',
  '--preset-only',
  '--saved',
] as const;

/** 引数 → モードの文字列（例 "docs"・"tech+iv"・"saved"・"all"・"all cases=calendar,put_sell repeat=2 no-followups"） */
export function evalMode(args: readonly string[]): string {
  const only = ONLY_FLAGS.filter((f) => args.includes(f)).map((f) =>
    f.replace(/^--/, '').replace(/-only$/, ''),
  );
  if (only.length > 0) return only.join('+');
  // --cases・--repeat・--no-followups は診断の組（--*-only が無いときだけ流れる）にだけ効く
  const parts = ['all'];
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? null : (args[i + 1] ?? null);
  };
  const cases = value('--cases');
  if (cases) parts.push(`cases=${cases.split(',').filter(Boolean).sort().join(',')}`);
  const repeat = value('--repeat');
  if (repeat !== null && Number(repeat) !== 1) parts.push(`repeat=${Number(repeat)}`);
  if (args.includes('--no-followups')) parts.push('no-followups');
  return parts.join(' ');
}

export interface RunEntry {
  /** fixtures/local/ai_eval/ の下のディレクトリの名前（時刻） */
  dir: string;
  /** その summary.json（読めなければ null） */
  file: EvalSummaryFile | null;
}

/** 比べる前回を選ぶ（無ければ null） */
export function pickPrevious(
  entries: readonly RunEntry[],
  current: { dir: string; mode: string; fake: boolean },
): RunEntry | null {
  let best: RunEntry | null = null;
  for (const e of entries) {
    if (e.dir >= current.dir) continue;
    const s = e.file?.summary;
    if (!s || s.mode !== current.mode) continue;
    if ((s.credential === 'fake') !== current.fake) continue;
    if (!Array.isArray(e.file?.rows)) continue;
    if (best === null || e.dir > best.dir) best = e;
  }
  return best;
}

/** 行の名前（同じ名前が続くときは 2 つ目から「(2)」） */
export function rowKeys(rows: readonly EvalRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base =
      r.id ?? `${r.kind}:${r.case ?? '—'}${r.rep !== undefined && r.rep !== 0 ? `#${r.rep}` : ''}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}(${n})`;
  });
}

export interface RunCounts {
  pass: number;
  total: number;
  matched: number;
  unmatched: number;
}

export function runCounts(rows: readonly EvalRow[]): RunCounts {
  let pass = 0;
  let matched = 0;
  let unmatched = 0;
  for (const r of rows) {
    if (r.pass) pass++;
    matched += r.matchedTotal ?? (r.matched ?? []).reduce((a, b) => a + b, 0);
    if (r.kind !== 'docs') unmatched += r.unmatched?.length ?? 0;
  }
  return { pass, total: rows.length, matched, unmatched };
}

export interface RunDiff {
  prev: RunCounts;
  now: RunCounts;
  /** 前回 pass → 今回 FAIL の問 */
  toFail: string[];
  /** 前回 FAIL → 今回 pass の問 */
  toPass: string[];
  /** 今回だけにある問 */
  added: string[];
  /** 前回だけにある問 */
  removed: string[];
}

export function diffRuns(prevRows: readonly EvalRow[], rows: readonly EvalRow[]): RunDiff {
  const passByKey = (xs: readonly EvalRow[]) => {
    const keys = rowKeys(xs);
    return new Map(xs.map((r, i) => [keys[i] ?? '', r.pass]));
  };
  const prev = passByKey(prevRows);
  const now = passByKey(rows);
  const toFail: string[] = [];
  const toPass: string[] = [];
  const added: string[] = [];
  for (const [k, p] of now) {
    const before = prev.get(k);
    if (before === undefined) added.push(k);
    else if (before && !p) toFail.push(k);
    else if (!before && p) toPass.push(k);
  }
  const removed = [...prev.keys()].filter((k) => !now.has(k));
  return { prev: runCounts(prevRows), now: runCounts(rows), toFail, toPass, added, removed };
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');

/** 標準出力の行（diff が null なら「前回なし」） */
export function formatDiff(mode: string, previous: string | null, diff: RunDiff | null): string[] {
  if (previous === null || diff === null) return [`前回との差（モード ${mode}）: 前回なし`];
  const { prev, now } = diff;
  const list = (xs: string[]) => (xs.length ? xs.join('、') : 'なし');
  return [
    `前回との差（モード ${mode}・前回 ${previous}）:`,
    `  正答 ${prev.pass}/${prev.total} → ${now.pass}/${now.total}（${signed(now.pass - prev.pass)}）`,
    `  数値の一致 ${prev.matched} → ${now.matched}（${signed(now.matched - prev.matched)}）・不一致 ${prev.unmatched} → ${now.unmatched}（${signed(now.unmatched - prev.unmatched)}）`,
    `  pass → FAIL: ${list(diff.toFail)}`,
    `  FAIL → pass: ${list(diff.toPass)}`,
    ...(diff.added.length ? [`  新しい問: ${list(diff.added)}`] : []),
    ...(diff.removed.length ? [`  無くなった問: ${list(diff.removed)}`] : []),
  ];
}

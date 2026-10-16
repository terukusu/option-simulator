/**
 * 利用者が付ける名前（保存一覧の項目名 #70・作業中のタブの名前 #71）の正規化（純関数）。
 * 名前は外から来た値（localStorage・読み込むファイル）として扱い、表示は JSX のテキスト / 属性だけで入れる。
 * state（タブ）と book（保存一覧）の両方から使うため、どちらにも依存しないここに置く（循環 import を作らない）。
 */

/** 除く文字: 制御文字（C0・DEL・C1）と双方向の制御・方向の印（ALM・LRM・RLM・LRE〜RLO・LRI〜PDI） */
export function unsafeChar(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x061c ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

/** 先頭から max コードポイントまで（サロゲートペアを割らない）。 */
export function clipCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, Math.max(max, 0)).join('');
}

/** 名前の正規化: 制御文字・双方向の制御を除き、前後の空白を取り、max 字で切る（空なら空文字）。 */
export function cleanName(s: string, max: number): string {
  const kept = Array.from(s)
    .filter((c) => !unsafeChar(c.codePointAt(0) ?? 0))
    .join('');
  return clipCodePoints(kept.trim(), max).trim();
}

/**
 * 建玉の一覧の画像の読み取り（`POST /api/ai/read_positions`。#318・docs/adr-0009-ai-image-read-positions.md）の
 * ブラウザ側の受け口: 要求・応答の型、応答の検査（中継と同じ形。知らないキーは捨てずにエラー）、fetch の薄い包み。
 *
 * 画像・結果はここで保存しない（Web Storage・IndexedDB・Cache・URL に入れない）。失敗は data/aiStream.ts の
 * AiRequestError（IAP のセッション切れ = session_expired・network・中継の error の code）。
 */

import { AiRequestError, aiFailure, fetchAi } from './aiStream';

/** 送る画像の形式（ブラウザで作り直した PNG / JPEG だけ） */
export type ReadImageType = 'image/png' | 'image/jpeg';

export interface ReadPositionsRequest {
  schema_version: 1;
  image: { media_type: ReadImageType; data: string };
}

export type ReadProduct = 'op_large' | 'fut_large' | 'fut_mini' | 'fut_micro' | 'unknown';

/** 読み取った 1 行（全欄そろう。読めない欄は null） */
export interface ReadRow {
  product: ReadProduct;
  expiry_year: number | null;
  expiry_month: number | null;
  type: 'C' | 'P' | null;
  strike: number | null;
  side: 'buy' | 'sell' | null;
  qty: number | null;
  price: number | null;
  /** YYYY-MM-DD */
  opened_on: string | null;
}

export interface ReadResult {
  kind: 'positions' | 'not_positions';
  rows: ReadRow[];
  remaining_usd: number | null;
}

/** 既定の口（dev の合成の応答は `/fixtures/ai/read_positions`） */
export const AI_READ_POSITIONS_PATH = '/api/ai/read_positions';

/** 行の上限（中継の MAX_ROWS = 足の上限 20 と同じ） */
export const READ_MAX_ROWS = 20;

const ROW_KEYS = [
  'product',
  'expiry_year',
  'expiry_month',
  'type',
  'strike',
  'side',
  'qty',
  'price',
  'opened_on',
] as const;
const PRODUCTS: readonly ReadProduct[] = [
  'op_large',
  'fut_large',
  'fut_mini',
  'fut_micro',
  'unknown',
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isFinite(v));
const intOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isInteger(v));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function toRow(v: unknown): ReadRow | null {
  if (!isObj(v)) return null;
  const keys = Object.keys(v);
  if (
    keys.length !== ROW_KEYS.length ||
    !keys.every((k) => (ROW_KEYS as readonly string[]).includes(k))
  )
    return null;
  const { product, expiry_year, expiry_month, type, strike, side, qty, price, opened_on } = v;
  if (typeof product !== 'string' || !PRODUCTS.includes(product as ReadProduct)) return null;
  if (!intOrNull(expiry_year) || !intOrNull(expiry_month) || !intOrNull(qty)) return null;
  if (!numOrNull(strike) || !numOrNull(price)) return null;
  if (!(type === null || type === 'C' || type === 'P')) return null;
  if (!(side === null || side === 'buy' || side === 'sell')) return null;
  if (!(opened_on === null || (typeof opened_on === 'string' && DATE.test(opened_on)))) return null;
  return {
    product: product as ReadProduct,
    expiry_year,
    expiry_month,
    type,
    strike,
    side,
    qty,
    price,
    opened_on,
  };
}

/** 応答の検査（中継と同じ形。知らないキー・型の違い・行の上限超えは null = 読めない応答） */
export function parseReadResult(v: unknown): ReadResult | null {
  if (!isObj(v)) return null;
  const keys = Object.keys(v).sort();
  if (keys.join(',') !== 'kind,remaining_usd,rows,schema_version') return null;
  if (v.schema_version !== 1) return null;
  if (v.kind !== 'positions' && v.kind !== 'not_positions') return null;
  if (!numOrNull(v.remaining_usd)) return null;
  if (!Array.isArray(v.rows) || v.rows.length > READ_MAX_ROWS) return null;
  const rows: ReadRow[] = [];
  for (const r of v.rows) {
    const row = toRow(r);
    if (!row) return null;
    rows.push(row);
  }
  return { kind: v.kind, rows: v.kind === 'positions' ? rows : [], remaining_usd: v.remaining_usd };
}

/**
 * `POST /api/ai/read_positions`（JSON の 1 往復）。失敗は AiRequestError（`session_expired`・`network`・中継の code・
 * 形の違う応答は `bad_result`）。`signal` で待つのをやめる（サーバーは最後まで読み、費用は精算どおり）。
 */
export async function postReadPositions(
  body: ReadPositionsRequest,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
  endpoint: string = AI_READ_POSITIONS_PATH,
): Promise<ReadResult> {
  const res = await fetchAi(fetchFn, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
  if (!res.ok) throw await aiFailure(res);
  if (!(res.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
    // 200 でも JSON でない = IAP のログインの画面など
    throw new AiRequestError(res.status, 'session_expired');
  }
  let j: unknown;
  try {
    j = await res.json();
  } catch {
    throw new AiRequestError(res.status, 'bad_result');
  }
  const out = parseReadResult(j);
  if (!out) throw new AiRequestError(res.status, 'bad_result');
  return out;
}

/**
 * 画面の雛形（縦切り 1 の土台）。いまは model/ の動作確認として、架空のストラングル売りの
 * 満期損益の指標とテール表を出すだけ。板・グラフ・スライダーは後続の Issue で作る。
 */

import {
  DAY_MS,
  expiryProfile,
  type Leg,
  type MarketContext,
  preparePosition,
  tailTable,
  ZERO_SCENARIO,
} from '../model';

const yen = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const fmt = (v: number) => (Number.isFinite(v) ? yen.format(v) : v > 0 ? '+∞' : '−∞');

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}

function render(root: HTMLElement): void {
  // 架空の例（設計 6.1）: F = 67,810、T = 30.5 日、売り P 64,000 @ 810 / 売り C 70,500 @ 995
  const ctx: MarketContext = {
    evalTime: 0,
    r: 0.005,
    x0: 67810,
    options: { M1: { sqTime: 30.5 * DAY_MS, forward: 67810, smile: null } },
    futures: {},
  };
  const legs: Leg[] = [
    {
      kind: 'option',
      product: 'op_large',
      type: 'put',
      expiry: 'M1',
      strike: 64000,
      side: 'sell',
      qty: 1,
      entry: 810,
    },
    {
      kind: 'option',
      product: 'op_large',
      type: 'call',
      expiry: 'M1',
      strike: 70500,
      side: 'sell',
      qty: 1,
      entry: 995,
    },
  ];
  const prepared = preparePosition(legs, ctx);
  const prof = expiryProfile(prepared, ctx);
  const tail = tailTable(prepared, ZERO_SCENARIO, ctx);

  const summary = el('p');
  summary.textContent = `最大利益 ${fmt(prof.maxProfit.value)} 円 / 最大損失 ${fmt(prof.worstAtKinks.value)} 円（下落側）・${fmt(prof.maxLoss.value)}（上昇側）/ BEP ${prof.breakevens.map(fmt).join(' / ')}`;

  const table = el('table');
  const head = el('tr');
  head.append(el('th', '原資産'), el('th', 'SQ'), el('th', '指定日（β = 1）'));
  table.append(head);
  for (const r of tail.rows) {
    const tr = el('tr');
    tr.append(
      el('td', `${(r.shock * 100).toFixed(0)}%`),
      el('td', `${fmt(r.sq.pnl)}（×${(r.sq.ratio ?? 0).toFixed(1)}）`),
      el('td', `${fmt(r.scenario.pnl)}（×${(r.scenario.ratio ?? 0).toFixed(1)}）`),
    );
    table.append(tr);
  }
  root.replaceChildren(summary, table);
}

const root = document.getElementById('app');
if (root) render(root);

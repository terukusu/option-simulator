/**
 * 部品の見本（dev だけ。`?parts`。古い `?ui=next&parts` も。#81）。全部品の各状態（選択・hot・長いラベル・無効）を 1 画面に並べ、
 * 折り返しの検出（npm run ui:check -- --parts）とスクリーンショットを当てる。
 * ui/next/main.tsx の import.meta.env.DEV の分岐からだけ読む（本番のビルドに入らない）。値はすべて架空。
 */

import { useState } from 'preact/hooks';
import { AUTH_EXPIRED_TEXT, RELOAD_PAGE_LABEL } from '../../view/reloadPage';
import { Chip, ChipRow } from '../parts/Chip';
import { Dialog } from '../parts/Dialog';
import { Icon } from '../parts/Icon';
import { Menu, type MenuItem } from '../parts/Menu';
import { Popover } from '../parts/Popover';
import { Seg } from '../parts/Seg';
import { Stepper } from '../parts/Stepper';
import { ToastSlot, useToastHost, useToasts } from '../parts/Toast';
import './gallery.css';

const DAYS = { min: 0, max: 30, step: 1, def: 0 };
const SIGMA = { min: -40, max: 40, step: 0.5, def: 0 };
const BETA = { min: 0, max: 1, step: 0.1, def: 0.5 };

const signed = (v: number, digits = 0) =>
  `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)}`;

const JUMPS = ['ATM', 'OTM 10%', '20%', '30%', '40%', '|Δ| .05', '.10', '.20', '.30', '.40'];

export function PartsGallery() {
  const [sticky, setSticky] = useState<'strike' | 'moneyness'>('strike');
  const [target, setTarget] = useState<'put' | 'call'>('put');
  const [axis, setAxis] = useState<'k' | 'm' | 'd'>('k');
  const [ask, setAsk] = useState(true);
  const [days, setDays] = useState(5);
  const [sigma, setSigma] = useState(0);
  const [beta, setBeta] = useState(0.5);
  const [low, setLow] = useState(0);
  const [dialog, setDialog] = useState(false);
  const [picked, setPicked] = useState('なし');
  const toasts = useToasts();
  const toastHost = useToastHost({
    toasts: toasts.toasts,
    onUndo: toasts.undo,
    onDismiss: toasts.dismiss,
  });
  const items: MenuItem[] = [
    { key: 'dup', label: 'タブを複製', kbd: 'D', onSelect: () => setPicked('タブを複製') },
    { key: 'rename', label: '名前を変える', onSelect: () => setPicked('名前を変える') },
    { key: 'off', label: '閉じる（最後のタブ）', disabled: true, onSelect: () => {} },
    { key: 'share', label: 'URL をコピー', kbd: '⌘L', onSelect: () => setPicked('URL をコピー') },
    // 区切り（#87）
    { key: 'theme', label: 'テーマ', sep: true, onSelect: () => setPicked('テーマ') },
  ];
  return (
    <main class="parts-gallery">
      <h1>部品の見本</h1>
      <p class="gal-note">
        dev だけ（?parts）。値は架空。各部品の選択・強調・長いラベル・無効の状態を並べる。
      </p>

      <section class="gal-sec" aria-label="セグメント">
        <h2>セグメント</h2>
        <div class="gal-row">
          <Seg
            label="対象"
            value={target}
            onChange={setTarget}
            options={[
              { value: 'put', text: 'put' },
              { value: 'call', text: 'call' },
            ]}
          />
          <Seg
            label="IV の動き方"
            value={sticky}
            onChange={setSticky}
            options={[
              { value: 'strike', text: 'sticky strike' },
              { value: 'moneyness', text: 'sticky moneyness' },
            ]}
          />
          <Seg
            label="横軸"
            value={axis}
            onChange={setAxis}
            options={[
              { value: 'k', text: '行使価格' },
              { value: 'm', text: 'moneyness' },
              { value: 'd', text: 'Δ', disabled: true, title: '無効の例' },
            ]}
          />
        </div>
      </section>

      <section class="gal-sec" aria-label="チップ">
        <h2>チップ</h2>
        <div class="gal-row">
          <Chip
            text="1 回の操作"
            onClick={() => toasts.push({ kind: 'chip', text: 'チップを押した' })}
          />
          <Chip text="トグル（入）" pressed={true} onClick={() => {}} />
          <Chip text="トグル（切）" pressed={false} onClick={() => {}} />
          <Chip text="ask ≤ 50 円" warn pressed={ask} onClick={() => setAsk(!ask)} />
          <Chip text="無効" disabled onClick={() => {}} />
        </div>
        <div class="gal-narrow">
          <ChipRow label="ジャンプ">
            {JUMPS.map((j) => (
              <Chip key={j} text={j} onClick={() => {}} />
            ))}
          </ChipRow>
        </div>
      </section>

      <section class="gal-sec" aria-label="ステッパー">
        <h2>ステッパー</h2>
        <div class="gal-grid">
          <Stepper
            label="経過日数 d"
            spec={DAYS}
            value={days}
            onChange={setDays}
            format={(v) => `${v} 日`}
            sub="10/18 21:31（日）"
          />
          <Stepper
            label="IV Δσ"
            spec={SIGMA}
            value={sigma}
            onChange={setSigma}
            format={(v) => `${signed(v, 1)}pt`}
            sub="既定"
          />
          <Stepper
            label="β"
            spec={BETA}
            value={beta}
            onChange={setBeta}
            format={(v) => v.toFixed(1)}
          />
          <Stepper
            label="下限の例"
            spec={DAYS}
            value={low}
            onChange={setLow}
            format={(v) => `${v} 日`}
            sub="とても長い副題は省略記号で切る（折り返さない）"
          />
        </div>
      </section>

      <section class="gal-sec" aria-label="メニューとポップオーバー">
        <div class="gal-head">
          <h2>メニュー · ポップオーバー</h2>
          <span class="gal-spacer" />
          <Popover label="ポップオーバーの説明" button={<Icon name="info" />}>
            説明文は折り返してよい（§5.1）。外側のタップ・Esc で閉じ、同時に開くのは 1 つだけ。
          </Popover>
          <Menu label="タブの操作" button={<Icon name="more" />} items={items} />
        </div>
        <p class="gal-note">選んだ項目: {picked}</p>
        <div class="menu gal-static" role="presentation">
          {items.map((it) => [
            it.sep ? <hr class="menu-sep" key={`${it.key}-sep`} /> : null,
            <button
              type="button"
              key={it.key}
              tabIndex={-1}
              aria-disabled={it.disabled ? true : undefined}
            >
              <span>{it.label}</span>
              {it.kbd && <span class="kbd">{it.kbd}</span>}
            </button>,
          ])}
        </div>
      </section>

      <section class="gal-sec" aria-label="ダイアログとトースト">
        <h2>ダイアログ · トースト</h2>
        <div class="gal-row">
          <button type="button" class="btn" onClick={() => setDialog(true)}>
            ダイアログを開く
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => toasts.push({ kind: 'saved', text: '保存した 21:31' })}
          >
            トースト
          </button>
          <button
            type="button"
            class="btn"
            onClick={() =>
              toasts.push({
                kind: 'removed',
                text: '足を削除した（売 P 64,000）',
                undo: () => toasts.push({ kind: 'restored', text: '元に戻した' }),
              })
            }
          >
            元に戻す付き
          </button>
          <button
            type="button"
            class="btn"
            onClick={() =>
              toasts.push({
                kind: 'note-restored',
                text: '前回の作業を復元した（足 2 本。保存 2026-11-02 21:47、そのときの板 2026-11-02 21:31）。建値は保存時のまま',
                note: 'info',
              })
            }
          >
            知らせ（情報）
          </button>
          <button
            type="button"
            class="btn"
            onClick={() =>
              toasts.push({
                kind: 'note-invalid',
                text: '保存した作業を読めなかった（形式が壊れている）。既定の状態で開いた',
                note: 'warn',
              })
            }
          >
            知らせ（警告）
          </button>
          <span class="tag">手入力</span>
          <span class="tag warn">古い板</span>
          <span class="tag ok">ok</span>
          <span class="tag bad">IV 不安定</span>
        </div>
        <div class="toast gal-static">
          <span class="txt">足を削除した（売 C 70,500）</span>
          <button type="button" tabIndex={-1}>
            元に戻す
          </button>
        </div>
        {/* 知らせのトースト（#87。説明文として折り返す・[閉じる]） */}
        <div class="toast note gal-static">
          <p class="txt">
            URL のポジションを新しいタブで開いた（足 3 本。共有 2026-11-02 21:47、そのときの板
            2026-11-02 21:31）。建値は共有時のまま。シナリオ・手数料・先物の basis は今のまま（URL
            の値は使わない）
          </p>
          <button type="button" tabIndex={-1}>
            閉じる
          </button>
        </div>
        <div class="toast note warn gal-static">
          <p class="txt">URL が長すぎて読まない。作業は変えていない</p>
          <button type="button" tabIndex={-1}>
            閉じる
          </button>
        </div>
        {/* ログイン切れ（#341。[ページを読み直す] と [閉じる] の 2 つ。360px でボタンが折り返さない） */}
        <div class="toast note warn gal-static">
          <p class="txt">{`${AUTH_EXPIRED_TEXT}。前の板のまま（取得 21:47）`}</p>
          <button type="button" tabIndex={-1}>
            {RELOAD_PAGE_LABEL}
          </button>
          <button type="button" tabIndex={-1}>
            閉じる
          </button>
        </div>
      </section>

      <Dialog open={dialog} title="ダイアログの見本" onClose={() => setDialog(false)}>
        <p class="gal-note">
          Esc か [×] で閉じ、開く前のボタンへフォーカスが戻る。中身だけスクロールする。
        </p>
      </Dialog>
      <ToastSlot host={toastHost} />
    </main>
  );
}

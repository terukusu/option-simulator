import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  AiRequestError,
  type AiStatus,
  getAiStatus,
  postReadPositions,
  type ReadProduct,
} from '../../../data';
import type { AppController } from '../../components/useAppController';
import { disposeImage, type EncodedImage, latestPicker } from '../../imageEncode';
import type { State } from '../../state';
import { parseNum } from '../../view/format';
import { sizeText } from '../../view/imageScale';
import { newTabUndoActions } from '../../view/newTab';
import {
  editRow,
  HUGE_TEXT,
  IMPORT_NEW_TAB_UNDO_TEXT,
  IMPORT_NOTICE,
  IMPORT_TITLE,
  type ImportField,
  type ImportRow,
  importPlan,
  initialRows,
  MARK_TEXT,
  NOT_IMAGE_TEXT,
  NOT_POSITIONS_TEXT,
  PRODUCT_LABELS,
  PRODUCT_ORDER,
  READING_TEXT,
  readBlocked,
  readBlockedReload,
  readErrorText,
  readReload,
  rowView,
  TOO_LARGE_TEXT,
} from '../../view/positionImport';
import type { ToastInput } from '../../view/toast';
import { Dialog } from '../parts/Dialog';
import { ReloadButton } from '../parts/ReloadButton';
import { focusIfLost } from '../useGlobalKeys';

interface Props {
  open: boolean;
  onClose: () => void;
  c: AppController;
  /** 押した時点の state（[新しいタブに入れる]・[元に戻す] の判定） */
  getState: () => State;
  push: (t: ToastInput) => void;
  /** AI の中継の口（`/api/ai`。dev の合成の板は `/fixtures/ai`） */
  base: string;
}

type StatusView = AiStatus | null | { error: string };
/** 読み取りの知らせ（reload = [ページを読み直す] を出す。#341） */
interface ImportMsg {
  text: string;
  reload: boolean;
}

/** 確認表の欄の読み上げ名 */
const FIELD_LABEL: Readonly<Record<ImportField, string>> = {
  product: '商品',
  expiry: '限月',
  type: 'C / P',
  k: '行使価格',
  side: '売買',
  qty: '枚数',
  entry: '建値',
  openedOn: '建てた日',
};

/** プレビューの最大（CSS の px。描画は devicePixelRatio 倍） */
const PREVIEW_MAX_W = 320;
const PREVIEW_MAX_H = 220;

/**
 * 画像から建玉を読み取る（#318・docs/design.md 14 章「画像から建玉を読み取る」・docs/adr-0009）: 段 1 = 画像を選ぶ
 * （PC は貼り付けも可）→ canvas のプレビュー・送る大きさ → 送る前の注意（[読み取る] の直上に常に見える）→ [読み取る]
 * （押したときだけ送る）、段 2 = 確認表（全部の欄を直せる・行ごとに [外す]・印）→ 「保有の印を付ける」→
 * [新しいタブに入れる]。画像・結果はこのダイアログのメモリだけ（閉じたら捨てる。保存しない）。表示モデルは
 * ui/view/positionImport.ts・ui/view/imageScale.ts、作り直しは ui/imageEncode.ts、送信は data/aiReadPositions.ts。
 */
export function PositionImportDialog(p: Props) {
  if (!p.open) return null;
  return <ImportBody {...p} />;
}

function ImportBody(p: Props) {
  const { c } = p;
  const { state } = c;
  const chain = state.chain;
  const holidays = state.calendar.holidays;
  const [status, setStatus] = useState<StatusView>(null);
  const [image, setImage] = useState<EncodedImage | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [reading, setReading] = useState(false);
  // 知らせ（reload = [ページを読み直す] を出す。#341）
  const [msg, setMsg] = useState<ImportMsg | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [held, setHeld] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const imageRef = useRef<EncodedImage | null>(null);
  imageRef.current = image;
  // 最後に選んだ画像だけを採る（作り直しの途中の古い結果は捨てる。#318 レビュー S2）
  const picker = useRef(latestPicker()).current;

  // 開いたら AI の状態を読む（押せる / 押せないの判定）。閉じたら読み取りを待つのをやめ、画像を捨てる
  useEffect(() => {
    alive.current = true;
    getAiStatus(fetch, `${p.base}/status`)
      .then((s) => alive.current && setStatus(s))
      .catch(
        (e) =>
          alive.current &&
          setStatus({ error: e instanceof AiRequestError ? e.code : 'unavailable' }),
      );
    return () => {
      alive.current = false;
      picker.cancel();
      abort.current?.abort();
      disposeImage(imageRef.current);
    };
  }, [p.base]);

  const pick = async (file: Blob | null | undefined) => {
    if (!file || reading) return;
    setMsg(null);
    setEncoding(true);
    let out: Awaited<ReturnType<typeof picker.pick>> | null = null;
    try {
      out = await picker.pick(file);
      if (!alive.current) {
        if (out.kind === 'ok') disposeImage(out.image);
        return;
      }
      if (out.kind === 'stale') return; // もっと新しい選択が作り直し中
      disposeImage(imageRef.current);
      if (out.kind === 'error') {
        setImage(null);
        setMsg({
          text:
            out.error === 'too_large'
              ? TOO_LARGE_TEXT
              : out.error === 'huge'
                ? HUGE_TEXT
                : NOT_IMAGE_TEXT,
          reload: false,
        });
        return;
      }
      setImage(out.image);
    } finally {
      // 古い選択（stale）は新しい選択が「作り直し中」を持つので下ろさない
      if (alive.current && out?.kind !== 'stale') setEncoding(false);
    }
  };

  // PC の貼り付け（画像を選ぶ段だけ）
  useEffect(() => {
    if (rows !== null) return;
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith('image/'),
      );
      if (!item) return;
      e.preventDefault();
      void pick(item.getAsFile());
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  const blocked = readBlocked({
    hasChain: chain !== null,
    status,
    hasImage: image !== null,
    reading: reading || encoding,
  });

  const read = async () => {
    if (!image || blocked !== null || !chain) return;
    setMsg(null);
    setReading(true);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const res = await postReadPositions(
        { schema_version: 1, image: { media_type: image.mediaType, data: image.base64 } },
        ctl.signal,
        fetch,
        `${p.base}/read_positions`,
      );
      if (!alive.current) return;
      if (res.kind === 'not_positions') {
        setMsg({ text: NOT_POSITIONS_TEXT, reload: false });
        return;
      }
      setRows(initialRows(res, chain, holidays));
    } catch (e) {
      if (!alive.current) return;
      if (ctl.signal.aborted) setMsg({ text: readErrorText('aborted'), reload: false });
      else if (e instanceof AiRequestError) {
        setMsg({ text: readErrorText(e.code, e.remainingUsd), reload: readReload(e.code) });
      } else setMsg({ text: readErrorText('unavailable'), reload: false });
    } finally {
      if (alive.current) setReading(false);
      abort.current = null;
    }
  };

  return (
    <Dialog open title={IMPORT_TITLE} class="import" onClose={p.onClose}>
      {rows === null ? (
        <PickStep
          image={image}
          encoding={encoding}
          reading={reading}
          blocked={blocked}
          blockedReload={readBlockedReload({ hasChain: chain !== null, status })}
          msg={msg}
          onPick={pick}
          onRead={read}
          onAbort={() => abort.current?.abort()}
        />
      ) : (
        <ConfirmStep
          {...p}
          rows={rows}
          setRows={setRows}
          held={held}
          setHeld={setHeld}
          onBack={() => setRows(null)}
        />
      )}
    </Dialog>
  );
}

function PickStep(p: {
  image: EncodedImage | null;
  encoding: boolean;
  reading: boolean;
  blocked: string | null;
  blockedReload: boolean;
  msg: ImportMsg | null;
  onPick: (f: Blob | null | undefined) => void;
  onRead: () => void;
  onAbort: () => void;
}) {
  const { image } = p;
  const canvas = useRef<HTMLCanvasElement>(null);
  // プレビュー: 送るものと同じ画像を canvas に描く（<img src=blob:> を使わない = CSP の img-src を変えない）
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el || !image) return;
    const s = Math.min(1, PREVIEW_MAX_W / image.width, PREVIEW_MAX_H / image.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = Math.max(1, Math.round(image.width * s * dpr));
    el.height = Math.max(1, Math.round(image.height * s * dpr));
    el.getContext('2d')?.drawImage(image.preview, 0, 0, el.width, el.height);
  }, [image]);
  return (
    <section class="imp-pick" aria-label="画像を選ぶ">
      <div class="imp-file-row">
        <label class={p.reading || p.encoding ? 'btn imp-file disabled' : 'btn imp-file'}>
          <input
            type="file"
            class="imp-input"
            accept="image/png,image/jpeg,image/webp"
            disabled={p.reading || p.encoding}
            onChange={(e) => {
              const input = e.currentTarget;
              void p.onPick(input.files?.[0]);
              // 同じファイルを選び直せるように（値は持たない）
              input.value = '';
            }}
          />
          <span>{image ? '画像を選び直す' : '画像を選ぶ'}</span>
        </label>
        <span class="imp-hint">PC は画像の貼り付けでも選べる</span>
      </div>
      {p.encoding && (
        <p class="imp-status" role="status">
          画像を作り直しています…
        </p>
      )}
      {image && (
        <figure class="imp-preview">
          <canvas ref={canvas} class="imp-canvas" aria-label="送る画像のプレビュー" />
          <figcaption class="imp-meta">
            <span>
              送る画像 {image.width}×{image.height}
            </span>
            <span>
              {sizeText(image.bytes)}・{image.mediaType === 'image/png' ? 'PNG' : 'JPEG'}
            </span>
          </figcaption>
        </figure>
      )}
      <ul class="imp-notice" aria-label="送る前の注意">
        {IMPORT_NOTICE.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <div class="imp-acts">
        {p.reading && (
          <>
            <span class="imp-status" role="status">
              {READING_TEXT}
            </span>
            <button type="button" class="btn" data-act="abort" onClick={p.onAbort}>
              中止
            </button>
          </>
        )}
        <button
          type="button"
          class="btn primary"
          data-act="read"
          disabled={p.blocked !== null}
          title={p.blocked ?? undefined}
          onClick={p.onRead}
        >
          読み取る
        </button>
      </div>
      {p.blocked !== null && !p.reading && image && (
        <p class="imp-why">
          {p.blocked}
          {p.blockedReload && <ReloadButton class="imp-reload" />}
        </p>
      )}
      {p.msg && (
        <p class="imp-msg" role="status">
          {p.msg.text}
          {p.msg.reload && <ReloadButton class="imp-reload" />}
        </p>
      )}
    </section>
  );
}

function ConfirmStep(
  p: Props & {
    rows: ImportRow[];
    setRows: (f: (rows: ImportRow[] | null) => ImportRow[] | null) => void;
    held: boolean;
    setHeld: (v: boolean) => void;
    onBack: () => void;
  },
) {
  const { c, rows } = p;
  const { state } = c;
  const chain = state.chain;
  const holidays = state.calendar.holidays;
  const views = useMemo(
    () => (chain ? rows.map((r) => rowView(r, chain, holidays)) : []),
    [rows, chain, holidays],
  );
  const plan = useMemo(
    () =>
      chain
        ? importPlan(rows, chain, holidays, state, p.held, c.atmBasis)
        : { ok: false as const, reasons: ['板がありません'] },
    [rows, chain, holidays, state, p.held, c.atmBasis],
  );
  if (!chain) return <p class="imp-msg">板がありません（板を読んでから）</p>;

  const set = (key: number, patch: Parameters<typeof editRow>[1]) =>
    p.setRows((rs) =>
      (rs ?? []).map((r) => {
        if (r.key !== key) return r;
        const before = rowView(r, chain, holidays).excluded;
        const next = editRow(r, patch);
        // 対象外・SQ 済みから直して入れられる行になったら入れる側に
        if (before !== null && rowView(next, chain, holidays).excluded === null)
          next.include = true;
        return next;
      }),
    );
  const num = (v: string): number | null => (v.trim() === '' ? null : parseNum(v));
  const str = (v: string): string | null => (v.trim() === '' ? null : v.trim());

  const apply = () => {
    if (!plan.ok) return;
    const st = p.getState();
    const fresh = chain ? importPlan(rows, chain, holidays, st, p.held, c.atmBasis) : plan;
    if (!fresh.ok) return;
    c.dispatch(fresh.action);
    p.onClose();
    // 新しいタブの最初の足の行へ（ダイアログを開いたボタンが消えていればフォーカスが落ちるので拾う）
    focusIfLost('section.positions li.leg .leg-main');
    const undo = fresh.undo;
    p.push({
      kind: 'position-import',
      text: fresh.text,
      keep: true,
      undo: () => {
        const acts = newTabUndoActions(p.getState(), undo);
        if (typeof acts === 'string') {
          p.push({ kind: 'position-import', text: IMPORT_NEW_TAB_UNDO_TEXT[acts], note: 'info' });
          return;
        }
        for (const a of acts) c.dispatch(a);
      },
    });
    // IV 仮の行（板に無い限月の OP）は入れた後の足の印に残らないので、どの行を確かめるかを [閉じる] まで出す（#318 レビュー S1）
    if (fresh.ivNote) p.push({ kind: 'position-import-iv', text: fresh.ivNote, note: 'warn' });
  };

  const taken = rows.filter((r, i) => r.include && views[i]?.excluded === null).length;
  return (
    <section class="imp-confirm" aria-label="確認表">
      <p class="imp-lead">
        読み取った {rows.length} 行（入れる {taken}{' '}
        行）。証券会社の画面と見比べて、違う欄は直してください。
      </p>
      <div class="imp-table-wrap">
        <table class="imp-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">商品</th>
              <th scope="col">限月</th>
              <th scope="col">C/P</th>
              <th scope="col">行使価格</th>
              <th scope="col">売買</th>
              <th scope="col">枚数</th>
              <th scope="col">建値</th>
              <th scope="col">建てた日</th>
              <th scope="col">
                <span class="sr">外す</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const v = views[i];
              if (!v) return null;
              const off = !r.include || v.excluded !== null;
              const bad = new Set(v.errors.map((e) => e.field));
              const opt = r.product === 'op_large';
              const cell = (f: ImportField) => ({
                'aria-label': `${r.key} 行目の${FIELD_LABEL[f]}`,
                'aria-invalid': bad.has(f) ? ('true' as const) : undefined,
                'data-unread': r.unreadable.includes(f) ? '' : undefined,
              });
              return (
                <tr key={r.key} class={off ? 'off' : undefined} data-row={r.key}>
                  <th scope="row" class="imp-no">
                    <span class="n">{r.key}</span>
                    {r.unreadable.length > 0 && (
                      <span class="tag warn">{MARK_TEXT.unreadable}</span>
                    )}
                    {r.yearFilled && <span class="tag warn">{MARK_TEXT.yearFilled}</span>}
                    {v.ivProvisional && <span class="tag warn">{MARK_TEXT.ivProvisional}</span>}
                    {v.excluded === 'unknown' && <span class="tag">{MARK_TEXT.unknown}</span>}
                    {v.excluded === 'sq_done' && <span class="tag">{MARK_TEXT.sqDone}</span>}
                  </th>
                  <td>
                    <select
                      class="imp-in"
                      {...cell('product')}
                      value={r.product}
                      onChange={(e) =>
                        set(r.key, { product: e.currentTarget.value as ReadProduct })
                      }
                    >
                      {PRODUCT_ORDER.map((x) => (
                        <option key={x} value={x}>
                          {PRODUCT_LABELS[x]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="month"
                      class="imp-in month"
                      {...cell('expiry')}
                      value={r.expiry ?? ''}
                      onChange={(e) => set(r.key, { expiry: str(e.currentTarget.value) })}
                    />
                  </td>
                  <td>
                    <select
                      class="imp-in cp"
                      {...cell('type')}
                      disabled={!opt}
                      value={r.type ?? ''}
                      onChange={(e) => {
                        const t = e.currentTarget.value;
                        set(r.key, { type: t === 'C' || t === 'P' ? t : null });
                      }}
                    >
                      <option value="">—</option>
                      <option value="C">C</option>
                      <option value="P">P</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="numeric"
                      class="imp-in k"
                      {...cell('k')}
                      disabled={!opt}
                      key={`k-${r.key}-${r.product}`}
                      defaultValue={r.k === null ? '' : String(r.k)}
                      onChange={(e) => set(r.key, { k: num(e.currentTarget.value) })}
                    />
                  </td>
                  <td>
                    <select
                      class="imp-in side"
                      {...cell('side')}
                      value={r.side ?? ''}
                      onChange={(e) => {
                        const s = e.currentTarget.value;
                        set(r.key, { side: s === 'buy' || s === 'sell' ? s : null });
                      }}
                    >
                      <option value="">—</option>
                      <option value="sell">売</option>
                      <option value="buy">買</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="numeric"
                      class="imp-in qty"
                      {...cell('qty')}
                      defaultValue={r.qty === null ? '' : String(r.qty)}
                      onChange={(e) => set(r.key, { qty: num(e.currentTarget.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      class="imp-in entry"
                      {...cell('entry')}
                      defaultValue={r.entry === null ? '' : String(r.entry)}
                      onChange={(e) => set(r.key, { entry: num(e.currentTarget.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="date"
                      class="imp-in date"
                      {...cell('openedOn')}
                      value={r.openedOn ?? ''}
                      onChange={(e) => set(r.key, { openedOn: str(e.currentTarget.value) })}
                    />
                  </td>
                  <td>
                    {v.excluded === null && (
                      <button
                        type="button"
                        class="btn sm"
                        aria-label={`${r.key} 行目を${r.include ? '外す' : '戻す'}`}
                        onClick={() => set(r.key, { include: !r.include })}
                      >
                        {r.include ? '外す' : '戻す'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!plan.ok && (
        <ul class="imp-why" aria-label="入れられない理由">
          {plan.reasons.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <label class="imp-held">
        <input
          type="checkbox"
          checked={p.held}
          onChange={(e) => p.setHeld(e.currentTarget.checked)}
        />
        <span>保有の印を付ける</span>
      </label>
      <div class="imp-acts">
        <button type="button" class="btn" data-act="back" onClick={p.onBack}>
          画像を選び直す
        </button>
        <button
          type="button"
          class="btn primary"
          data-act="apply"
          disabled={!plan.ok}
          title={plan.ok ? undefined : plan.reasons[0]}
          onClick={apply}
        >
          新しいタブに入れる
        </button>
      </div>
    </section>
  );
}

import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { NAME_MAX } from '../book';
import type { BookMessage } from '../components/useAppController';
import { PINS_FULL_TEXT } from '../pins';
import {
  type BookConfirm,
  type BookListView,
  type BookRowView,
  CONFIRM_LABEL,
  confirmText,
  requestOpen,
} from '../view/bookList';
import { MARK_BASIS_TEXT } from '../view/mark';
import { TABS_FULL_TEXT } from '../view/tabs';
import { Dialog } from './parts/Dialog';
import { Icon } from './parts/Icon';
import { Popover } from './parts/Popover';

export interface BookDialogProps {
  open: boolean;
  /** 表示モデル（c.bookView。開いている間だけ作られる） */
  view: BookListView | null;
  legCount: number;
  hasBoard: boolean;
  defaultName: string;
  message: BookMessage | null;
  onClose: () => void;
  onSave: (name: string) => boolean;
  onOpen: (id: string) => boolean;
  onOpenNewTab: (id: string) => boolean;
  canAddTab: boolean;
  onOverlay: (id: string) => boolean;
  canPin: boolean;
  tabName: string;
  /** 上書き（#87 (C): 確認なしで即実行。結果は [元に戻す] 付きのトースト = NextApp） */
  onOverwrite: (id: string) => void;
  onDuplicate: (id: string) => boolean;
  onRename: (id: string, name: string) => boolean;
  onRemove: (id: string) => boolean;
  onClear: () => boolean;
  onExport: () => void;
  onImport: (file: File) => void;
  /** 開いている間のトースト（モーダルの外は押せないので、ダイアログの中に描く） */
  toasts: ComponentChildren;
  /** 開いたら名前の欄へフォーカス（タブのメニューの 保存一覧に保存…） */
  focusName: boolean;
}

const NO_BOARD_OPEN = '板が無いので開けない（板を読むと開ける）';
const NO_BOARD_PIN = '板が無いので重ねられない（板を読むと重ねられる）';
const PIN_TITLE = '今の板・今のシナリオ・今の設定で損益グラフに線を重ねる（ピン）';

/**
 * 保存一覧のダイアログ（#87 (C)。docs/ui-redesign.md §3・§4.5。旧画面の保存一覧（#91 で削除）の項目・文・条件を写した）。
 * 表示モデルは ui/view/bookList.ts のまま（c.bookView）。変えたのは [上書き] だけ（確認なしで即実行 + [元に戻す]）。
 * 削除・未保存の作業がある [開く]・[空にする…] は今と同じ行の中の確認。名前は JSX のテキスト / 属性だけ。
 */
export function BookDialog(p: BookDialogProps) {
  return (
    <Dialog
      open={p.open && p.view !== null}
      title="保存したポジション"
      class="book"
      onClose={p.onClose}
      head={
        <Popover label="保存したポジション" button={<Icon name="info" />}>
          <p>
            この端末（ブラウザ）にだけ保存する。別の端末へは [書き出し] / [読み込み…]。評価損益 =
            保存した建値のまま{MARK_BASIS_TEXT}で評価し、その項目の手数料（1 枚あたり ×
            枚数）を引く。 Δ・満期の最大損失は今の板で計算。
          </p>
          <p>
            [開く] は作業中のタブの足と、シナリオ・手数料・先物の
            basis（全タブ共通）を置き換える（表示の設定は今のまま）。 [新しいタブで開く]
            は作業中のタブを残してタブを足す。[重ねる]
            は損益グラフにピン（今の板・今のシナリオ・今の設定で描く線）として重ねる（最大 3
            本・保存しない）。 保存・上書きは作業中のタブ（{p.tabName}）を保存する。[上書き]
            はすぐ書き、トーストの [元に戻す] で戻せる。
          </p>
        </Popover>
      }
      after={p.toasts}
    >
      {p.view && <BookBody {...p} view={p.view} />}
    </Dialog>
  );
}

function BookBody(props: BookDialogProps & { view: BookListView }) {
  const { view, legCount, message, hasBoard, canAddTab, canPin, tabName } = props;
  const [name, setName] = useState(props.defaultName);
  const [confirm, setConfirm] = useState<BookConfirm | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const renamingId = renaming?.id ?? null;

  // タブのメニューの 保存一覧に保存… から開いたら名前の欄へ（showModal の後 = useEffect）
  const { focusName } = props;
  useEffect(() => {
    if (!focusName) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);
  // 名前の変更の欄を出したら欄へ
  useLayoutEffect(() => {
    if (renamingId === null) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [renamingId]);

  const readonly = view.state === 'newer' || view.state === 'invalid';
  const canSave = !readonly && legCount > 0;
  const done = (ok: boolean) => {
    if (ok) {
      setConfirm(null);
      setRenaming(null);
    }
  };
  const ask = (c: BookConfirm) => {
    setRenaming(null);
    setConfirm(c);
  };
  const reset = () => {
    setConfirm(null);
    setRenaming(null);
  };
  const save = () => {
    reset();
    props.onSave(name);
  };
  const open = (row: BookRowView) => {
    const next = requestOpen(view.unsaved, row.id, view.held);
    if (next === 'open') done(props.onOpen(row.id));
    else ask(next);
  };
  const confirmed = (c: BookConfirm) => {
    if (c.kind === 'open') {
      if (hasBoard) done(props.onOpen(c.id));
    } else if (c.kind === 'overwrite') {
      reset();
      props.onOverwrite(c.id);
    } else if (c.kind === 'remove') done(props.onRemove(c.id));
    else done(props.onClear());
  };
  const commitRename = () => {
    if (renaming) done(props.onRename(renaming.id, renaming.draft));
  };

  const confirmRow = (c: BookConfirm, rowName: string) => (
    <div class="bk-confirm" role="alert">
      <p>{confirmText(c, rowName, legCount, tabName)}</p>
      <span class="bk-ops">
        <button type="button" class="btn sm danger" onClick={() => confirmed(c)}>
          {CONFIRM_LABEL[c.kind]}
        </button>
        <button type="button" class="btn sm" onClick={() => setConfirm(null)}>
          やめる
        </button>
      </span>
    </div>
  );

  return (
    <div class="bk">
      {message && (
        <p class={message.warn ? 'bk-msg warn' : 'bk-msg'} role="status">
          {message.text}
        </p>
      )}
      {view.state === 'invalid' && (
        <div class="bk-state">
          <p class="warn">
            保存一覧を読めない（保存の形式が壊れている）。保存されている内容はそのまま残している。
          </p>
          {confirm?.kind === 'clear' ? (
            confirmRow(confirm, '')
          ) : (
            <button type="button" class="btn sm" onClick={() => ask({ kind: 'clear' })}>
              空にする…
            </button>
          )}
        </div>
      )}
      {view.state === 'newer' && (
        <p class="warn bk-state">
          新しい版の画面で保存した一覧は、この画面では読めない（変更もしない）。画面を新しくする。
        </p>
      )}
      {view.nearFull && (
        <p class="warn bk-state">
          保存一覧の残りが少ない（不要な項目を削除するか、書き出して整理する）。
        </p>
      )}

      <div class="bk-save">
        <label class="bk-name-field">
          <span class="bk-lbl">名前</span>
          <input
            class="bk-input"
            ref={nameRef}
            value={name}
            maxLength={NAME_MAX}
            disabled={!canSave}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (canSave) save();
              }
            }}
          />
        </label>
        <button type="button" class="btn sm primary" disabled={!canSave} onClick={save}>
          保存
        </button>
      </div>
      <div class="bk-line">
        <span class="bk-dim">作業中のタブ {tabName}</span>
        {legCount === 0 && <span class="bk-dim">足が無い（足を追加すると保存できる）</span>}
      </div>

      <div class="bk-io">
        <button
          type="button"
          class="btn sm"
          disabled={view.state !== 'ok'}
          title="保存一覧を JSON のファイルに書き出す"
          onClick={() => props.onExport()}
        >
          書き出し
        </button>
        <label
          class={readonly ? 'btn sm bk-file disabled' : 'btn sm bk-file'}
          title="書き出した JSON を読み込んで追加する"
        >
          <span>読み込み…</span>
          <input
            type="file"
            class="sr"
            accept=".json,application/json"
            disabled={readonly}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.click();
              }
            }}
            onChange={(e) => {
              const input = e.currentTarget;
              const file = input.files?.[0];
              if (file) props.onImport(file);
              input.value = '';
            }}
          />
        </label>
        {view.sizeText && <span class="bk-dim">{view.sizeText}</span>}
      </div>

      <p class="bk-note">
        {view.boardText
          ? `評価損益・最大損失・Δ は今の板（${view.boardText}）で計算。金額の単位: ${view.unitLabel}`
          : '板が無い（評価損益・最大損失・Δ は板を読むと出る。[開く] も板を読んでから）'}
      </p>

      {view.rows.length === 0 ? (
        view.state === 'empty' || view.state === 'ok' ? (
          <p class="bk-note">保存したポジションは無い。名前を付けて [保存] する。</p>
        ) : null
      ) : (
        <ul class="bk-list">
          {view.rows.map((row) => {
            const rowConfirm =
              confirm && confirm.kind !== 'clear' && confirm.id === row.id ? confirm : null;
            const isRenaming = renaming?.id === row.id;
            const ok = row.status === 'ok';
            return (
              <li
                key={row.id}
                class={!ok ? 'bk-row bad' : row.current ? 'bk-row current' : 'bk-row'}
              >
                {isRenaming ? (
                  <span class="bk-rename">
                    <input
                      class="bk-input"
                      ref={renameRef}
                      aria-label="新しい名前"
                      value={renaming.draft}
                      maxLength={NAME_MAX}
                      onInput={(e) => setRenaming({ id: row.id, draft: e.currentTarget.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === 'Escape') {
                          // ダイアログは閉じず、名前の入力だけやめる
                          e.preventDefault();
                          e.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                    />
                    <button type="button" class="btn sm" onClick={commitRename}>
                      決定
                    </button>
                    <button type="button" class="btn sm" onClick={() => setRenaming(null)}>
                      やめる
                    </button>
                  </span>
                ) : ok ? (
                  <div class="bk-head">
                    <strong class="bk-name" title={row.name}>
                      {row.name}
                    </strong>
                    {row.tags.map((t) => (
                      <span class={t.warn ? 'tag warn' : 'tag'} key={t.text}>
                        {t.text}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p class="bk-bad warn">{row.name}</p>
                )}
                {ok && (
                  <div class="bk-sum">
                    <span>
                      {row.months}・{row.legs}
                    </span>
                    <span>
                      {row.premiumLabel} {row.premiumText}
                    </span>
                    <span>満期の最大損失 {row.maxLossText}</span>
                    <span>Δ {row.deltaText}</span>
                    <span>
                      評価損益 <strong>{row.markText}</strong>
                    </span>
                    {row.markNote && <span class="bk-dim">（{row.markNote}）</span>}
                    {row.note && <span class="bk-dim">{row.note}</span>}
                  </div>
                )}
                <div class="bk-times">
                  <span>保存 {row.savedText}</span>
                  {ok && <span>保存時の板 {row.boardText}</span>}
                </div>
                {rowConfirm ? (
                  confirmRow(rowConfirm, ok ? row.name : 'この項目')
                ) : (
                  <div class="bk-ops">
                    {ok && (
                      <>
                        <button
                          type="button"
                          class="btn sm"
                          aria-label={`${row.name} を開く`}
                          disabled={readonly || !hasBoard}
                          title={hasBoard ? undefined : NO_BOARD_OPEN}
                          onClick={() => open(row)}
                        >
                          開く
                        </button>
                        <button
                          type="button"
                          class="btn sm"
                          aria-label={`${row.name} を新しいタブで開く`}
                          disabled={readonly || !hasBoard || !canAddTab}
                          title={!hasBoard ? NO_BOARD_OPEN : canAddTab ? undefined : TABS_FULL_TEXT}
                          onClick={() => {
                            reset();
                            props.onOpenNewTab(row.id);
                          }}
                        >
                          新しいタブで開く
                        </button>
                        <button
                          type="button"
                          class="btn sm"
                          aria-label={`${row.name} を損益グラフに重ねる`}
                          disabled={readonly || !hasBoard || !canPin}
                          title={!hasBoard ? NO_BOARD_PIN : canPin ? PIN_TITLE : PINS_FULL_TEXT}
                          onClick={() => {
                            reset();
                            props.onOverlay(row.id);
                          }}
                        >
                          重ねる
                        </button>
                        <button
                          type="button"
                          class="btn sm"
                          aria-label={`${row.name} を作業中の内容で上書き`}
                          disabled={readonly || legCount === 0}
                          onClick={() => confirmed({ kind: 'overwrite', id: row.id })}
                        >
                          上書き
                        </button>
                        <button
                          type="button"
                          class="btn sm"
                          aria-label={`${row.name} を複製`}
                          disabled={readonly}
                          onClick={() => {
                            reset();
                            props.onDuplicate(row.id);
                          }}
                        >
                          複製
                        </button>
                        <button
                          type="button"
                          class="btn sm"
                          aria-label={`${row.name} の名前を変える`}
                          disabled={readonly}
                          onClick={() => {
                            setConfirm(null);
                            setRenaming({ id: row.id, draft: row.name });
                          }}
                        >
                          名前
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      class="btn sm"
                      aria-label={ok ? `${row.name} を削除` : 'この項目を削除'}
                      disabled={readonly}
                      onClick={() => ask({ kind: 'remove', id: row.id })}
                    >
                      削除
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

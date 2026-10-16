import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { NAME_MAX } from '../book';
import {
  type BookConfirm,
  type BookListView,
  type BookRowView,
  CONFIRM_LABEL,
  confirmText,
  MARK_BASIS_TEXT,
  requestOpen,
} from '../view/bookList';
import { TABS_FULL_TEXT } from '../view/tabs';
import { Hint } from './Hint';

export interface BookMessage {
  text: string;
  warn: boolean;
}

export interface BookProps {
  view: BookListView;
  /** 作業中の足の本数 */
  legCount: number;
  /** 板があるか（無ければ [開く] を押せない。足の市場を板から作るため） */
  hasBoard: boolean;
  /** 保存の名前の初期値（既定名） */
  defaultName: string;
  message: BookMessage | null;
  onClose: () => void;
  /** 各操作は成功したら true（確認・名前の入力を閉じる） */
  onSave: (name: string) => boolean;
  onOpen: (id: string) => boolean;
  /** 新しいタブで開く（#71。作業中のタブは残す。確認しない） */
  onOpenNewTab: (id: string) => boolean;
  /** タブを足せる（上限未満） */
  canAddTab: boolean;
  /** 作業中のタブの名前（[開く] の確認の文言・保存の説明） */
  tabName: string;
  onOverwrite: (id: string) => boolean;
  onDuplicate: (id: string) => boolean;
  onRename: (id: string, name: string) => boolean;
  onRemove: (id: string) => boolean;
  onClear: () => boolean;
  onExport: () => void;
  onImport: (file: File) => void;
}

/**
 * 保存したポジションの一覧（保存一覧・ポジ帳）のダイアログ（#70。設計 6.1）。表示モデル（ui/view/bookList.ts）を描くだけ。名前は JSX のテキストで入れる
 * （HTML 文字列を DOM に入れない）。モーダルの <dialog>（Esc・[閉じる] で閉じ、閉じたら開く前のボタンへフォーカスを戻す）。
 * 確認はブラウザの confirm() を使わず、その行の中に出す（1 つだけ。別の操作で消える）。
 */
/** [保存一覧（N）] のボタン（ポジションの見出しと topbar の 2 か所。N = 項目数。読めない・新しい版なら件数なし）。 */
export function BookButton({ count, onOpen }: { count: number | null; onOpen: () => void }) {
  return (
    <button type="button" class="book-open" aria-haspopup="dialog" onClick={onOpen}>
      {count === null ? '保存一覧' : `保存一覧（${count}）`}
    </button>
  );
}

export function Book(props: BookProps) {
  const { view, legCount, message, hasBoard, canAddTab, tabName } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [name, setName] = useState(props.defaultName);
  const [confirm, setConfirm] = useState<BookConfirm | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const renamingId = renaming?.id ?? null;

  // 開いたら showModal、閉じる（アンマウント）ときは開く前にフォーカスのあった要素へ戻す
  useLayoutEffect(() => {
    const dlg = ref.current;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dlg && !dlg.open) dlg.showModal();
    return () => {
      if (dlg?.open) dlg.close();
      prev?.focus();
    };
  }, []);

  // 名前の入力を出したら入力欄へ
  useLayoutEffect(() => {
    if (renamingId === null) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [renamingId]);

  const readonly = view.state === 'newer' || view.state === 'invalid';
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
  const save = () => {
    setConfirm(null);
    setRenaming(null);
    props.onSave(name);
  };
  const open = (row: BookRowView) => {
    const next = requestOpen(view.unsaved, row.id);
    if (next === 'open') done(props.onOpen(row.id));
    else ask(next);
  };
  const confirmed = (c: BookConfirm) => {
    if (c.kind === 'open') {
      if (hasBoard) done(props.onOpen(c.id));
    } else if (c.kind === 'overwrite') done(props.onOverwrite(c.id));
    else if (c.kind === 'remove') done(props.onRemove(c.id));
    else done(props.onClear());
  };
  const commitRename = () => {
    if (renaming) done(props.onRename(renaming.id, renaming.draft));
  };

  const confirmRow = (c: BookConfirm, rowName: string) => (
    <div class="book-confirm" role="alert">
      <span>{confirmText(c, rowName, legCount, tabName)}</span>
      <span class="book-ops">
        <button type="button" class="danger" onClick={() => confirmed(c)}>
          {CONFIRM_LABEL[c.kind]}
        </button>
        <button type="button" onClick={() => setConfirm(null)}>
          やめる
        </button>
      </span>
    </div>
  );

  return (
    <dialog
      ref={ref}
      class="book"
      aria-labelledby={titleId}
      onClose={() => props.onClose()}
      onKeyDown={(e) => {
        // ⓘ の吹き出しが開いていれば Esc はそれだけを閉じる（ダイアログの cancel を止める。吹き出しは Hint の
        // document の keydown が閉じるので伝播は止めない）。開いていなければ既定どおりダイアログを閉じる
        if (e.key === 'Escape' && ref.current?.querySelector('.hint-pop:not([hidden])')) {
          e.preventDefault();
        }
      }}
    >
      <div class="book-head hint-host">
        <h2 id={titleId}>保存したポジション</h2>
        <Hint label="保存したポジション">
          この端末（ブラウザ）にだけ保存する。別の端末へは [書き出し] / [読み込み…]。 評価損益 =
          保存した建値のまま{MARK_BASIS_TEXT}で評価し、その項目の手数料（1 枚あたり × 枚数）を引く。
          Δ・満期の最大損失は今の板で計算。[開く] は作業中のタブの足と、シナリオ・手数料・先物の
          basis（全タブ共通）を置き換える（表示の設定は今のまま）。[新しいタブで開く]
          は作業中のタブを残してタブを足す。保存・上書きは作業中のタブ（{tabName}）を保存する。
        </Hint>
        <button type="button" class="book-close" onClick={() => ref.current?.close()}>
          閉じる
        </button>
      </div>

      {message && (
        <p class={message.warn ? 'note warn book-msg' : 'note book-msg'} role="status">
          {message.text}
        </p>
      )}
      {view.state === 'invalid' && (
        <div class="book-state">
          <p class="warn">
            保存一覧を読めない（保存の形式が壊れている）。保存されている内容はそのまま残している。
          </p>
          {confirm?.kind === 'clear' ? (
            confirmRow(confirm, '')
          ) : (
            <button type="button" onClick={() => ask({ kind: 'clear' })}>
              空にする…
            </button>
          )}
        </div>
      )}
      {view.state === 'newer' && (
        <p class="warn book-state">
          新しい版の画面で保存した一覧は、この画面では読めない（変更もしない）。画面を新しくする。
        </p>
      )}
      {view.nearFull && (
        <p class="warn book-state">
          保存一覧の残りが少ない（不要な項目を削除するか、書き出して整理する）。
        </p>
      )}

      <div class="book-save">
        <label>
          名前{' '}
          <input
            value={name}
            maxLength={NAME_MAX}
            disabled={readonly || legCount === 0}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!readonly && legCount > 0) save();
              }
            }}
          />
        </label>
        <button type="button" disabled={readonly || legCount === 0} onClick={save}>
          保存
        </button>
        <span class="note">作業中のタブ {tabName}</span>
        {legCount === 0 && <span class="note">足が無い（足を追加すると保存できる）</span>}
      </div>

      <div class="book-io">
        <button
          type="button"
          disabled={view.state !== 'ok'}
          title="保存一覧を JSON のファイルに書き出す"
          onClick={() => props.onExport()}
        >
          書き出し
        </button>
        <label
          class={readonly ? 'file-open disabled' : 'file-open'}
          title="書き出した JSON を読み込んで追加する"
        >
          読み込み…
          <input
            type="file"
            class="sr-only"
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
        {view.sizeText && <span class="note">{view.sizeText}</span>}
      </div>

      <p class="note">
        {view.boardText
          ? `評価損益・最大損失・Δ は今の板（${view.boardText}）で計算。金額の単位: ${view.unitLabel}`
          : '板が無い（評価損益・最大損失・Δ は板を読むと出る。[開く] も板を読んでから）'}
      </p>

      {view.rows.length === 0 ? (
        view.state === 'empty' || view.state === 'ok' ? (
          <p class="note">保存したポジションは無い。名前を付けて [保存] する。</p>
        ) : null
      ) : (
        <ul class="book-list">
          {view.rows.map((row) => {
            const rowConfirm =
              confirm && confirm.kind !== 'clear' && confirm.id === row.id ? confirm : null;
            const isRenaming = renaming?.id === row.id;
            return (
              <li
                key={row.id}
                class={
                  row.status !== 'ok'
                    ? 'book-row bad'
                    : row.current
                      ? 'book-row current'
                      : 'book-row'
                }
              >
                <div class="book-row-head">
                  {isRenaming ? (
                    <span class="book-rename">
                      <input
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
                      <button type="button" onClick={commitRename}>
                        決定
                      </button>
                      <button type="button" onClick={() => setRenaming(null)}>
                        やめる
                      </button>
                    </span>
                  ) : (
                    <strong class={row.status === 'ok' ? 'book-name' : 'book-name warn'}>
                      {row.name}
                    </strong>
                  )}
                  {row.tags.map((t) => (
                    <span class={t.warn ? 'tag warn' : 'tag'} key={t.text}>
                      {t.text}
                    </span>
                  ))}
                </div>
                {row.status === 'ok' && (
                  <div class="book-sum">
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
                      {row.markNote && <span class="note">（{row.markNote}）</span>}
                    </span>
                    {row.note && <span class="note">{row.note}</span>}
                  </div>
                )}
                <div class="note book-times">
                  保存 {row.savedText}
                  {row.status === 'ok' && `・保存時の板 ${row.boardText}`}
                </div>
                {rowConfirm ? (
                  confirmRow(rowConfirm, row.status === 'ok' ? row.name : 'この項目')
                ) : (
                  <div class="book-ops">
                    {row.status === 'ok' && (
                      <>
                        <button
                          type="button"
                          aria-label={`${row.name} を開く`}
                          disabled={readonly || !hasBoard}
                          title={hasBoard ? undefined : '板が無いので開けない（板を読むと開ける）'}
                          onClick={() => open(row)}
                        >
                          開く
                        </button>
                        <button
                          type="button"
                          aria-label={`${row.name} を新しいタブで開く`}
                          disabled={readonly || !hasBoard || !canAddTab}
                          title={
                            !hasBoard
                              ? '板が無いので開けない（板を読むと開ける）'
                              : canAddTab
                                ? undefined
                                : TABS_FULL_TEXT
                          }
                          onClick={() => {
                            setConfirm(null);
                            setRenaming(null);
                            props.onOpenNewTab(row.id);
                          }}
                        >
                          新しいタブで開く
                        </button>
                        <button
                          type="button"
                          aria-label={`${row.name} を作業中の内容で上書き`}
                          disabled={readonly || legCount === 0}
                          onClick={() => ask({ kind: 'overwrite', id: row.id })}
                        >
                          上書き
                        </button>
                        <button
                          type="button"
                          aria-label={`${row.name} を複製`}
                          disabled={readonly}
                          onClick={() => {
                            setConfirm(null);
                            setRenaming(null);
                            props.onDuplicate(row.id);
                          }}
                        >
                          複製
                        </button>
                        <button
                          type="button"
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
                      aria-label={row.status === 'ok' ? `${row.name} を削除` : 'この項目を削除'}
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
    </dialog>
  );
}

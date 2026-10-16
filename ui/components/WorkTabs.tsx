import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { type Action, sanitizeTabName, TAB_NAME_MAX } from '../state';
import { closeConfirmText, renameError, type TabsView, tabKeyTarget } from '../view/tabs';

export interface WorkTabsProps {
  view: TabsView;
  dispatch: (a: Action) => void;
  /** [保存一覧に保存…]: 保存一覧を開く（作業中のタブを名前を付けて保存する） */
  onSaveToBook: () => void;
}

type Menu = 'add' | 'more' | null;

/**
 * 作業中のポジションのタブの帯（BOX タブ。#71。設計 6.1）。損益グラフのドックの 1 行目に置く（sticky で上端に残る）。
 * 表示モデル（ui/view/tabs.ts）を描くだけ。名前は JSX のテキスト・属性で入れる（HTML 文字列を DOM に入れない）。
 * 確認・名前の入力はブラウザの prompt / confirm を使わず、帯の下の 1 行に出す。
 * キー操作は WAI-ARIA の tabs（←/→・Home/End、ロービング tabindex、自動アクティベーション）。
 */
export function WorkTabs({ view, dispatch, onSaveToBook }: WorkTabsProps) {
  const base = useId();
  const [menu, setMenu] = useState<Menu>(null);
  const [draft, setDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const focusNext = useRef<number | null>(null);
  const { active } = view;

  // 作業中のタブが変わったら操作の行を閉じる。キー操作で切り替えたら新しいタブへフォーカス
  useEffect(() => {
    setMenu(null);
    setConfirmClose(false);
    setNameError(null);
    if (focusNext.current === active.id) {
      buttons.current.get(active.id)?.focus();
      focusNext.current = null;
    }
  }, [active.id]);

  const toggle = (m: Exclude<Menu, null>) => {
    setConfirmClose(false);
    setNameError(null);
    if (m === 'more') setDraft(active.name);
    setMenu((cur) => (cur === m ? null : m));
  };

  const rename = () => {
    const error = renameError(view.tabs, active.id, draft);
    if (error !== null) {
      setNameError(error);
      return;
    }
    dispatch({ type: 'renameTab', id: active.id, name: sanitizeTabName(draft) });
    setMenu(null);
  };

  const close = () => {
    if (closeConfirmText(active.name, active.legCount) !== null && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    dispatch({ type: 'closeTab', id: active.id });
  };

  const confirm = confirmClose ? closeConfirmText(active.name, active.legCount) : null;

  return (
    <div class="work-tabs">
      <div class="work-tabs-bar">
        <div
          role="tablist"
          aria-label="作業中のポジション"
          class="work-tabs-list"
          onKeyDown={(e) => {
            const id = tabKeyTarget(
              view.tabs.map((t) => t.id),
              active.id,
              e.key,
            );
            if (id === null) return;
            e.preventDefault();
            if (id === active.id) return;
            focusNext.current = id;
            dispatch({ type: 'switchTab', id });
          }}
        >
          {view.tabs.map((t) => (
            <button
              type="button"
              role="tab"
              key={t.id}
              id={`${base}-tab-${t.id}`}
              ref={(el) => {
                if (el) buttons.current.set(t.id, el);
                else buttons.current.delete(t.id);
              }}
              class="work-tab"
              aria-selected={t.active}
              aria-label={t.label}
              title={t.label}
              tabIndex={t.active ? 0 : -1}
              onClick={() => dispatch({ type: 'switchTab', id: t.id })}
            >
              <span class="work-tab-name">{t.name}</span>
              {t.countText !== null && <span class="work-tab-count">{t.countText}</span>}
            </button>
          ))}
        </div>
        <button
          type="button"
          class="work-tab-add"
          aria-label="タブを足す"
          title={view.addTitle}
          disabled={!view.canAdd}
          aria-expanded={menu === 'add'}
          onClick={() => toggle('add')}
        >
          ＋
        </button>
        <button
          type="button"
          class="work-tab-more"
          aria-label={`タブ ${active.name} の操作`}
          title="名前の変更・保存・閉じる"
          aria-expanded={menu === 'more'}
          onClick={() => toggle('more')}
        >
          ⋯
        </button>
      </div>
      {menu === 'add' && (
        <div class="work-tabs-menu">
          <button
            type="button"
            disabled={!view.canAdd}
            onClick={() => dispatch({ type: 'addTab', mode: 'empty' })}
          >
            空のタブ
          </button>
          <button
            type="button"
            disabled={!view.canAdd}
            onClick={() => dispatch({ type: 'addTab', mode: 'copy' })}
          >
            このタブを複製
          </button>
          <button type="button" onClick={() => setMenu(null)}>
            やめる
          </button>
        </div>
      )}
      {menu === 'more' &&
        (confirm !== null ? (
          <div class="work-tabs-menu" role="alert">
            <span>{confirm}</span>
            <button type="button" class="danger" onClick={close}>
              閉じる
            </button>
            <button type="button" onClick={() => setConfirmClose(false)}>
              やめる
            </button>
          </div>
        ) : (
          <div class="work-tabs-menu">
            <label>
              名前{' '}
              <input
                value={draft}
                size={8}
                maxLength={TAB_NAME_MAX}
                aria-invalid={nameError !== null}
                onInput={(e) => {
                  setDraft(e.currentTarget.value);
                  setNameError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    rename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setMenu(null);
                  }
                }}
              />
            </label>
            <button type="button" onClick={rename}>
              名前を変える
            </button>
            <button
              type="button"
              disabled={active.legCount === 0}
              title={active.legCount === 0 ? '足が無い' : undefined}
              onClick={() => {
                setMenu(null);
                onSaveToBook();
              }}
            >
              保存一覧に保存…
            </button>
            {view.canClose && (
              <button type="button" onClick={close}>
                閉じる
              </button>
            )}
            {nameError && (
              <span class="field-error" role="alert">
                {nameError}
              </span>
            )}
          </div>
        ))}
    </div>
  );
}

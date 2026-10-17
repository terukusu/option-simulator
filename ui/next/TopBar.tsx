import { useLayoutEffect, useRef } from 'preact/hooks';
import { pure } from '../components/pure';
import type { ThemePref } from '../prefs';
import type { MarketPillModel } from '../view/marketPill';
import type { WarnTagKind, WarnTagsModel } from '../view/notices';
import type { Tier } from '../view/shell';
import { Menu, type MenuItem } from './parts/Menu';
import { MarketPill } from './top/MarketPill';
import { WarnTags } from './top/WarnTags';

const THEME_ITEMS: readonly { theme: ThemePref; label: string }[] = [
  { theme: 'auto', label: '端末に合わせる' },
  { theme: 'dark', label: 'ダーク' },
  { theme: 'light', label: 'ライト' },
];

export interface TopBarProps {
  pill: MarketPillModel;
  warn: WarnTagsModel | null;
  tier: Tier;
  loading: boolean;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  /** 今の板の名前（dev の合成の板の checked） */
  sourceLabel: string | null;
  /** dev サーバーが配る合成の板の名前（本番は空） */
  fixtures: readonly string[];
  onLatest: () => void;
  onFile: (file: File) => void;
  onFixture: (name: string) => void;
  onCloseNote: (kind: WarnTagKind) => void;
}

/**
 * トップバー（docs/ui-redesign.md §2.1。#87）: ブランド / 市場ピル / 警告のタグ / [最新] / テーマ / ⋯。
 * スマホはブランドとテーマのボタンを CSS で隠す（テーマは ⋯ にある）。BOX タブは #87 の (B) でブランドとピルの間に入る。
 * ⋯ はファイルを開く…（隠した file input をメニューの選択と同じイベントの中で click()）・（dev）合成の板・テーマ。
 * pure: 入力は NextApp の useMemo と参照の変わらない関数だけ（シナリオの操作で描き直さない）。
 */
function TopBarView(p: TopBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const latestRef = useRef<HTMLButtonElement>(null);
  // 警告のタグの最後の 1 つを閉じたら（タグごと消える）[最新] へフォーカスを移す
  const closingLast = useRef(false);
  const hasWarn = p.warn !== null;
  useLayoutEffect(() => {
    if (hasWarn || !closingLast.current) return;
    closingLast.current = false;
    latestRef.current?.focus();
  }, [hasWarn]);
  const { warn, onCloseNote } = p;
  const closeNote = (kind: WarnTagKind) => {
    closingLast.current = warn !== null && warn.tags.length === 1;
    onCloseNote(kind);
  };

  const theme = (sep: boolean): MenuItem[] =>
    THEME_ITEMS.map((t, i) => ({
      key: `theme-${t.theme}`,
      label: t.label,
      checked: p.theme === t.theme,
      sep: sep && i === 0,
      onSelect: () => p.onTheme(t.theme),
    }));
  const more: MenuItem[] = [
    { key: 'file', label: 'ファイルを開く…', onSelect: () => fileRef.current?.click() },
    ...p.fixtures.map((name, i) => ({
      key: `fixture-${name}`,
      label: `合成の板 ${name}`,
      checked: p.sourceLabel === name,
      sep: i === 0,
      onSelect: () => p.onFixture(name),
    })),
    ...theme(true),
  ];
  const themeItems = THEME_ITEMS.map((t) => ({
    key: t.theme,
    label: t.label,
    checked: p.theme === t.theme,
    onSelect: () => p.onTheme(t.theme),
  }));
  return (
    <header class="top">
      <h1 class="brand">OP Simulator</h1>
      <MarketPill m={p.pill} tier={p.tier} />
      {warn && <WarnTags m={warn} tier={p.tier} onClose={closeNote} />}
      <button
        type="button"
        class="btn sm"
        ref={latestRef}
        disabled={p.loading}
        title="API から板を読み直す"
        onClick={() => p.onLatest()}
      >
        最新
      </button>
      <span class="top-theme">
        <Menu label="テーマ" button="☾" items={themeItems} />
      </span>
      <Menu label="メニュー" button="⋯" items={more} />
      <input
        type="file"
        class="sr"
        ref={fileRef}
        tabIndex={-1}
        aria-hidden="true"
        accept="application/json,.json"
        onChange={(e) => {
          const input = e.currentTarget;
          const file = input.files?.[0];
          if (file) p.onFile(file);
          // 同じファイルをもう一度選べるように空にする（旧 Loader と同じ）
          input.value = '';
        }}
      />
    </header>
  );
}

export const TopBar = pure(TopBarView);

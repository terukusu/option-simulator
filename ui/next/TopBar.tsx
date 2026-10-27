import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { pure } from '../components/pure';
import type { ThemePref } from '../prefs';
import type { ShareMake } from '../share';
import type { Action } from '../state';
import type { ShareResult } from '../view/boxTabs';
import type { MarketPillModel } from '../view/marketPill';
import type { WarnTagKind, WarnTagsModel } from '../view/notices';
import type { Tier } from '../view/shell';
import type { TabsView } from '../view/tabs';
import { THEMES, type TopMenuKey, topMenuModel } from '../view/topMenu';
import { Menu } from './parts/Menu';
import { BoxTabs, toItems } from './top/BoxTabs';
import { MarketPill } from './top/MarketPill';
import { useShareCopy } from './top/useShareCopy';
import { WarnTags } from './top/WarnTags';

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
  /** BOX タブ（#87 (B)。c.tabsView: シナリオの操作では変わらない） */
  tabs: TabsView;
  dispatch: (a: Action) => void;
  onCloseTab: (id: number) => void;
  /** URL をコピー（タブのメニューと ⋯。どれも参照が変わらない） */
  makeShareUrl: () => Promise<ShareMake>;
  subscribeShare: (f: () => void) => () => void;
  shareSupported: boolean;
  onShareResult: (r: ShareResult) => void;
  /** ⋯ の保存一覧・設定（#87 (C)。どれも参照が変わらない） */
  bookCount: number | null;
  onOpenBook: () => void;
  /** タブのメニューの 保存一覧に保存…（名前の欄にフォーカスして開く） */
  onSaveToBook: () => void;
  onOpenSettings: () => void;
  /** PC の [AI]（#135。作業台の列を AI のチャットと入れ替える。参照が変わらない）。aiOpen = 今 AI を出している */
  aiOpen?: boolean;
  onAi?: () => void;
}

/**
 * トップバー（docs/ui-redesign.md §2.1。#87）: ブランド / BOX タブ / 市場ピル / 警告のタグ /（PC）[AI] / [最新] / テーマ ☾ / ⋯。
 * スマホはブランドとテーマのボタンを CSS で隠す（スマホのテーマは設定。#275 で ⋯ のテーマの行を外した）。縮むのは BOX タブの帯だけ（#87 (B)）。
 * ⋯ は 保存一覧（N）… / URL をコピー / ファイルを開く… /（dev）合成の板 / 設定…（#87 (C)・#275。行は ui/view/topMenu.ts）。
 * ファイルを開く… は隠した file input をメニューの選択と同じイベントの中で click()。
 * pure: 入力は NextApp の useMemo と参照の変わらない関数だけ（シナリオの操作で描き直さない）。
 */
function TopBarView(p: TopBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const latestRef = useRef<HTMLButtonElement>(null);
  const topRef = useRef<HTMLElement>(null);
  // 警告のタグの最後の 1 つを閉じたら（タグごと消える）[最新] へ、[最新] が押せない（読み込み中）なら ⋯ へフォーカスを移す
  const closingLast = useRef(false);
  const hasWarn = p.warn !== null;
  useLayoutEffect(() => {
    if (hasWarn || !closingLast.current) return;
    closingLast.current = false;
    const latest = latestRef.current;
    if (latest && !latest.disabled) latest.focus();
    else topRef.current?.querySelector<HTMLButtonElement>('button[aria-label="メニュー"]')?.focus();
  }, [hasWarn]);
  // ⋯ の URL をコピー（開いている間だけ URL を作る）
  const [moreOpen, setMoreOpen] = useState(false);
  const share = useShareCopy({
    open: moreOpen,
    legCount: p.tabs.active.legCount,
    supported: p.shareSupported,
    make: p.makeShareUrl,
    subscribe: p.subscribeShare,
    onResult: p.onShareResult,
  });
  const { warn, onCloseNote } = p;
  const closeNote = (kind: WarnTagKind) => {
    closingLast.current = warn !== null && warn.tags.length === 1;
    onCloseNote(kind);
  };

  const more = toItems<TopMenuKey>(
    topMenuModel({
      bookCount: p.bookCount,
      share: share.item,
      fixtures: p.fixtures,
      sourceLabel: p.sourceLabel,
    }),
    (k) => {
      if (k === 'book') p.onOpenBook();
      else if (k === 'share') share.copy();
      else if (k === 'file') fileRef.current?.click();
      else if (k === 'settings') p.onOpenSettings();
      else if (k.startsWith('fixture:')) p.onFixture(k.slice('fixture:'.length));
    },
  );
  const themeItems = THEMES.map((t) => ({
    key: t.theme,
    label: t.label,
    checked: p.theme === t.theme,
    onSelect: () => p.onTheme(t.theme),
  }));
  return (
    <header class="top" ref={topRef}>
      <h1 class="brand">OP Simulator</h1>
      <BoxTabs
        view={p.tabs}
        dispatch={p.dispatch}
        onCloseTab={p.onCloseTab}
        makeShareUrl={p.makeShareUrl}
        subscribeShare={p.subscribeShare}
        shareSupported={p.shareSupported}
        onShareResult={p.onShareResult}
        onSaveToBook={p.onSaveToBook}
      />
      <MarketPill m={p.pill} tier={p.tier} noTag={p.tier === 'phone' && warn !== null} />
      {warn && <WarnTags m={warn} tier={p.tier} onClose={closeNote} />}
      {p.tier === 'pc' && p.onAi && (
        <button
          type="button"
          class="btn sm"
          data-ai="top"
          aria-pressed={p.aiOpen === true}
          title="作業台を AI のチャットと入れ替える（6）"
          onClick={p.onAi}
        >
          AI
        </button>
      )}
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
      <Menu label="メニュー" button="⋯" items={more} onOpenChange={setMoreOpen} />
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

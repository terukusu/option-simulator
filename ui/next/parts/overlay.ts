import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { closeLayer, openLayer, topLayerId } from '../backStack';

/**
 * 開いているメニュー / ポップオーバーの id を 1 つだけ持つ小さな購読ストア（#81。docs/ui-redesign.md §5）。
 * Menu・Popover が共有する（同時に開くのは 1 つだけ。別のものを開くと前のものが閉じる）。
 *
 * 開いているものは戻る（スマホの戻るジェスチャー・ブラウザの戻る）でも閉じる（#320。../backStack.ts に層として積む）。
 * 戻るで閉じるときは useOverlay の onBack（Esc と同じ閉じ方。省略時は閉じるだけ）を呼ぶ。
 */

let openId: string | null = null;
const listeners = new Set<() => void>();
/** 戻るで閉じるときの閉じ方（id ごと。部品の最新の関数を ref で持つ） */
const backs = new Map<string, { current: (() => void) | undefined }>();

const layerOf = (id: string) => `overlay:${id}`;

function setOpenId(id: string | null): void {
  if (openId === id) return;
  const prev = openId;
  openId = id;
  if (prev !== null) closeLayer(layerOf(prev));
  if (id !== null) openLayer(layerOf(id), () => backClose(id));
  for (const f of listeners) f();
}

/** 戻るで閉じる: 部品の onBack（Esc と同じ）。無ければ閉じるだけ */
function backClose(id: string): void {
  const f = backs.get(id)?.current;
  if (f) f();
  else if (openId === id) setOpenId(null);
}

/** いま開いているメニュー / ポップオーバーの id（無ければ null）。全体のキー（#89）が「ふさがっている」を読む */
export function openOverlayId(): string | null {
  return openId;
}

/**
 * id のメニュー / ポップオーバーが戻るのスタックの一番上か（#320 第 2 弾）。上に説明カード・ダイアログが重なっている
 * 間は、外側の pointerdown・Esc で閉じない（重なったものの操作で下の吹き出しを閉じない）
 */
export function overlayOnTop(id: string): boolean {
  return topLayerId() === layerOf(id);
}

/** 上に重なったもの（説明カード）が処理した Esc の印（#320 第 2 弾） */
const claimed = new WeakSet<Event>();

/**
 * 上に重なったもの（説明カード）がこの Esc を処理した印を付ける。下の吹き出し・板の K はその Esc で閉じない
 * （document の keydown の listener の登録順に頼らない）。preventDefault では見分けない: ダイアログが中の吹き出しの
 * Esc で cancel を止めるために preventDefault するので、それで吹き出しが閉じなくなる
 */
export function claimEscape(e: Event): void {
  claimed.add(e);
}

/** claimEscape の印があるか */
export function escapeClaimed(e: Event): boolean {
  return claimed.has(e);
}

/** 開いているメニュー / ポップオーバーを閉じる（#136。吹き出しの中の [AI に聞く] を押した後） */
export function closeOverlay(): void {
  setOpenId(null);
}

/**
 * 開いているメニュー / ポップオーバーを戻ると同じ閉じ方（Esc と同じ = onBack）で閉じる（#320。ダイアログの中の
 * ポップオーバーを Android の Chrome の閉じる要求で閉じる）
 */
export function closeOverlayAsBack(): void {
  if (openId !== null) backClose(openId);
}

/**
 * onBack: 戻るで閉じるときの閉じ方（#320。Esc と同じにする = フォーカスの戻し先も同じ）。省略時は setOpen(false)
 */
export function useOverlay(
  id: string,
  onBack?: () => void,
): { open: boolean; setOpen: (open: boolean) => void } {
  const [open, setLocal] = useState(openId === id);
  const backRef = useRef(onBack);
  backRef.current = onBack;
  useEffect(() => {
    const update = () => setLocal(openId === id);
    listeners.add(update);
    backs.set(id, backRef);
    update();
    return () => {
      listeners.delete(update);
      if (backs.get(id) === backRef) backs.delete(id);
      // 開いたまま消えたら閉じた扱いにする（次に開くものを邪魔しない。戻るの層も外す）
      if (openId === id) {
        openId = null;
        closeLayer(layerOf(id));
      }
    };
  }, [id]);
  const setOpen = useCallback(
    (next: boolean) => {
      if (next) setOpenId(id);
      else if (openId === id) setOpenId(null);
    },
    [id],
  );
  return { open, setOpen };
}

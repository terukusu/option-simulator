/**
 * 損益グラフのピン留め（#22。設計 docs/design.md M13・6.1・13.4）の型・定数と、ピンの集合の操作（純関数）。
 *
 * ピンは 2 種類（オーナー確認の対象。種類を減らすならここの PinSource だけ変える）:
 * - ghost（固定）: ピンした時点の損益グラフの基礎（PnlBase = 準備済みの足・市場・評価の設定）とシナリオを持ち、
 *   表示範囲・描画幅が変わったときだけ同じ評価器で描き直す。足・シナリオ・設定・板を後で変えても値は変わらない
 * - tab / saved（重ね = 追随）: 別のタブ・保存したポジションの足を、今の板・今のシナリオ（全タブ共通）・今の評価の
 *   設定で描く。tab はタブの id だけ（タブの足の変更に追随）、saved は重ねた時点の足の写し（項目の上書き・削除に影響されない）
 *
 * ピンは保存しない（State の中だけ。再読み込みで消える。作業の版 2・保存一覧・URL の形式は変えない。オーナー確認の対象）。
 */

import type { Scenario } from '../model';
import type { UiLeg } from './state';
import type { PnlBase } from './view/pnlChart';

/** ピンの本数の上限（固定・重ねの合計。M13・AC28） */
export const MAX_PINS = 3;
/** ピンの期中の線の点の間隔（描画幅の CSS px）と点数の上限（性能の予算 16 ms に収める。#22 D8） */
export const PIN_SAMPLE_PX = 4;
export const PIN_MAX_SAMPLES = 200;
/**
 * 拡大縮小（表示範囲の幅が変わるフレーム）の間だけ使う点数の上限と、操作が止まってから通常の点数で描き直すまでの時間。
 * 幅が変わると格子を使い回せず全点を作り直すため（#22 S1）。止まった後の線は通常の点数と同じ値
 */
export const PIN_ZOOM_MAX_SAMPLES = 100;
export const PIN_SETTLE_MS = 120;

/** ピンの番号（①〜③。追加順に空いている最小の番号。外しても他のピンの番号は変えない） */
export type PinNo = 1 | 2 | 3;
export const PIN_NOS: readonly PinNo[] = [1, 2, 3];

/** ピンの線: 期中（指定日 + シナリオ、描かない条件なら今日）/ 満期。全ピン共通の切替（オーナー確認の対象: 既定 = 期中） */
export type PinLineMode = 'period' | 'expiry';
export const DEFAULT_PIN_LINE: PinLineMode = 'period';

/** 期中の線の種類（今の線と同じ規則。指定日 + シナリオを描く条件なら date、そうでなければ today） */
export type PinPeriodKind = 'date' | 'today';

/** ゴースト（固定）が持つもの。PnlBase は不変オブジェクトの参照（直列化しない = 保存しない前提） */
export interface GhostPin {
  kind: 'ghost';
  base: PnlBase;
  /** ピンした時点のシナリオ（d は最遠の足の SQ に収めた値。ΔX は線の形に効かない） */
  scenario: Scenario;
  /** ピンした時点の期中の線の種類 */
  period: PinPeriodKind;
  /** ピンしたタブの名前（その時点の写し） */
  tabName: string;
  /** ピンした時点の板のスナップショット時刻（epoch ミリ秒。無ければ null） */
  boardSnapshotAt: number | null;
}

export interface TabOverlayPin {
  kind: 'tab';
  tabId: number;
}

export interface SavedOverlayPin {
  kind: 'saved';
  /** 保存一覧の項目の名前（重ねた時点の写し） */
  name: string;
  /** 重ねた時点の足の写し */
  legs: ReadonlyArray<Omit<UiLeg, 'id'>>;
}

export type PinSource = GhostPin | TabOverlayPin | SavedOverlayPin;

export type Pin = PinSource & { no: PinNo };

export const PINS_FULL_TEXT = `ピンは ${MAX_PINS} 本まで（外すと追加できる）`;

/** 空いている最小の番号（無ければ null）。 */
export function nextPinNo(pins: readonly Pin[]): PinNo | null {
  const used = new Set(pins.map((p) => p.no));
  return PIN_NOS.find((n) => !used.has(n)) ?? null;
}

/**
 * ピンを足す（上限・同じタブの重ね・無いタブ・作業中のタブを指す重ねは足さずに同じ配列を返す）。
 * tabIds = 今あるタブの id、activeTab = 作業中のタブの id。
 */
export function addPin(
  pins: readonly Pin[],
  source: PinSource,
  tabIds: readonly number[],
  activeTab: number,
): readonly Pin[] {
  if (pins.length >= MAX_PINS) return pins;
  const no = nextPinNo(pins);
  if (no === null) return pins;
  if (source.kind === 'tab') {
    if (!tabIds.includes(source.tabId) || source.tabId === activeTab) return pins;
    if (pins.some((p) => p.kind === 'tab' && p.tabId === source.tabId)) return pins;
  }
  if (source.kind === 'saved' && source.legs.length === 0) return pins;
  return [...pins, { ...source, no }];
}

/** 番号のピンを外す（無ければ同じ配列）。 */
export function removePin(pins: readonly Pin[], no: number): readonly Pin[] {
  return pins.some((p) => p.no === no) ? pins.filter((p) => p.no !== no) : pins;
}

/** タブを閉じたとき、そのタブの重ねを外す（無ければ同じ配列）。 */
export function dropTabPins(pins: readonly Pin[], tabId: number): readonly Pin[] {
  return pins.some((p) => p.kind === 'tab' && p.tabId === tabId)
    ? pins.filter((p) => !(p.kind === 'tab' && p.tabId === tabId))
    : pins;
}

/** 追加の操作を断る理由（足せるなら null）。 */
export function pinAddError(pins: ReadonlyArray<unknown>): string | null {
  return pins.length >= MAX_PINS ? PINS_FULL_TEXT : null;
}

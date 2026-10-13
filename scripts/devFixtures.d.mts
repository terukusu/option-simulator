import type { Plugin } from 'vite';

/** dev サーバーが配る合成の板の名前 */
export const SERVED_FIXTURES: readonly string[];

/** 合成の板を dev サーバーでだけ配る Vite プラグイン（apply: 'serve'） */
export function serveSyntheticFixtures(): Plugin;

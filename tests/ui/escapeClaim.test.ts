import { describe, expect, it } from 'vitest';
import { claimEscape, escapeClaimed } from '../../ui/next/parts/overlay';

/**
 * #320 第 2 弾: 説明カードが処理した Esc の印。下の吹き出し（Popover）・板の K は印のある Esc で閉じない
 * （document の keydown の listener の登録順に頼らない）。preventDefault では見分けない（ダイアログが中の吹き出しの
 * Esc で cancel を止めるために preventDefault する）
 */
describe('claimEscape / escapeClaimed', () => {
  it('印を付けた出来事だけ true（別の出来事・preventDefault だけのものは false）', () => {
    const a = new Event('keydown', { cancelable: true });
    const b = new Event('keydown', { cancelable: true });
    b.preventDefault();
    expect(escapeClaimed(a)).toBe(false);
    claimEscape(a);
    expect(escapeClaimed(a)).toBe(true);
    expect(escapeClaimed(b)).toBe(false);
  });
});

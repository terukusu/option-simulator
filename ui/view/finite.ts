/** 有限の数か（null・undefined・NaN・±∞ は偽）。画面の純関数が共用する（AI のモジュールに依存しない置き場所） */
export const fin = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

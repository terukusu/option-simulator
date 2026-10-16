/**
 * テキストをファイルとして保存させる（Blob + 一時的な a[download]。#70 のポジ帳の書き出し）。
 * Blob URL のダウンロードは CSP のフェッチ系ディレクティブの対象外（connect-src などを足さない）。
 * DOM に HTML 文字列を入れない（要素を作って属性だけ入れる）。
 */
export function downloadText(
  text: string,
  filename: string,
  type = 'application/json',
  parent: HTMLElement = document.body,
): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.hidden = true;
  parent.appendChild(a);
  a.click();
  a.remove();
  // すぐ revoke するとダウンロードが始まらないブラウザがあるので次のタスクで
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

import { loaderNote } from '../load';
import type { LoadErrorView } from '../state';

export interface LoaderProps {
  /** dev サーバーが配る合成の板の名前（本番は空） */
  fixtures: readonly string[];
  sourceLabel: string | null;
  loading: boolean;
  error: LoadErrorView | null;
  /** 失敗しても前の板を表示している旨（「前の板のまま（取得 HH:MM）」。板が無ければ null） */
  kept: string | null;
  onFixture: (name: string) => void;
  onFile: (file: File) => void;
  /** [最新]: API から読み直す */
  onLatest: () => void;
}

/** 板の読み込み（[最新] = API、dev は合成の fixture の切替、どこでもファイル選択）。 */
export function Loader(props: LoaderProps) {
  const { fixtures, sourceLabel, loading, error, kept } = props;
  return (
    <div class="loader">
      <button
        type="button"
        class="latest"
        disabled={loading}
        title="API から板を読み直す"
        onClick={() => props.onLatest()}
      >
        最新
      </button>
      {fixtures.length > 0 && (
        <label>
          合成の板{' '}
          <select
            value={fixtures.includes(sourceLabel ?? '') ? (sourceLabel ?? '') : ''}
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (v) props.onFixture(v);
            }}
          >
            <option value="">（選ぶ）</option>
            {fixtures.map((f) => (
              <option key={f} value={f}>
                {f}.json
              </option>
            ))}
          </select>
        </label>
      )}
      {/* ネイティブの input は既定の文言（「選択されていません」）が幅や言語で省略されるので視覚的に隠し、
          label をボタンにする（display: none にしない＝Tab で届き、Enter / Space で開く。#48） */}
      <label class="file-open" title="手元の板の JSON を開く">
        ファイルを開く…
        <input
          type="file"
          class="sr-only"
          accept="application/json,.json"
          onKeyDown={(e) => {
            // Space はブラウザが開く。Enter はブラウザによって開かないので揃える
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.click();
            }
          }}
          onChange={(e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (file) props.onFile(file);
            input.value = '';
          }}
        />
      </label>
      <span class="note">{loaderNote(loading, sourceLabel)}</span>
      {error && (
        <div class="error" role="alert">
          <p>
            {error.message}
            {kept && `。${kept}`}
          </p>
          {error.errors.length > 0 && (
            <ul>
              {error.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

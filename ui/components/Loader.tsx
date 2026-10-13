import type { LoadErrorView } from '../state';

export interface LoaderProps {
  /** dev サーバーが配る合成の板の名前（本番は空） */
  fixtures: readonly string[];
  sourceLabel: string | null;
  loading: boolean;
  error: LoadErrorView | null;
  onFixture: (name: string) => void;
  onFile: (file: File) => void;
}

/** 板の読み込み（dev は合成の fixture の切替、どこでもファイル選択）。 */
export function Loader(props: LoaderProps) {
  const { fixtures, sourceLabel, loading, error } = props;
  return (
    <div class="loader">
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
      <label>
        板の JSON{' '}
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (file) props.onFile(file);
            input.value = '';
          }}
        />
      </label>
      <span class="note">
        {loading ? '読み込み中…' : sourceLabel ? `表示中: ${sourceLabel}` : ''}
      </span>
      {error && (
        <div class="error" role="alert">
          <p>{error.message}（前の板のまま）</p>
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

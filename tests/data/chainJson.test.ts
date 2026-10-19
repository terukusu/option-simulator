import { describe, expect, it } from 'vitest';
import { parseChainJson, validateChainJson } from '../../data/chainJson';
import aiTools from '../../fixtures/synthetic/ai_tools.json';
import { buildFixtureFiles, sessionStart } from '../../scripts/synthBoard';
import { RAW_FIXTURES, rawFixture } from '../support/fixtures';

type Obj = Record<string, unknown>;
const months = (j: Obj) => j.months as Obj[];
const rows = (j: Obj, m = 0) => months(j)[m]?.rows as Obj[];
const firstPut = (j: Obj) => rows(j)[0]?.put as Obj;

function rejects(mutate: (j: Obj) => void, pattern: RegExp) {
  const j = rawFixture('latest');
  mutate(j);
  const res = validateChainJson(j);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.errors.join('\n')).toMatch(pattern);
}

describe('板の JSON の検証', () => {
  it.each(Object.keys(RAW_FIXTURES))('合成の固定 JSON %s は通る', (name) => {
    const res = validateChainJson(RAW_FIXTURES[name]);
    expect(res.ok ? [] : res.errors).toEqual([]);
  });

  it('コミット済みの固定 JSON は生成器の出力と一致する（npm run fixtures で作り直す）', () => {
    const files = buildFixtureFiles();
    // 板の 3 つと、道具の出力の見本（#135。板ではない）
    expect(Object.keys(files).sort()).toEqual(
      [...Object.keys(RAW_FIXTURES), 'ai_tools.json'].sort(),
    );
    for (const [name, text] of Object.entries(files)) {
      expect(JSON.parse(text)).toEqual(name === 'ai_tools.json' ? aiTools : RAW_FIXTURES[name]);
    }
  });

  it.each(Object.keys(RAW_FIXTURES))(
    '%s: 約定時刻はその立会の開始〜スナップショットの間',
    (name) => {
      const res = validateChainJson(RAW_FIXTURES[name]);
      if (!res.ok) throw new Error();
      const snap = Date.parse(res.value.snapshot_at);
      const start = sessionStart(snap);
      let n = 0;
      for (const m of res.value.months) {
        for (const r of m.rows) {
          for (const side of [r.call, r.put]) {
            if (side.price_time === null) continue;
            n += 1;
            const t = Date.parse(side.price_time);
            expect(t).toBeGreaterThanOrEqual(start);
            expect(t).toBeLessThanOrEqual(snap);
          }
        }
      }
      expect(n).toBeGreaterThan(0);
    },
  );

  it('立会の開始: 夜間は 17:00（翌朝は前日の 17:00）、日中は 8:45', () => {
    expect(sessionStart(Date.parse('2026-10-13T21:31:00+09:00'))).toBe(
      Date.parse('2026-10-13T17:00:00+09:00'),
    );
    expect(sessionStart(Date.parse('2026-10-14T03:00:00+09:00'))).toBe(
      Date.parse('2026-10-13T17:00:00+09:00'),
    );
    expect(sessionStart(Date.parse('2026-10-13T15:40:00+09:00'))).toBe(
      Date.parse('2026-10-13T08:45:00+09:00'),
    );
  });

  it('任意のキー（source・quotation・quotation_date・is_atm）は省略でき、知らないキーは無視する', () => {
    const j = rawFixture('latest');
    delete j.source;
    const p = firstPut(j);
    delete p.quotation;
    delete p.quotation_date;
    delete p.is_atm;
    p.bid_volume = 3;
    j.extra = { anything: true };
    const res = validateChainJson(j);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.source).toBeUndefined();
      expect(res.value.months[0]?.rows[0]?.put.quotation).toBeNull();
      expect('extra' in res.value).toBe(false);
    }
  });

  describe('壊れた入力を拒否する', () => {
    it('オブジェクトでない・JSON でない', () => {
      for (const v of [null, 1, 'x', [], undefined]) expect(validateChainJson(v).ok).toBe(false);
      const res = parseChainJson('{"schema_version":');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors[0]).toMatch(/JSON として解析できない/);
    });

    it('未対応の版', () => rejects((j) => (j.schema_version = 2), /schema_version: 未対応の版/));

    it('必須キーの欠落（欠損は null で表す）', () => {
      rejects((j) => delete j.snapshot_at, /\$\.snapshot_at: キーが無い/);
      rejects((j) => delete firstPut(j).bid, /rows\[0\]\.put\.bid: キーが無い/);
      rejects((j) => delete (j.future as Obj).contract_month, /future\.contract_month: キーが無い/);
      rejects((j) => delete months(j)[1]?.sq_date, /months\[1\]\.sq_date: キーが無い/);
    });

    it('型の違い（文字列の数・NaN・負の価格・小数の行使価格）', () => {
      rejects((j) => (firstPut(j).bid = '8'), /put\.bid: 有限の数でない/);
      rejects((j) => (firstPut(j).ask = Number.NaN), /put\.ask: 有限の数でない/);
      rejects((j) => (firstPut(j).bid = -1), /put\.bid: 0 未満/);
      rejects((j) => ((rows(j)[0] as Obj).k = 30000.5), /rows\[0\]\.k: 整数でない/);
      rejects((j) => (firstPut(j).volume = 1.5), /put\.volume: 整数でない/);
      rejects((j) => (firstPut(j).is_atm = 'no'), /put\.is_atm: 真偽値でない/);
      rejects((j) => ((rows(j)[0] as Obj).call = null), /rows\[0\]\.call: オブジェクトでない/);
      rejects((j) => ((months(j)[0] as Obj).rows = {}), /months\[0\]\.rows: 配列でない/);
    });

    it('null を許さない値', () => {
      rejects((j) => (j.delayed_minutes = null), /delayed_minutes: null は不可/);
      rejects((j) => ((j.future as Obj).sq_date = null), /future\.sq_date: null は不可/);
    });

    it('時刻・日付・限月の形式', () => {
      rejects(
        (j) => (j.snapshot_at = '2026-10-13T21:31:00'),
        /snapshot_at: ISO 8601（オフセット付き）/,
      );
      rejects((j) => (j.snapshot_at = '2026-13-45T99:99:00+09:00'), /snapshot_at: 存在しない時刻/);
      rejects((j) => ((months(j)[0] as Obj).sq_date = '2026-02-30'), /sq_date: 存在しない日付/);
      rejects((j) => ((j.future as Obj).contract_month = '2026-13'), /月が 1〜12 でない/);
      rejects((j) => ((j.spot as Obj).price_time = 'yesterday'), /spot\.price_time/);
    });

    it('reason の値', () => rejects((j) => (j.reason = 'stale'), /reason: latest/));

    it('行使価格の昇順・重複', () => {
      rejects((j) => {
        const r = rows(j);
        [r[0], r[1]] = [r[1] as Obj, r[0] as Obj];
      }, /k: 行使価格が昇順でない/);
      rejects((j) => {
        const r = rows(j);
        (r[1] as Obj).k = (r[0] as Obj).k;
      }, /k: 行使価格が昇順でない/);
    });

    it('限月の整合（0 本・重複・SQ 日の月・取引最終日・順序）', () => {
      rejects((j) => (j.months = []), /months: 限月が 0 本/);
      rejects(
        (j) => ((months(j)[1] as Obj).contract_month = (months(j)[0] as Obj).contract_month),
        /contract_month: 重複/,
      );
      rejects(
        (j) => ((months(j)[0] as Obj).sq_date = '2026-12-11'),
        /sq_date: contract_month の月でない/,
      );
      rejects(
        (j) => ((months(j)[0] as Obj).last_trading_day = '2026-11-13'),
        /last_trading_day: SQ 日より前でない/,
      );
      rejects((j) => {
        const m = months(j);
        j.months = [m[1], m[0]];
      }, /限月が SQ 日の昇順でない/);
      rejects(
        (j) => ((j.future as Obj).sq_date = '2026-11-13'),
        /future\.sq_date: contract_month の月でない/,
      );
      rejects(
        (j) => ((j.future as Obj).last_trading_day = '2026-12-11'),
        /future\.last_trading_day: SQ 日より前でない/,
      );
    });

    it('エラーは 50 件で打ち切る（巨大な壊れた入力）', () => {
      const j = rawFixture('latest');
      for (const r of rows(j)) (r.put as Obj).bid = 'x';
      const res = validateChainJson(j);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors.length).toBe(50);
    });
  });
});

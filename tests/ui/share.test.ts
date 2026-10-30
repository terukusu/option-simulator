import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { serializeWorkspace, toSaved } from '../../ui/persist';
import { DEFAULT_MARGIN_PREFS, readPrefs, serializePrefs } from '../../ui/prefs';
import {
  encodeShareUrl,
  FRAGMENT_MAX,
  fromBase64Url,
  INFLATED_MAX,
  parseShareHash,
  readSharedText,
  readShareHash,
  SHARE_VERSION,
  type ShareCodec,
  type SharedPosition,
  type ShareMake,
  type ShareRead,
  shareOpenAction,
  shareOpenMode,
  streamCodec,
  toBase64Url,
  URL_MAX,
  URL_WARN,
  withoutUiParam,
} from '../../ui/share';
import { type Action, initialState, MAX_TABS, reduce, type State } from '../../ui/state';
import { fixture } from '../support/fixtures';
import shareV1 from './saved/share-v1.json';
import v1 from './saved/workspace-v1.json';

const NOW = Date.parse('2026-11-02T12:47:00.000Z');
/** フラグメントを除いた URL（架空。Cloud Run の既定の URL と同じくらいの長さ） */
const BASE = `https://${'x'.repeat(52)}/`;

const FIXTURE_HASH = shareV1.hash;

function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reduce, state);
}

function made(m: ShareMake): { url: string; length: number; long: boolean } {
  if (m.kind !== 'ok') throw new Error(`作れない: ${m.kind}`);
  return m;
}

function shared(r: ShareRead): SharedPosition {
  if (r.kind !== 'ok') throw new Error(`読めない: ${r.kind}`);
  return r.shared;
}

const hashOf = (url: string) => url.slice(url.indexOf('#'));

async function gzipText(text: string): Promise<string> {
  return toBase64Url(await streamCodec.gzip(new TextEncoder().encode(text)));
}

const chain = normalizeChain(fixture('latest'));

/** 合成の板から足を n 本作った state（板の足・IV の編集・手入力の OP・ミニ先物を混ぜる。架空の値） */
function withLegs(n: number): State {
  let s = reduce(initialState, { type: 'loaded', chain, label: 'API' });
  for (let i = 0; i < n; i++) {
    if (i % 10 === 3) {
      s = reduce(s, {
        type: 'addFutureLeg',
        input: { product: 'fut_mini', contract: '2026-12', side: i % 2 ? 'sell' : 'buy', qty: 2 },
      });
    } else if (i % 10 === 7) {
      s = reduce(s, {
        type: 'addManualLeg',
        input: {
          product: 'op_large',
          expiry: '2027-06',
          type: 'call',
          k: 70000 + 250 * i,
          side: 'buy',
          entry: 500 + i,
          iv: 0.25,
        },
      });
    } else {
      const month = chain.months[i % chain.months.length];
      const rows = month?.rows ?? [];
      const row = rows[Math.floor(rows.length / 2) + ((i * 13) % 41) - 20];
      s = reduce(s, {
        type: 'addBoardLeg',
        expiry: month?.id ?? '',
        k: row?.k ?? 0,
        optionType: i % 2 ? 'call' : 'put',
        side: i % 3 ? 'sell' : 'buy',
      });
    }
    const id = s.legs.length;
    if (i % 4 !== 0) s = reduce(s, { type: 'editLeg', id, patch: { qty: 1 + (i % 4) } });
    if (i % 5 === 0) s = reduce(s, { type: 'editLeg', id, patch: { iv: 0.2137 } });
  }
  return run(s, {
    type: 'setScenario',
    patch: { days: 2.5, dX: -1200, dSigma: 3, skew: 0.5, beta: 1.2, ivShift: 'relative' },
  });
}

describe('base64url', () => {
  it('全 256 値・長さ 0〜5 の往復（パディングなし・URL で安全な字だけ）', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const s = toBase64Url(all);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(s)).toEqual(all);
    for (let n = 0; n <= 5; n++) {
      const b = all.slice(250 - n, 250);
      expect(fromBase64Url(toBase64Url(b))).toEqual(b);
    }
    expect(toBase64Url(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
  });

  it('知らない字・ありえない長さ・末尾の余りのビットが 0 でない → null', () => {
    expect(fromBase64Url('AB+C')).toBeNull();
    expect(fromBase64Url('AB=C')).toBeNull();
    expect(fromBase64Url('ABCDE')).toBeNull();
    expect(fromBase64Url('AQ')).toEqual(Uint8Array.from([1]));
    expect(fromBase64Url('AB')).toBeNull();
    expect(fromBase64Url('AF')).toBeNull();
    expect(fromBase64Url('__proto__')).toBeNull();
    expect(fromBase64Url('')).toEqual(new Uint8Array(0));
  });
});

describe('フラグメントの形', () => {
  it('#p= で始まらなければ扱わない', () => {
    expect(parseShareHash('')).toEqual({ kind: 'none' });
    expect(parseShareHash('#section')).toEqual({ kind: 'none' });
    expect(parseShareHash('#q=1.AAAA')).toEqual({ kind: 'none' });
  });

  it('形が違う・版 0 → invalid、新しい版 → newer、長すぎる → tooLong', () => {
    for (const h of [
      '#p=',
      '#p=1',
      '#p=1.',
      '#p=abc',
      '#p=1.AB CD',
      '#p=1.AB+C',
      '#p=0.AAAA',
      '#p=1.A',
    ]) {
      expect(parseShareHash(h).kind, h).toBe('invalid');
    }
    expect(parseShareHash('#p=2.AAAA')).toEqual({ kind: 'newer', version: 2 });
    expect(parseShareHash('#p=9.')).toEqual({ kind: 'invalid' });
    expect(parseShareHash(`#p=1.${'A'.repeat(FRAGMENT_MAX)}`)).toEqual({ kind: 'tooLong' });
    expect(parseShareHash(`#p=1.${'A'.repeat(FRAGMENT_MAX - 5)}`).kind).toBe('data');
    expect(SHARE_VERSION).toBe(1);
  });
});

describe('往復（作る → 読む）', () => {
  it('足（建値・枚数・売買・IV の編集・mid・印・手入力の市場・先物の市場）・シナリオ・設定・名前・時刻が同じ', async () => {
    const s = run(
      withLegs(3),
      { type: 'setFee', fee: 250 },
      { type: 'setFutureBasis', basis: 'decay' },
    );
    const m = made(await encodeShareUrl(toSaved(s, NOW), '鉄板の売り', BASE));
    expect(m.url.startsWith(`${BASE}#p=1.`)).toBe(true);
    expect(m.length).toBe(m.url.length);
    expect(m.long).toBe(false);
    const r = shared(await readShareHash(hashOf(m.url)));
    expect(r.legs).toEqual(s.legs.map(({ id: _id, ...rest }) => rest));
    expect(r.legs.map((l) => l.leg.kind)).toEqual(['option', 'option', 'option']);
    expect(r.scenario).toEqual(s.scenario);
    expect(r.feePerLot).toBe(250);
    expect(r.futureBasis).toBe('decay');
    expect(r.name).toBe('鉄板の売り');
    expect(r.savedAt).toBe(NOW);
    expect(r.boardSnapshotAt).toBe(chain.snapshotAt);
  });

  it('手入力の OP（NaN の forward）・ミニ先物・IV の小数も同値', async () => {
    const s = withLegs(10);
    expect(s.legs.some((l) => l.optionMarket)).toBe(true);
    expect(s.legs.some((l) => l.futureMarket)).toBe(true);
    expect(s.legs.some((l) => l.leg.kind === 'option' && l.leg.iv === 0.2137)).toBe(true);
    const m = made(await encodeShareUrl(toSaved(s, NOW), 'A', BASE));
    const r = shared(await readShareHash(hashOf(m.url)));
    expect(r.legs).toEqual(s.legs.map(({ id: _id, ...rest }) => rest));
  });

  it('名前は正規化して入れる・読む（制御文字・双方向の制御を除き 12 字まで。空なら入れない）', async () => {
    const doc = toSaved(withLegs(1), NOW);
    const m = made(await encodeShareUrl(doc, '‮あいうえおかきくけこさしすせそ\u0007', BASE));
    expect(shared(await readShareHash(hashOf(m.url))).name).toBe('あいうえおかきくけこさし');
    const empty = made(await encodeShareUrl(doc, '  ', BASE));
    expect(shared(await readShareHash(hashOf(empty.url))).name).toBe('');
    // 読む側でも正規化する（作る側を通らない URL）
    const raw = JSON.stringify({ ...doc, name: '\u0000‭にせもの⁦の名前ですよ長い長い' });
    const r = shared(await readShareHash(`#p=1.${await gzipText(raw)}`));
    expect(r.name).toBe('にせものの名前ですよ長い');
    const nonString = JSON.stringify({ ...doc, name: { toString: 1 } });
    expect(shared(await readShareHash(`#p=1.${await gzipText(nonString)}`)).name).toBe('');
  });

  it('固定の fixture（tests/ui/saved/share-v1.json。変えない）を読める', async () => {
    const r = shared(await readShareHash(FIXTURE_HASH));
    expect(r.name).toBe('鉄板の売り');
    expect(r.legs).toHaveLength(3);
    expect(r.legs[0]?.leg).toEqual(v1.position.legs[0]?.leg);
    expect(r.legs[1]?.leg).toEqual(v1.position.legs[1]?.leg);
    expect(r.legs[1]?.optionMarket?.market.forward).toBeNaN();
    expect(r.legs[2]?.leg).toEqual(v1.position.legs[2]?.leg);
    expect(r.legs[2]?.futureMarket).toBeDefined();
    // fixture の relative は absolute・Δσ = 0 として読む（#260。アプリの状態に relative を入れない）
    expect(v1.position.scenario.ivShift).toBe('relative');
    expect(r.scenario).toEqual({ ...v1.position.scenario, ivShift: 'absolute', dSigma: 0 });
    expect(r.feePerLot).toBe(300);
    expect(r.futureBasis).toBe('decay');
    expect(r.savedAt).toBe(NOW);
    expect(r.boardSnapshotAt).toBe(Date.parse('2026-11-02T21:31:00+09:00'));
  });
});

describe('長さ', () => {
  it('足 1・5・10・20・50 本は注意の内、200 本でも上限の内（design.md 13.4 の実測）', async () => {
    const len: Record<number, number> = {};
    for (const n of [1, 5, 10, 20, 50, 200]) {
      len[n] = made(await encodeShareUrl(toSaved(withLegs(n), NOW), 'A', BASE)).length;
    }
    expect(len[1]).toBeLessThan(700);
    expect(len[10]).toBeLessThan(1_200);
    expect(len[20]).toBeLessThan(URL_WARN);
    expect(len[200]).toBeLessThan(URL_MAX);
    expect(len[1]).toBeLessThan(len[5] ?? 0);
    expect(len[5]).toBeLessThan(len[10] ?? 0);
  });

  it('URL_WARN 超は long、URL_MAX 超は作らない（長さを返す）', async () => {
    const doc = toSaved(withLegs(1), NOW);
    // 圧縮の効かないバイト列を返す偽の圧縮で長さを作る
    const fake = (bytes: number): ShareCodec => ({
      gzip: async () => Uint8Array.from({ length: bytes }, (_, i) => (i * 131 + 7) % 256),
      gunzip: async () => ({ kind: 'invalid' }),
    });
    const prefix = `${BASE}#p=1.`.length;
    const atWarn = await encodeShareUrl(doc, '', BASE, fake(((URL_WARN - prefix) * 3) / 4));
    expect(made(atWarn).length).toBe(URL_WARN);
    expect(made(atWarn).long).toBe(false);
    const over = made(await encodeShareUrl(doc, '', BASE, fake(((URL_WARN - prefix + 4) * 3) / 4)));
    expect(over.long).toBe(true);
    const tooLong = await encodeShareUrl(doc, '', BASE, fake(((URL_MAX - prefix + 4) * 3) / 4));
    expect(tooLong).toEqual({ kind: 'tooLong', length: URL_MAX + 4 });
  });
});

describe('壊れた・危ない URL でも落ちずに知らせる', () => {
  async function goodHash(): Promise<string> {
    return hashOf(made(await encodeShareUrl(toSaved(withLegs(5), NOW), 'A', BASE)).url);
  }

  it('途中で切れた URL（末尾を 1〜40 字削る）→ invalid', async () => {
    const h = await goodHash();
    for (const cut of [1, 2, 3, 4, 10, 40]) {
      expect((await readShareHash(h.slice(0, -cut))).kind, `cut ${cut}`).toBe('invalid');
    }
  });

  it('1 字化けた URL → invalid（gzip の CRC・長さ・base64url の検査。別の値の足として開かない）', async () => {
    const h = await goodHash();
    const orig = shared(await readShareHash(h));
    const head = '#p=1.'.length;
    let invalid = 0;
    for (let i = head; i < h.length; i++) {
      const c = h[i] === 'A' ? 'B' : 'A';
      const r = await readShareHash(h.slice(0, i) + c + h.slice(i + 1));
      // gzip のヘッダの時刻・OS の欄と deflate の最後のバイトの詰め物のビットは中身に効かない: 読めても同じ中身
      if (r.kind === 'ok') {
        expect(r.shared, `pos ${i}`).toEqual(orig);
      } else {
        expect(r.kind, `pos ${i}`).toBe('invalid');
        invalid++;
      }
    }
    expect(invalid).toBeGreaterThan((h.length - head) * 0.95);
  });

  it('gzip でない・JSON でない・UTF-8 でない → invalid', async () => {
    expect((await readShareHash('#p=1.AAAA')).kind).toBe('invalid');
    expect((await readShareHash(`#p=1.${await gzipText('{not json')}`)).kind).toBe('invalid');
    const badUtf8 = toBase64Url(await streamCodec.gzip(Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d])));
    expect((await readShareHash(`#p=1.${badUtf8}`)).kind).toBe('invalid');
    expect((await readShareHash(`#p=1.${await gzipText('[]')}`)).kind).toBe('invalid');
    expect((await readShareHash(`#p=1.${await gzipText('null')}`)).kind).toBe('invalid');
  });

  it('URL の版・文書の版が新しい → newer', async () => {
    expect(await readShareHash('#p=2.AAAA')).toEqual({ kind: 'newer' });
    const doc = { ...toSaved(withLegs(1), NOW), schema_version: 2 };
    expect(await readShareHash(`#p=1.${await gzipText(JSON.stringify(doc))}`)).toEqual({
      kind: 'newer',
    });
  });

  it('展開爆弾（空白 100 万字の JSON）→ tooLarge（展開を打ち切る）', async () => {
    const bomb = `${' '.repeat(1_000_000)}{}`;
    const h = `#p=1.${await gzipText(bomb)}`;
    expect(h.length).toBeLessThan(FRAGMENT_MAX);
    expect(await readShareHash(h)).toEqual({ kind: 'tooLarge' });
    // 上限ちょうどまでは展開する（中身は JSON でないので invalid）
    const edge = `#p=1.${await gzipText(' '.repeat(INFLATED_MAX))}`;
    expect((await readShareHash(edge)).kind).toBe('invalid');
  });

  it('巨大な入力 → tooLong（復号しない）', async () => {
    let called = false;
    const spy: ShareCodec = {
      gzip: streamCodec.gzip,
      gunzip: async (b, m) => {
        called = true;
        return streamCodec.gunzip(b, m);
      },
    };
    expect(await readShareHash(`#p=1.${'A'.repeat(20_000)}`, spy)).toEqual({ kind: 'tooLong' });
    expect(called).toBe(false);
  });

  it('`__proto__`・余計なキーは写さない', async () => {
    const doc = toSaved(withLegs(2), NOW);
    const text = JSON.stringify(doc).replace(
      '{"schema_version"',
      '{"__proto__":{"polluted":true},"constructor":{"x":1},"extra":"x","schema_version"',
    );
    const legText = text.replace('"leg":{', '"leg":{"__proto__":{"evil":1},');
    const r = shared(await readShareHash(`#p=1.${await gzipText(legText)}`));
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(r.legs[0]?.leg)).toBe(Object.prototype);
    expect(Object.hasOwn(r, 'polluted')).toBe(false);
    expect('evil' in (r.legs[0]?.leg ?? {})).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(
      [
        'boardSnapshotAt',
        'feePerLot',
        'futureBasis',
        'held',
        'legs',
        'name',
        'savedAt',
        'scenario',
      ].sort(),
    );
  });

  it('足が 0 本 → noLegs、足・シナリオが不正 → invalid（開かない）', async () => {
    const empty = toSaved(initialState, NOW);
    expect(await readShareHash(`#p=1.${await gzipText(JSON.stringify(empty))}`)).toEqual({
      kind: 'noLegs',
    });
    const doc = toSaved(withLegs(2), NOW);
    const bad = JSON.parse(JSON.stringify(doc)) as {
      position: { legs: Array<{ leg: { qty: unknown } }> };
    };
    const first = bad.position.legs[0];
    if (first) first.leg.qty = -1;
    expect((await readShareHash(`#p=1.${await gzipText(JSON.stringify(bad))}`)).kind).toBe(
      'invalid',
    );
    expect(readSharedText('{"schema_version":1}').kind).toBe('invalid');
  });

  it('このブラウザで圧縮できない → unsupported（作る・読む）。圧縮が例外を投げても落ちない', async () => {
    const doc = toSaved(withLegs(1), NOW);
    expect(await encodeShareUrl(doc, 'A', BASE, null)).toEqual({ kind: 'unsupported' });
    expect(await readShareHash(FIXTURE_HASH, null)).toEqual({ kind: 'unsupported' });
    // 形が違うものは圧縮の有無に関係なく先に判定する
    expect(await readShareHash('#p=9.AAAA', null)).toEqual({ kind: 'newer' });
    const throwing: ShareCodec = {
      gzip: async () => {
        throw new Error('x');
      },
      gunzip: async () => {
        throw new Error('x');
      },
    };
    expect(await encodeShareUrl(doc, 'A', BASE, throwing)).toEqual({ kind: 'failed' });
    expect(await readShareHash(FIXTURE_HASH, throwing)).toEqual({ kind: 'invalid' });
  });
});

describe('保有の印（#301。オーナー判断 3 = URL で渡す）', () => {
  it('AC10: 作る → 読むで印が戻り、開くと開いたタブに印が付く（replace / newTab）', async () => {
    const s = run(withLegs(2), { type: 'setTabHeld', held: true });
    const m = made(await encodeShareUrl(toSaved(s, NOW), '保有', BASE));
    const r = shared(await readShareHash(hashOf(m.url)));
    expect(r.held).toBe(true);
    expect(shareOpenAction(r, 'replace')).toMatchObject({ type: 'openPosition', held: true });
    const a = reduce(initialState, shareOpenAction(r, 'replace'));
    expect(a.tabs[0]?.held).toBe(true);
    const b = reduce(withLegs(1), shareOpenAction(r, 'newTab'));
    expect(b.tabs.map((t) => t.held === true)).toEqual([false, true]);
  });

  it('印なしの URL・既存の fixture は印なしで開く。true 以外の held は印なし', async () => {
    const plain = shared(await readShareHash(FIXTURE_HASH));
    expect(plain.held).toBe(false);
    expect(reduce(initialState, shareOpenAction(plain, 'replace')).tabs[0]).not.toHaveProperty(
      'held',
    );
    const doc = toSaved(withLegs(1), NOW);
    for (const bad of [false, 'true', 1, {}]) {
      const raw = JSON.stringify({ ...doc, position: { ...doc.position, held: bad } });
      const r = shared(await readShareHash(`#p=1.${await gzipText(raw)}`));
      expect(r.held, String(bad)).toBe(false);
      expect(r.legs).toHaveLength(1);
    }
  });
});

describe('開き方', () => {
  it('作業中のタブが空ならそこ、足があれば新しいタブ、上限なら確認', () => {
    expect(shareOpenMode(1, 0)).toBe('replace');
    expect(shareOpenMode(MAX_TABS, 0)).toBe('replace');
    expect(shareOpenMode(1, 3)).toBe('newTab');
    expect(shareOpenMode(MAX_TABS - 1, 3)).toBe('newTab');
    expect(shareOpenMode(MAX_TABS, 3)).toBe('full');
  });

  it('reducer: 開いたタブに URL の名前を付ける（空・他のタブと同じ名前なら自動の名前のまま）', async () => {
    const r = shared(await readShareHash(FIXTURE_HASH));
    const open = (s: State, type: 'openPosition' | 'openPositionInNewTab', name: string) =>
      reduce(s, shareOpenAction({ ...r, name }, type === 'openPosition' ? 'replace' : 'newTab'));
    const a = open(initialState, 'openPosition', r.name);
    expect(a.tabs.map((t) => t.name)).toEqual(['鉄板の売り']);
    expect(a.legs).toHaveLength(3);
    const b = open(a, 'openPositionInNewTab', r.name);
    expect(b.tabs.map((t) => t.name)).toEqual(['鉄板の売り', 'A']);
    expect(b.activeTab).toBe(b.tabs[1]?.id);
    const c = open(b, 'openPositionInNewTab', '');
    expect(c.tabs.map((t) => t.name)).toEqual(['鉄板の売り', 'A', 'B']);
    const d = open(c, 'openPositionInNewTab', '‮別名');
    expect(d.tabs.map((t) => t.name)).toEqual(['鉄板の売り', 'A', 'B', '別名']);
  });

  it.each(['replace', 'newTab'] as const)(
    'URL から入れるのは足と名前だけ（%s）: 受け手のシナリオ・手数料・先物の basis・表示の設定は変えない',
    async (mode) => {
      const r = shared(await readShareHash(FIXTURE_HASH));
      // 受け手の値は URL の値と違うものにする（同じだと変わらなかったことを確かめられない）
      const scenario = { ...initialState.scenario, days: 7, dX: 450, dSigma: -2 };
      let s: State = { ...initialState, scenario, feePerLot: 55, futureBasis: 'fixed' };
      if (mode === 'newTab') {
        s = reduce(s, {
          type: 'openPosition',
          legs: r.legs.slice(0, 1),
          scenario: null,
          feePerLot: null,
          futureBasis: null,
        });
      }
      expect(r.scenario).not.toEqual(scenario);
      expect(r.feePerLot).not.toBe(55);
      expect(r.futureBasis).not.toBe('fixed');
      const action = shareOpenAction(r, mode);
      expect(action).toMatchObject({ scenario: null, feePerLot: null, futureBasis: null });
      const next = reduce(s, action);
      expect(next.legs).toHaveLength(r.legs.length);
      expect(next.tabs).toHaveLength(mode === 'newTab' ? 2 : 1);
      expect(next.scenario).toEqual(scenario);
      expect(next.feePerLot).toBe(55);
      expect(next.futureBasis).toBe('fixed');
      // 開く操作に無いもの（表示の設定・板）はそのまま
      const { legs: _l, nextId: _n, tabs: _t, activeTab: _a, nextTabId: _nt, ...rest } = next;
      const { legs: _l2, nextId: _n2, tabs: _t2, activeTab: _a2, nextTabId: _nt2, ...before } = s;
      expect({ ...rest, pnlViewport: null }).toEqual({ ...before, pnlViewport: null });
    },
  );
});

describe('withoutUiParam（#91: 共有 URL と #p= を開いた後の URL から ui を落とす）', () => {
  it.each([
    ['', ''],
    ['?', ''],
    ['?&&', ''],
    ['?ui=next', ''],
    ['?ui=legacy', ''],
    ['?ui', ''],
    ['?ui=', ''],
    ['?ui=next&ui=x', ''],
    ['?a=1&ui=next&b=2', '?a=1&b=2'],
    ['?ui=next&parts', '?parts'],
    ['?xui=next&uix=1', '?xui=next&uix=1'],
    ['?a=%20&ui=next', '?a=%20'],
    ['?a=+&b=%2B', '?a=+&b=%2B'],
    ['?u%69=next', ''],
    ['?a=1&&b=2', '?a=1&b=2'],
    ['a=1&ui=next', '?a=1'],
  ])('%j → %j', (input, want) => {
    expect(withoutUiParam(input)).toBe(want);
  });

  const samples = [
    '',
    '?',
    '?ui=next',
    '?a=1&ui=next&b=2',
    '?ui=next&parts',
    '??ui=1',
    '?u%69=x&UI=1&ui%3D=2',
    '?a=%E3%81%82&ui=legacy&c',
    '?=x&ui&=',
  ];
  it.each(samples)('%j: 冪等・結果に ui が無い・ui 以外の値は URLSearchParams で同じ', (s) => {
    const out = withoutUiParam(s);
    expect(withoutUiParam(out)).toBe(out);
    expect(new URLSearchParams(out).has('ui')).toBe(false);
    expect(out === '' || out.startsWith('?')).toBe(true);
    const entries = (q: string) => {
      const e: [string, string][] = [];
      new URLSearchParams(q).forEach((v, k) => {
        e.push([k, v]);
      });
      return e;
    };
    expect(entries(out)).toEqual(entries(s).filter(([k]) => k !== 'ui'));
  });
});

/** #131 AC15: 資金は端末の設定（option-simulator.prefs）だけ。共有の文字列・作業の保存に載らない */
describe('資金を共有の URL・作業の保存に載せない（#131 AC15）', () => {
  // 架空の資金（端末の設定に入れた状態。state.ts の reducer には入らない）
  const CAPITAL = 12_345_678;
  const prefsText = serializePrefs({
    theme: 'dark',
    margin: { ...DEFAULT_MARGIN_PREFS, capitalYen: CAPITAL },
  });

  it('資金を設定した状態でも、共有の文書（展開後）と作業の保存に資金の値もキーも無い', async () => {
    expect(readPrefs(prefsText).prefs.margin.capitalYen).toBe(CAPITAL);
    const s = withLegs(5);
    const m = made(await encodeShareUrl(toSaved(s, NOW), '売り', BASE));
    const data = m.url.slice(m.url.indexOf('#p=1.') + 5);
    const bytes = fromBase64Url(data);
    if (!bytes) throw new Error('base64url でない');
    const r = await streamCodec.gunzip(bytes, INFLATED_MAX);
    if (r.kind !== 'ok') throw new Error(r.kind);
    const doc = new TextDecoder().decode(r.bytes);
    const ws = serializeWorkspace(s, NOW);
    for (const text of [m.url, doc, ws]) {
      expect(text).not.toContain(String(CAPITAL));
      expect(text).not.toContain('12,345,678');
      expect(text).not.toContain('capital');
      expect(text).not.toContain('margin_');
    }
  });
});

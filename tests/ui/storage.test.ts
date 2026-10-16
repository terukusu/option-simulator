import { afterEach, describe, expect, it } from 'vitest';
import { getStorage, isQuotaError, readKey, removeKey, writeKey } from '../../ui/storage';

/** Map の偽 Storage（vitest は node 環境で localStorage が無い。依存を足さない） */
class FakeStorage implements Storage {
  map = new Map<string, string>();
  failWith: unknown = null;
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    if (this.failWith) throw this.failWith;
    return this.map.get(key) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    if (this.failWith) throw this.failWith;
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.failWith) throw this.failWith;
    this.map.set(key, value);
  }
}

function domError(name: string, code = 0): Error {
  const e = new Error(name);
  e.name = name;
  Object.defineProperty(e, 'code', { value: code });
  return e;
}

/** #23 AC4: localStorage が使えない・容量超過でも例外を外に出さない。 */
describe('storage', () => {
  it('書いて読んで消す', () => {
    const s = new FakeStorage();
    expect(writeKey(s, 'k', 'v')).toBe('ok');
    expect(readKey(s, 'k')).toBe('v');
    removeKey(s, 'k');
    expect(readKey(s, 'k')).toBeNull();
  });

  it('容量超過は quota、それ以外の例外・Storage が無いのは unavailable', () => {
    const s = new FakeStorage();
    s.failWith = domError('QuotaExceededError', 22);
    expect(writeKey(s, 'k', 'v')).toBe('quota');
    s.failWith = domError('NS_ERROR_DOM_QUOTA_REACHED', 1014);
    expect(writeKey(s, 'k', 'v')).toBe('quota');
    s.failWith = domError('SecurityError', 18);
    expect(writeKey(s, 'k', 'v')).toBe('unavailable');
    expect(readKey(s, 'k')).toBeNull();
    expect(() => removeKey(s, 'k')).not.toThrow();
    expect(writeKey(null, 'k', 'v')).toBe('unavailable');
    expect(readKey(null, 'k')).toBeNull();
  });

  it('isQuotaError: 名前か旧来の code で判定', () => {
    expect(isQuotaError(domError('x', 22))).toBe(true);
    expect(isQuotaError(domError('QuotaExceededError'))).toBe(true);
    expect(isQuotaError(new Error('x'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError('QuotaExceededError')).toBe(false);
  });

  describe('getStorage', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    afterEach(() => {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    it('参照で例外を投げる（Cookie のブロックなど）なら null', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw domError('SecurityError', 18);
        },
      });
      expect(getStorage()).toBeNull();
    });

    it('あればそれを返す', () => {
      const s = new FakeStorage();
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: s });
      expect(getStorage()).toBe(s);
    });
  });
});

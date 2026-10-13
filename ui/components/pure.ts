import { Component, type ComponentType, h } from 'preact';

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

/**
 * props が浅く等しければ描き直さない部品にする（preact/compat の memo の代わり。compat を入れない）。
 * 親の再描画（足の追加など）で、板 322 行・スマイルの点を作り直さないために使う。
 */
export function pure<P extends object>(Inner: ComponentType<P>): ComponentType<P> {
  class Pure extends Component<P> {
    override shouldComponentUpdate(next: P): boolean {
      return !shallowEqual(this.props, next);
    }

    override render() {
      return h(Inner, this.props);
    }
  }
  return Pure as unknown as ComponentType<P>;
}

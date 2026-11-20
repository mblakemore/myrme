/**
 * Tiny DOM helpers for the HUD. All writers diff against a cached last value so the 10 Hz HUD
 * model update never touches the DOM when nothing changed.
 */

export type Attrs = Record<string, string | number | boolean | undefined>;

/** Create an element: `h('div', 'cls other', { 'data-testid': 'x' }, [child, 'text'])`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, attrs?: Attrs | null, children?: (Node | string | null | undefined)[] | string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === false) continue;
      if (k === 'testid') e.dataset.testid = String(v);
      else if (k === 'tip') e.dataset.tip = String(v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (typeof children === 'string') e.textContent = children;
  else if (children) for (const c of children) if (c != null) e.append(c);
  return e;
}

const textCache = new WeakMap<Node, string>();
/** Set textContent only if it changed. */
export function setText(el: Node, text: string): void {
  if (textCache.get(el) === text) return;
  textCache.set(el, text);
  el.textContent = text;
}

/** Toggle a class only if needed (classList.contains is a cheap token lookup). */
export function setClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function setShown(el: Element, shown: boolean): void {
  setClass(el, 'mh-hidden', !shown);
}

const styleCache = new WeakMap<Element, Map<string, string>>();
/** Set one inline style property only if it changed. */
export function setStyle(el: HTMLElement | SVGElement, prop: string, value: string): void {
  let m = styleCache.get(el);
  if (!m) styleCache.set(el, (m = new Map()));
  if (m.get(prop) === value) return;
  m.set(prop, value);
  el.style.setProperty(prop, value);
}

const attrCache = new WeakMap<Element, Map<string, string>>();
export function setAttr(el: Element, name: string, value: string): void {
  let m = attrCache.get(el);
  if (!m) attrCache.set(el, (m = new Map()));
  if (m.get(name) === value) return;
  m.set(name, value);
  el.setAttribute(name, value);
}

/** Re-render a keyed list only when `key` differs from the last call for this container. */
const listKey = new WeakMap<Element, string>();
export function renderKeyed(container: Element, key: string, build: () => (Node | string)[]): boolean {
  if (listKey.get(container) === key) return false;
  listKey.set(container, key);
  container.replaceChildren(...build());
  return true;
}

/** Listener registry so a component can drop everything on dispose. */
export class Disposer {
  private fns: (() => void)[] = [];
  on<T extends EventTarget>(target: T, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions | boolean): void {
    target.addEventListener(type, fn as EventListener, opts);
    this.fns.push(() => target.removeEventListener(type, fn as EventListener, opts));
  }
  add(fn: (() => void) | undefined | null): void {
    if (fn) this.fns.push(fn);
  }
  dispose(): void {
    for (let i = this.fns.length - 1; i >= 0; i--) {
      try {
        this.fns[i]();
      } catch {
        /* keep disposing */
      }
    }
    this.fns.length = 0;
  }
}

export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** camelCase → "Camel case". */
export function humanize(s: string): string {
  return cap(s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
}

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a >= 10000) return `${(n / 1000).toFixed(a >= 100000 ? 0 : 1)}k`;
  if (a >= 100 || Number.isInteger(n)) return String(Math.round(n));
  return n.toFixed(1);
}

export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

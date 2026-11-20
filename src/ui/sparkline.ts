/** Tiny SVG sparkline (line + soft area). `set` is cheap and diffed — call it at ≤ 1 Hz. */
const NS = 'http://www.w3.org/2000/svg';
const W = 100;
const H = 24;
const MAX_POINTS = 80;

export interface Sparkline {
  readonly el: SVGSVGElement;
  /** `key` lets the caller skip redundant redraws (e.g. the recorder's sample count). */
  set(values: readonly number[], key?: string | number): void;
}

/** Path data for a value series scaled into a w×h box (pure; exported for tests). */
export function sparkPath(values: readonly number[], w = W, h = H): { line: string; area: string } {
  let v = values;
  if (v.length > MAX_POINTS) {
    const out: number[] = [];
    const step = v.length / MAX_POINTS;
    for (let i = 0; i < MAX_POINTS; i++) out.push(v[Math.min(v.length - 1, Math.floor((i + 1) * step) - 1)]);
    v = out;
  }
  if (v.length === 0) return { line: '', area: '' };
  let min = Infinity;
  let max = -Infinity;
  for (const x of v) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (min > 0 && min < max * 0.5) min = 0; // anchor at zero unless the series sits far above it
  const span = max - min || 1;
  const n = v.length;
  let line = '';
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? w : (i / (n - 1)) * w;
    const y = h - 1.5 - ((v[i] - min) / span) * (h - 3);
    line += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  if (n === 1) line = `M0 ${line.slice(line.indexOf(' ') + 1)}${line.replace('M', 'L')}`;
  return { line, area: `${line}L${w} ${h}L0 ${h}Z` };
}

export function createSparkline(color = 'var(--mh-accent)', cls = ''): Sparkline {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.setAttribute('preserveAspectRatio', 'none');
  el.setAttribute('class', `mc-spark ${cls}`);
  el.setAttribute('aria-hidden', 'true');
  const area = document.createElementNS(NS, 'path');
  area.setAttribute('fill', color);
  area.setAttribute('opacity', '0.16');
  const line = document.createElementNS(NS, 'path');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '1.4');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  el.append(area, line);
  let last: string | number | undefined;
  return {
    el,
    set(values, key) {
      if (key !== undefined && key === last) return;
      last = key;
      const p = sparkPath(values);
      line.setAttribute('d', p.line);
      area.setAttribute('d', p.area);
    },
  };
}

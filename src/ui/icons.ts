/**
 * Inline SVG icon set (16×16, stroke = currentColor). No emoji / icon fonts so the HUD renders
 * identically in headless Chromium.
 */
const P: Record<string, string> = {
  food: '<path d="M8 2c3 2 4.5 4.5 4.5 7A4.5 4.5 0 0 1 8 13.5 4.5 4.5 0 0 1 3.5 9C3.5 6.5 5 4 8 2z"/><path d="M8 6v5"/>',
  ant: '<circle cx="8" cy="3.6" r="1.6"/><ellipse cx="8" cy="7.3" rx="1.3" ry="1.6"/><ellipse cx="8" cy="11.8" rx="2.1" ry="2.6"/><path d="M6.7 7 3.5 5M9.3 7l3.2-2M6.7 7.8H3M9.3 7.8H13M6.8 8.6 4 11.5M9.2 8.6l2.8 2.9"/>',
  soldier: '<path d="M8 1.8 13 4v4c0 3-2.2 5.2-5 6.2C5.2 13.2 3 11 3 8V4z"/><path d="M8 5v5M5.8 7.5h4.4"/>',
  queen: '<path d="M2.5 5l2.7 3L8 3.5 10.800 8l2.700-3-1 7.500h-9z"/>',
  wing: '<path d="M2 12C4 5 9 2.500 14 3c-.5 4-3 7-7 7.500M2 12c2-.2 4-.6 5-1.500"/>',
  egg: '<ellipse cx="8" cy="8.300" rx="3.300" ry="4.700"/>',
  larva: '<path d="M3 10c0-3 1.500-5 4-5s3 1.500 4.500 1.500S13 6 13 6c.5 3-1.500 5.500-5 5.500S3 11.500 3 10z"/><path d="M6 5.300v6M9 6v5.400"/>',
  pupa: '<ellipse cx="8" cy="8" rx="3" ry="5.200"/><path d="M5.300 6.200h5.400M5 8.300h6M5.400 10.400h5.200"/>',
  sun: '<circle cx="8" cy="8" r="2.800"/><path d="M8 1.500v2M8 12.500v2M1.500 8h2M12.500 8h2M3.400 3.400l1.400 1.400M11.200 11.200l1.400 1.400M3.400 12.600l1.400-1.400M11.200 4.800l1.400-1.400"/>',
  moon: '<path d="M12.500 10A5.500 5.500 0 0 1 6 3.500 5.500 5.500 0 1 0 12.500 10z"/>',
  cloud: '<path d="M4.500 12a2.800 2.800 0 0 1-.3-5.600A3.800 3.800 0 0 1 11.500 6a3 3 0 0 1 0 6z"/>',
  rain: '<path d="M4.500 9.500a2.600 2.600 0 0 1-.3-5.200A3.600 3.600 0 0 1 11.300 4a2.800 2.800 0 0 1 .2 5.500z"/><path d="M5.500 11.500l-.8 2M8.300 11.500l-.8 2M11 11.500l-.8 2"/>',
  wind: '<path d="M2 6h7.500a2 2 0 1 0-2-2M2 9h10a2 2 0 1 1-2 2M2 12h4"/>',
  temp: '<path d="M8 2a1.500 1.500 0 0 0-1.500 1.500v5.300a3 3 0 1 0 3 0V3.500A1.500 1.500 0 0 0 8 2z"/><path d="M8 6v5"/>',
  pause: '<path d="M5.500 3.500v9M10.500 3.500v9" stroke-width="2.200"/>',
  play: '<path d="M5 3.200 12 8l-7 4.800z" fill="currentColor"/>',
  dig: '<path d="M3 13 10 6"/><path d="M8.500 3.500C11 3 12.800 4.800 12.500 7.500L8.500 3.500z" fill="currentColor"/><path d="M2.500 13.500h4"/>',
  build: '<path d="M2.500 4h11v3h-11zM2.500 9.500h5v3h-5zM9.500 9.500h4v3h-4z"/>',
  erase: '<path d="M6 13h7.500M3 10.500 9.500 4l3.500 3.500L7.500 13H5.500z"/><path d="M6.800 6.700l3.500 3.500"/>',
  minus: '<path d="M4 8h8"/>',
  plus: '<path d="M4 8h8M8 4v8"/>',
  flag: '<path d="M4 14V2.500"/><path d="M4 3h8l-2 2.800L12 8.500H4z"/>',
  cut: '<path d="M2 12.500 8 3l6 9.500z"/><path d="M8 3v9.500" stroke-dasharray="1.600 1.400"/>',
  eye: '<path d="M1.500 8c1.800-3 4-4.500 6.500-4.500S12.700 5 14.500 8c-1.800 3-4 4.500-6.500 4.500S3.300 11 1.500 8z"/><circle cx="8" cy="8" r="2"/>',
  follow: '<circle cx="8" cy="8" r="4.500"/><circle cx="8" cy="8" r="1.200" fill="currentColor"/><path d="M8 1.500v2.500M8 12v2.500M1.500 8H4M12 8h2.500"/>',
  help: '<circle cx="8" cy="8" r="6"/><path d="M6.200 6.300A1.900 1.900 0 0 1 8 5c1.100 0 1.900.7 1.900 1.700 0 1.400-1.900 1.500-1.900 2.800"/><circle cx="8" cy="11.600" r=".5" fill="currentColor"/>',
  possess: '<path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3"/><circle cx="8" cy="8" r="2.200"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  exile: '<path d="M6.500 2.500h-4v11h4M6 8h8M11 5l3 3-3 3"/>',
  warn: '<path d="M8 2 14.500 13.500h-13z"/><path d="M8 6.500v3.500"/><circle cx="8" cy="11.700" r=".4" fill="currentColor"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.300v4"/><circle cx="8" cy="5" r=".5" fill="currentColor"/>',
  skull: '<path d="M4 10.500V9A4.500 4.500 0 1 1 12 9v1.500l-1.500.5v2h-5v-2z"/><circle cx="6.300" cy="8" r=".9"/><circle cx="9.700" cy="8" r=".9"/>',
  leaf: '<path d="M3 13C3 7 6.500 3 13 3c0 6.500-4 10-10 10z"/><path d="M3 13 9 7"/>',
  wood: '<rect x="2.500" y="5" width="11" height="6" rx="3"/><path d="M6 5v6"/>',
  drop: '<path d="M8 2c2.500 3.300 4 5.300 4 7.500a4 4 0 0 1-8 0C4 7.300 5.500 5.300 8 2z"/>',
  home: '<path d="M2.500 8 8 3l5.500 5M4 7v6h8V7"/>',
  chevron: '<path d="M4 6l4 4 4-4"/>',
  mouse: '<rect x="4.500" y="2" width="7" height="12" rx="3.500"/><path d="M8 4.500v2.500"/>',
  target: '<circle cx="8" cy="8" r="5.500"/><circle cx="8" cy="8" r="2"/>',
  goal: '<path d="M8 2l1.800 3.800 4.200.5-3.100 2.900.8 4.100L8 11.300l-3.700 2 .8-4.100L2 6.300l4.200-.5z"/>',
  // ---- B5 (colony panel / codex / goals) ----
  check: '<path d="M3.5 8.500 6.500 11.500 12.500 4.500" stroke-width="1.800"/>',
  book: '<path d="M8 4c-1.500-1-3.500-1.300-5.500-1v9.500c2-.3 4 0 5.500 1 1.500-1 3.500-1.300 5.500-1V3c-2-.3-4 0-5.500 1z"/><path d="M8 4v9.500"/>',
  chart: '<path d="M2.500 2.500v11h11"/><path d="M4.500 10.500 7 7.500l2.200 2 3.800-5"/>',
  jobs: '<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="5" cy="4" r="1.100" fill="currentColor"/><circle cx="10.500" cy="8" r="1.100" fill="currentColor"/><circle cx="7" cy="12" r="1.100" fill="currentColor"/>',
  chamber: '<path d="M2 13c0-4 2-9 6-9s6 5 6 9z"/><path d="M6.500 13v-2.500a1.500 1.500 0 0 1 3 0V13"/>',
  hand: '<path d="M5.500 8V3.500a1 1 0 0 1 2 0V7M7.500 7V2.800a1 1 0 0 1 2 0V7M9.500 7V3.800a1 1 0 0 1 2 0V9c0 3-1.500 5-4 5-2 0-3-1-4.200-3.200L2.500 9a1 1 0 0 1 1.700-1L5.500 9.500"/>',
  lamp: '<path d="M5 2.500h6l2 5H3z"/><path d="M8 7.500V13M5.500 13.500h5"/>',
  shield: '<path d="M8 1.800 13 4v4c0 3-2.200 5.200-5 6.200C5.200 13.200 3 11 3 8V4z"/>',
  fungus: '<path d="M2.500 8.500C2.500 5.500 5 3 8 3s5.500 2.500 5.500 5.500z"/><path d="M6.800 8.500v3.500a1.200 1.200 0 0 0 2.400 0V8.500"/>',
  spider: '<circle cx="8" cy="8.500" r="2.300"/><circle cx="8" cy="5.300" r="1.300"/><path d="M6 7.500 2.500 5M6 8.500H2M6.200 9.700 3 12.500M10 7.500 13.500 5M10 8.500h4M9.800 9.700 13 12.500"/>',
};

export type IconName = keyof typeof P & string;

const NS = 'http://www.w3.org/2000/svg';
const cache = new Map<string, SVGSVGElement>();

/** A fresh `<svg class="mh-icon">` for the named icon (falls back to `info`). */
export function icon(name: string, extraClass?: string): SVGSVGElement {
  let proto = cache.get(name);
  if (!proto) {
    proto = document.createElementNS(NS, 'svg');
    proto.setAttribute('viewBox', '0 0 16 16');
    proto.setAttribute('fill', 'none');
    proto.setAttribute('stroke', 'currentColor');
    proto.setAttribute('stroke-width', '1.300');
    proto.setAttribute('stroke-linecap', 'round');
    proto.setAttribute('stroke-linejoin', 'round');
    proto.setAttribute('aria-hidden', 'true');
    proto.innerHTML = P[name] ?? P.info;
    cache.set(name, proto);
  }
  const svg = proto.cloneNode(true) as SVGSVGElement;
  svg.setAttribute('class', extraClass ? `mh-icon ${extraClass}` : 'mh-icon');
  return svg;
}

export function hasIcon(name: string): boolean {
  return name in P;
}

/** Icon for a caste id. */
export function casteIcon(caste: string): string {
  switch (caste) {
    case 'queen':
    case 'king':
      return 'queen';
    case 'soldier':
    case 'nasute':
    case 'major':
      return 'soldier';
    case 'alate':
      return 'wing';
    default:
      return 'ant';
  }
}

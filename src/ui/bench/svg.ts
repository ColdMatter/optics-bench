/**
 * A stand-in for CanvasRenderingContext2D that records what `drawBench` draws as SVG, so the
 * exported image is the bench as drawn on screen, in vector form. It implements only the calls
 * `draw.ts` makes; a new canvas call there needs adding here too.
 */

type Matrix = [number, number, number, number, number, number];

interface State {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  dash: number[];
  transform: Matrix;
  /** `<g clip-path>` groups opened since the matching save(). */
  clipGroups: number;
}

const DEFAULT_FONT = '10px sans-serif';

const num = (v: number) => String(Math.round(v * 100) / 100);

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** A canvas used only to normalise colours and measure text; null without a 2D canvas (jsdom). */
let scratch: CanvasRenderingContext2D | null | undefined;
function scratchContext(): CanvasRenderingContext2D | null {
  if (scratch === undefined) {
    try {
      scratch = document.createElement('canvas').getContext('2d');
    } catch {
      scratch = null;
    }
  }
  return scratch;
}

/**
 * Any CSS colour as `#rrggbb` and an alpha, which every SVG reader understands
 * (Inkscape and Illustrator don't all read `rgb(r g b / a)`).
 */
function svgColour(colour: string): { colour: string; alpha: number } {
  const ctx = scratchContext();
  if (!ctx) return { colour, alpha: 1 };
  ctx.fillStyle = '#000000';
  ctx.fillStyle = colour;
  const out = String(ctx.fillStyle);
  const m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(out);
  if (!m) return { colour: out, alpha: 1 };
  const hex = [m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join('');
  return { colour: `#${hex}`, alpha: m[4] === undefined ? 1 : Number(m[4]) };
}

/** Splits a canvas font shorthand ("600 11px system-ui, …") into SVG attributes. */
function fontAttrs(font: string, scale = 1): { size: number; attrs: string } {
  const m = /^\s*(?:(normal|bold|\d{3})\s+)?([\d.]+)px\s+(.+)$/.exec(font);
  const size = m ? Number(m[2]) : 10;
  const family = m ? m[3]! : 'sans-serif';
  const weight = m?.[1] && m[1] !== 'normal' && m[1] !== '400' ? ` font-weight="${m[1]}"` : '';
  return { size, attrs: `font-family="${escapeXml(family)}" font-size="${num(size * scale)}"${weight}` };
}

export class SvgContext {
  /** What `drawBench` reads for the pixel ratio; the export draws at one unit per CSS pixel. */
  readonly canvas: { width: number; height: number };
  private state: State = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: DEFAULT_FONT,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    dash: [],
    transform: [1, 0, 0, 1, 0, 0],
    clipGroups: 0,
  };
  private stack: State[] = [];
  private path: string[] = [];
  private current: [number, number] | null = null;
  private start: [number, number] | null = null;
  private body: string[] = [];
  private defs: string[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    background: string | null,
  ) {
    this.canvas = { width, height };
    if (background) this.body.push(`<rect width="${num(width)}" height="${num(height)}" fill="${escapeXml(background)}"/>`);
  }

  get fillStyle() { return this.state.fillStyle; }
  set fillStyle(v: string) { this.state.fillStyle = v; }
  get strokeStyle() { return this.state.strokeStyle; }
  set strokeStyle(v: string) { this.state.strokeStyle = v; }
  get lineWidth() { return this.state.lineWidth; }
  set lineWidth(v: number) { if (v > 0 && Number.isFinite(v)) this.state.lineWidth = v; }
  get globalAlpha() { return this.state.globalAlpha; }
  set globalAlpha(v: number) { if (v >= 0 && v <= 1) this.state.globalAlpha = v; }
  get lineCap() { return this.state.lineCap; }
  set lineCap(v: CanvasLineCap) { this.state.lineCap = v; }
  get lineJoin() { return this.state.lineJoin; }
  set lineJoin(v: CanvasLineJoin) { this.state.lineJoin = v; }
  get font() { return this.state.font; }
  set font(v: string) { this.state.font = v; }
  get textAlign() { return this.state.textAlign; }
  set textAlign(v: CanvasTextAlign) { this.state.textAlign = v; }
  get textBaseline() { return this.state.textBaseline; }
  set textBaseline(v: CanvasTextBaseline) { this.state.textBaseline = v; }

  setLineDash(segments: number[]) { this.state.dash = [...segments]; }

  /** Only scale and translate: draw.ts never rotates or skews the context. */
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.state.transform = [a, b, c, d, e, f];
  }

  save() {
    this.stack.push(this.state);
    this.state = { ...this.state, dash: [...this.state.dash], clipGroups: 0 };
  }

  restore() {
    const saved = this.stack.pop();
    if (!saved) return;
    for (let i = 0; i < this.state.clipGroups; i++) this.body.push('</g>');
    this.state = saved;
  }

  private pt(x: number, y: number): [number, number] {
    const [a, , , d, e, f] = this.state.transform;
    return [a * x + e, d * y + f];
  }

  beginPath() {
    this.path = [];
    this.current = null;
    this.start = null;
  }

  moveTo(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const p = this.pt(x, y);
    this.path.push(`M${num(p[0])} ${num(p[1])}`);
    this.current = p;
    this.start = p;
  }

  lineTo(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!this.current) {
      this.moveTo(x, y);
      return;
    }
    const p = this.pt(x, y);
    this.path.push(`L${num(p[0])} ${num(p[1])}`);
    this.current = p;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {
    if (![cpx, cpy, x, y].every(Number.isFinite)) return;
    if (!this.current) this.moveTo(cpx, cpy);
    const c = this.pt(cpx, cpy);
    const p = this.pt(x, y);
    this.path.push(`Q${num(c[0])} ${num(c[1])} ${num(p[0])} ${num(p[1])}`);
    this.current = p;
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, anticlockwise = false) {
    if (![x, y, radius, startAngle, endAngle].every(Number.isFinite) || radius < 0) return;
    const [cx, cy] = this.pt(x, y);
    const r = radius * this.state.transform[0];
    const at = (angle: number): [number, number] => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    const tau = 2 * Math.PI;
    let sweep = endAngle - startAngle;
    if (!anticlockwise && sweep >= tau) sweep = tau;
    else if (anticlockwise && -sweep >= tau) sweep = -tau;
    else {
      sweep %= tau;
      if (!anticlockwise && sweep < 0) sweep += tau;
      if (anticlockwise && sweep > 0) sweep -= tau;
    }
    const first = at(startAngle);
    this.path.push(`${this.current ? 'L' : 'M'}${num(first[0])} ${num(first[1])}`);
    if (!this.start) this.start = first;
    const flag = sweep > 0 ? 1 : 0;
    // SVG can't draw a whole circle as one arc, so a full turn goes in two halves.
    const pieces = Math.abs(sweep) > Math.PI ? 2 : 1;
    for (let i = 1; i <= pieces; i++) {
      const p = at(startAngle + (sweep * i) / pieces);
      this.path.push(`A${num(r)} ${num(r)} 0 0 ${flag} ${num(p[0])} ${num(p[1])}`);
      this.current = p;
    }
  }

  closePath() {
    if (!this.current) return;
    this.path.push('Z');
    this.current = this.start;
  }

  private paint(kind: 'fill' | 'stroke', style: string): string {
    const { colour, alpha } = svgColour(style);
    const opacity = alpha * this.state.globalAlpha;
    let attrs = `${kind}="${escapeXml(colour)}"`;
    if (opacity < 1) attrs += ` ${kind}-opacity="${Math.round(opacity * 1000) / 1000}"`;
    if (kind === 'stroke') {
      const scale = this.state.transform[0];
      attrs += ` stroke-width="${num(this.state.lineWidth * scale)}"`;
      if (this.state.lineCap !== 'butt') attrs += ` stroke-linecap="${this.state.lineCap}"`;
      if (this.state.lineJoin !== 'miter') attrs += ` stroke-linejoin="${this.state.lineJoin}"`;
      if (this.state.dash.length) attrs += ` stroke-dasharray="${this.state.dash.map((v) => num(v * scale)).join(' ')}"`;
    }
    return attrs;
  }

  private pathData(): string | null {
    return this.path.some((cmd) => cmd[0] !== 'M') ? this.path.join('') : null;
  }

  fill() {
    const d = this.pathData();
    if (d) this.body.push(`<path d="${d}" ${this.paint('fill', this.state.fillStyle)}/>`);
  }

  stroke() {
    const d = this.pathData();
    if (d) this.body.push(`<path d="${d}" fill="none" ${this.paint('stroke', this.state.strokeStyle)}/>`);
  }

  clip() {
    const d = this.pathData() ?? 'M0 0';
    const id = `clip${this.defs.length + 1}`;
    this.defs.push(`<clipPath id="${id}"><path d="${d}"/></clipPath>`);
    this.body.push(`<g clip-path="url(#${id})">`);
    this.state.clipGroups++;
  }

  private rect(x: number, y: number, w: number, h: number): string {
    const [x0, y0] = this.pt(x, y);
    const [x1, y1] = this.pt(x + w, y + h);
    return `x="${num(Math.min(x0, x1))}" y="${num(Math.min(y0, y1))}" width="${num(Math.abs(x1 - x0))}" height="${num(Math.abs(y1 - y0))}"`;
  }

  fillRect(x: number, y: number, w: number, h: number) {
    this.body.push(`<rect ${this.rect(x, y, w, h)} ${this.paint('fill', this.state.fillStyle)}/>`);
  }

  strokeRect(x: number, y: number, w: number, h: number) {
    this.body.push(`<rect ${this.rect(x, y, w, h)} fill="none" ${this.paint('stroke', this.state.strokeStyle)}/>`);
  }

  /** The export starts from a blank picture, so clearing has nothing to do. */
  clearRect() {}

  measureText(text: string): TextMetrics {
    const ctx = scratchContext();
    if (ctx) {
      ctx.font = this.state.font;
      return ctx.measureText(text);
    }
    return { width: text.length * fontAttrs(this.state.font).size * 0.55 } as TextMetrics;
  }

  /**
   * How far below the drawing point the alphabetic baseline sits for the current textBaseline.
   * Written out as an offset because Inkscape and Illustrator ignore `dominant-baseline`.
   */
  private baselineShift(size: number): number {
    const baseline = this.state.textBaseline;
    if (baseline === 'alphabetic') return 0;
    const ctx = scratchContext();
    if (ctx) {
      ctx.font = this.state.font;
      ctx.textBaseline = baseline;
      const shift = ctx.measureText('Hg').alphabeticBaseline;
      ctx.textBaseline = 'alphabetic';
      if (Number.isFinite(shift)) return -shift;
    }
    return baseline === 'middle' ? 0.35 * size : baseline === 'top' || baseline === 'hanging' ? 0.8 * size : -0.2 * size;
  }

  private text(kind: 'fill' | 'stroke', text: string, x: number, y: number) {
    if (!text || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const { size, attrs } = fontAttrs(this.state.font, this.state.transform[0]);
    const [px, py] = this.pt(x, y + this.baselineShift(size));
    const align = this.state.textAlign;
    const anchor = align === 'center' ? 'middle' : align === 'right' || align === 'end' ? 'end' : 'start';
    const paint = kind === 'fill' ? this.paint('fill', this.state.fillStyle) : `fill="none" ${this.paint('stroke', this.state.strokeStyle)}`;
    this.body.push(
      `<text x="${num(px)}" y="${num(py)}"${anchor === 'start' ? '' : ` text-anchor="${anchor}"`} ${attrs} ${paint}>${escapeXml(text)}</text>`,
    );
  }

  fillText(text: string, x: number, y: number) {
    this.text('fill', text, x, y);
  }

  strokeText(text: string, x: number, y: number) {
    this.text('stroke', text, x, y);
  }

  /** The finished SVG document, clipped to the picture like the canvas is. */
  toString(): string {
    while (this.stack.length) this.restore();
    const w = num(this.width);
    const h = num(this.height);
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
      `<defs><clipPath id="frame"><rect width="${w}" height="${h}"/></clipPath>${this.defs.join('')}</defs>`,
      `<g clip-path="url(#frame)" stroke-miterlimit="10">`,
      ...this.body,
      '</g>',
      '</svg>',
      '',
    ].join('\n');
  }
}

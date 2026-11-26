/** Exports: the bench as SVG or PNG, and the elements and readouts tables as CSV or Markdown. */
import type { GaussianTrace, SetupTrace } from '../engine/types';
import { drawBench } from './bench/draw';
import { SvgContext } from './bench/svg';
import type { View } from './bench/view';
import type { AppState } from './store';

/** One table as text: a header row, body rows, and notes printed under it. */
export interface ExportTable {
  header: string[];
  rows: string[][];
  notes?: string[];
}

/** Tables, then a list of warnings that belong to none of them. */
export interface ExportTables {
  tables: ExportTable[];
  warnings?: string[];
}

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csvLine = (cells: string[]) => cells.map(csvField).join(',');

/**
 * CSV with a byte-order mark, so Excel reads µ, ₀ and Δ as UTF-8. Several tables are
 * separated by a blank line; notes and warnings are one-cell rows.
 */
export function toCsv({ tables, warnings = [] }: ExportTables): string {
  const blocks = tables.map((t) => [t.header, ...t.rows, ...(t.notes ?? []).map((n) => [n])].map(csvLine).join('\r\n'));
  if (warnings.length) blocks.push(['Warnings', ...warnings].map((w) => csvLine([w])).join('\r\n'));
  return `﻿${blocks.join('\r\n\r\n')}\r\n`;
}

const mdCell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** GitHub-flavoured Markdown tables; columns after the first are right-aligned when `numeric`. */
export function toMarkdown({ tables, warnings = [] }: ExportTables, numeric = false): string {
  const blocks = tables.map((t) => {
    const line = (cells: string[]) => `| ${cells.map(mdCell).join(' | ')} |`;
    const rule = `|${t.header.map((_, i) => (numeric && i > 0 ? ' ---: ' : ' --- ')).join('|')}|`;
    const lines = [line(t.header), rule, ...t.rows.map(line)];
    if (t.notes?.length) lines.push('', ...t.notes.map((n) => `- ${n}`));
    return lines.join('\n');
  });
  if (warnings.length) blocks.push(['**Warnings**', '', ...warnings.map((w) => `- ${w}`)].join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

/** Copies text to the clipboard; false if the browser refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Without the async clipboard API (or permission for it), fall back to a selected textarea.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

interface BenchPicture {
  view: View;
  state: AppState;
  trace: SetupTrace;
  gaussians: GaussianTrace[];
  showRays: boolean;
  showGaussian: boolean;
}

const EXPORT_BACKGROUND = '#ffffff';

/** The bench as it is framed on screen, in the light theme on white, without hover or selection marks. */
function drawPicture(ctx: CanvasRenderingContext2D, pixelRatio: number, p: BenchPicture): void {
  drawBench(ctx, p.view, { ...p.state, selectedId: null }, p.trace, p.gaussians, {
    showRays: p.showRays,
    showGaussian: p.showGaussian,
    hoverZ: null,
    hoverId: null,
    lightTheme: true,
    pixelRatio,
  });
}

export function benchSvg(p: BenchPicture): string {
  const ctx = new SvgContext(p.view.widthPx, p.view.heightPx, EXPORT_BACKGROUND);
  // SvgContext implements the part of the 2D context that drawBench uses.
  drawPicture(ctx as unknown as CanvasRenderingContext2D, 1, p);
  return ctx.toString();
}

/** A PNG at `pixelRatio` device pixels per CSS pixel of the bench. */
export function benchPng(p: BenchPicture, pixelRatio = 3): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(p.view.widthPx * pixelRatio));
  canvas.height = Math.max(1, Math.round(p.view.heightPx * pixelRatio));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('This browser cannot draw to a canvas'));
  drawPicture(ctx, pixelRatio, p);
  // drawBench clears the canvas first, so the background goes in behind afterwards.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = EXPORT_BACKGROUND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded'))), 'image/png'),
  );
}

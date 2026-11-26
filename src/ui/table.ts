import { sortedByAxialStart } from '../engine/trace';
import type { Id, Optic, Setup, Source } from '../engine/types';
import { formatFull, formatShort, h, numberControl, textControl, type Control } from './controls';
import { isSource, kindNames, removeElement, updateElement } from './elements';
import type { ExportTables } from './export';
import { fieldsFor } from './properties';
import type { AppState, Store } from './store';

type Item = Source | Optic;

const shortKind: Record<Item['kind'], string> = {
  point: 'Point',
  collimated: 'Collimated',
  gaussian: 'Gaussian',
  lens: 'Lens',
  ideal: 'Ideal lens',
  slm: 'SLM',
  aperture: 'Aperture',
  screen: 'Screen',
};

interface Row {
  tr: HTMLTableRowElement;
  marker: HTMLElement;
  gap: HTMLElement;
  item: Item;
  refreshers: (() => void)[];
}

function partText(item: Item): string {
  if (isSource(item)) return `${item.wavelengthsNm.join(', ')} nm`;
  if (item.kind === 'lens') return item.flipped ? `${item.prescription.partNumber} (flipped)` : item.prescription.partNumber;
  if (item.kind === 'aperture') return `⌀ ${formatShort(item.diameterMm)} mm`;
  return '—';
}

/** The elements table as text, in the table's order, at full precision. */
export function elementsExport(setup: Setup, warnings: Map<Id, string[]>): ExportTables {
  const ordered: Item[] = [...setup.sources, ...sortedByAxialStart(setup.optics)];
  const rows = ordered.map((item, i) => {
    const previous = ordered[i - 1];
    const part = item.kind === 'ideal' ? `f ${formatFull(item.focalLengthMm)} mm` : partText(item);
    return [
      shortKind[item.kind],
      item.label,
      formatFull(item.z),
      previous ? formatFull(item.z - previous.z) : '',
      part === '—' ? '' : part,
      formatFull(isSource(item) ? item.y : 'decentreMm' in item ? item.decentreMm : NaN),
      (warnings.get(item.id) ?? []).join('; '),
    ];
  });
  const header = ['Type', 'Label', 'z (mm)', 'Δz (mm)', 'Part / f', 'y / decentre (mm)', 'Warnings'];
  return { tables: [{ header, rows }] };
}

export interface ElementsTable {
  render(state: AppState, warnings: Map<Id, string[]>): void;
}

export function createElementsTable(container: HTMLElement, store: Store): ElementsTable {
  const body = h('tbody');
  const table = h(
    'table',
    { class: 'elements' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { class: 'col-mark', 'aria-label': 'Warnings' }),
        h('th', { class: 'col-type' }, 'Type'),
        h('th', { class: 'col-label' }, 'Label'),
        h('th', { class: 'col-num' }, 'z (mm)'),
        h('th', { class: 'col-gap', title: 'Distance in z from the element in the row above' }, 'Δz (mm)'),
        h('th', { class: 'col-part' }, 'Part / f'),
        h('th', { class: 'col-num' }, 'y / decentre (mm)'),
        h('th', { class: 'col-remove', 'aria-label': 'Remove' }),
      ),
    ),
    body,
  );
  container.replaceChildren(table);
  const rows = new Map<Id, Row>();
  let lastSelected: Id | null = null;

  const setKey = (row: Row, key: string, label: string, value: unknown) =>
    store.apply(
      (s) => updateElement(s, row.item.id, (item) => ({ ...item, [key]: value }) as Item),
      `Set ${label} of ${row.item.label || kindNames[row.item.kind]}`,
    );

  function numberCell(row: Row, key: string, unit?: string): HTMLElement {
    const spec = fieldsFor(row.item).find((f) => f.key === key);
    if (!spec) return h('td', { class: 'num muted' }, '—');
    const control: Control = numberControl({
      spec,
      className: 'cell num',
      format: formatShort,
      read: () => (row.item as unknown as Record<string, number>)[key]!,
      commit: (v) => setKey(row, key, spec.label, v),
    });
    row.refreshers.push(control.refresh);
    return h('td', { class: unit ? 'with-unit' : 'num' }, h('div', { class: 'cell-wrap' }, control.input, unit && h('span', { class: 'unit' }, unit)), control.message);
  }

  function createRow(item: Item): Row {
    const tr = h('tr', { 'data-id': item.id });
    const marker = h('span', { class: 'warn-mark', role: 'img' }, '⚠');
    const gap = h('td', { class: 'num muted gap' });
    const row: Row = { tr, marker, gap, item, refreshers: [] };

    const label = textControl({
      label: 'Label',
      className: 'cell text',
      read: () => row.item.label,
      commit: (v) => setKey(row, 'label', 'label', v),
    });
    row.refreshers.push(label.refresh);

    let part: HTMLElement;
    if (item.kind === 'ideal') part = numberCell(row, 'focalLengthMm', 'mm');
    else {
      const text = h('td', { class: 'part' });
      row.refreshers.push(() => {
        text.textContent = partText(row.item);
        text.title = text.textContent;
      });
      part = text;
    }
    const remove = h('button', { class: 'icon-btn remove', title: 'Remove', 'aria-label': 'Remove' }, '×');
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      store.apply((s) => removeElement(s, row.item.id), `Remove ${row.item.label || kindNames[row.item.kind]}`);
    });
    row.refreshers.push(() => remove.setAttribute('aria-label', `Remove ${row.item.label}`));

    tr.append(
      h('td', { class: 'col-mark' }, marker),
      h('td', { class: 'type' }, shortKind[item.kind]),
      h('td', {}, label.input, label.message),
      numberCell(row, 'z'),
      gap,
      part,
      numberCell(row, isSource(item) ? 'y' : 'decentreMm'),
      h('td', { class: 'col-remove' }, remove),
    );
    tr.addEventListener('click', () => store.select(row.item.id));
    tr.addEventListener('focusin', () => store.select(row.item.id));
    return row;
  }

  return {
    render(state, warnings) {
      const { setup, selectedId } = state;
      const ordered: Item[] = [...setup.sources, ...sortedByAxialStart(setup.optics)];
      const seen = new Set<Id>();
      let previous: HTMLTableRowElement | null = null;
      let previousZ: number | null = null;
      for (const item of ordered) {
        seen.add(item.id);
        let row = rows.get(item.id);
        if (!row) {
          row = createRow(item);
          rows.set(item.id, row);
        }
        row.item = item;
        const expectedNext: ChildNode | null = previous ? previous.nextSibling : body.firstChild;
        if (expectedNext !== row.tr) body.insertBefore(row.tr, expectedNext);
        previous = row.tr;
        row.gap.textContent = previousZ === null ? '' : formatShort(item.z - previousZ);
        previousZ = item.z;

        for (const refresh of row.refreshers) refresh();
        const messages = warnings.get(item.id) ?? [];
        row.marker.hidden = messages.length === 0;
        row.marker.title = messages.join('\n');
        row.marker.setAttribute('aria-label', messages.join('; '));
        row.tr.classList.toggle('selected', item.id === selectedId);
        row.tr.setAttribute('aria-selected', String(item.id === selectedId));
      }
      for (const [id, row] of rows) {
        if (!seen.has(id)) {
          row.tr.remove();
          rows.delete(id);
        }
      }
      const firstOptic = ordered.find((i) => !isSource(i));
      for (const [id, row] of rows) row.tr.classList.toggle('first-optic', id === firstOptic?.id && setup.sources.length > 0);
      if (selectedId !== lastSelected) {
        lastSelected = selectedId;
        if (selectedId) rows.get(selectedId)?.tr.scrollIntoView?.({ block: 'nearest' });
      }
    },
  };
}

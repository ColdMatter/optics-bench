/** Small DOM helpers shared by the elements table and the properties panel. */
import type { FieldSpec } from './properties';

type Attrs = Record<string, string | number | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (name === 'class') node.className = String(value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** Whether keystrokes aimed at `target` are text entry, which global shortcuts must leave alone. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(target.type);
}

/** Up to ten significant figures, without trailing zeros or float noise. */
export const formatFull = (v: number) => (Number.isFinite(v) ? String(Number(v.toPrecision(10))) : '');
export const formatShort = (v: number) => (Number.isFinite(v) ? String(Number(v.toFixed(3))) : '');

function parseNumberText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed.replace(/^−/, '-'));
  return Number.isNaN(n) ? null : n;
}

export interface Control {
  input: HTMLInputElement;
  message: HTMLElement;
  refresh(): void;
}

interface EditBehaviour<T> {
  read(): T;
  format(v: T): string;
  parse(text: string): { value: T } | { error: string };
  same(a: T, b: T): boolean;
  commit(v: T): void;
}

/**
 * A text input that applies its value on Enter or blur, shows an inline message instead of
 * applying invalid input, reverts on Escape, and is left alone by `refresh` while being edited.
 */
function editable<T>(input: HTMLInputElement, behaviour: EditBehaviour<T>): Control {
  const message = h('span', { class: 'field-error', role: 'alert' });
  message.hidden = true;
  let dirty = false;

  const showError = (text: string | null) => {
    message.textContent = text ?? '';
    message.hidden = text === null;
    if (text === null) input.removeAttribute('aria-invalid');
    else input.setAttribute('aria-invalid', 'true');
  };
  const refresh = () => {
    if (!dirty) input.value = behaviour.format(behaviour.read());
  };
  const attempt = () => {
    if (!dirty) return;
    const parsed = behaviour.parse(input.value);
    if ('error' in parsed) {
      showError(parsed.error);
      return;
    }
    showError(null);
    dirty = false;
    if (!behaviour.same(parsed.value, behaviour.read())) behaviour.commit(parsed.value);
    refresh();
  };

  input.addEventListener('input', () => (dirty = true));
  input.addEventListener('change', attempt);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attempt();
    else if (e.key === 'Escape' && dirty) {
      dirty = false;
      showError(null);
      refresh();
      e.stopPropagation();
    }
  });
  refresh();
  return { input, message, refresh };
}

function textInput(className: string, numeric: boolean): HTMLInputElement {
  return h('input', {
    type: 'text',
    class: className,
    inputmode: numeric ? 'decimal' : undefined,
    autocomplete: 'off',
    spellcheck: 'false',
  });
}

export function numberControl(opts: {
  spec: FieldSpec;
  read: () => number;
  commit: (v: number) => void;
  format?: (v: number) => string;
  className?: string;
}): Control {
  const input = textInput(opts.className ?? 'num', true);
  input.setAttribute('aria-label', opts.spec.unit ? `${opts.spec.label} (${opts.spec.unit})` : opts.spec.label);
  return editable<number>(input, {
    read: opts.read,
    format: opts.format ?? formatFull,
    same: (a, b) => a === b,
    parse(text) {
      const n = parseNumberText(text);
      if (n === null) return { error: 'Enter a number' };
      const error = opts.spec.validate(n);
      return error ? { error } : { value: n };
    },
    commit: opts.commit,
  });
}

export function numberListControl(opts: {
  spec: FieldSpec;
  read: () => number[];
  commit: (v: number[]) => void;
  allowEmpty: boolean;
  className?: string;
}): Control {
  const input = textInput(opts.className ?? 'num list', true);
  input.setAttribute('aria-label', `${opts.spec.label} (${opts.spec.unit}, separated by commas)`);
  return editable<number[]>(input, {
    read: opts.read,
    format: (v) => v.map(formatFull).join(', '),
    same: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
    parse(text) {
      const parts = text.split(/[,;\s]+/).filter((p) => p !== '');
      if (parts.length === 0 && !opts.allowEmpty) return { error: 'Enter at least one value' };
      const values: number[] = [];
      for (const part of parts) {
        const n = parseNumberText(part);
        if (n === null) return { error: `"${part}" is not a number` };
        const error = opts.spec.validate(n);
        if (error) return { error: `${formatFull(n)}: ${error.charAt(0).toLowerCase()}${error.slice(1)}` };
        values.push(n);
      }
      return { value: values };
    },
    commit: opts.commit,
  });
}

export function textControl(opts: { label: string; read: () => string; commit: (v: string) => void; className?: string }): Control {
  const input = textInput(opts.className ?? 'text', false);
  input.setAttribute('aria-label', opts.label);
  return editable<string>(input, {
    read: opts.read,
    format: (v) => v,
    same: (a, b) => a === b,
    parse: (text) => ({ value: text.trim() }),
    commit: opts.commit,
  });
}

/** Opens the browser's file picker; resolves to null if the user cancels. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

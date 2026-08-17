/**
 * Minimal DOM helpers.
 *
 * The atlas has no UI framework. There are perhaps thirty interactive elements
 * and one of them updates per frame, so a framework would add a build dependency
 * and a diffing pass to solve a problem this file solves in forty lines.
 */

export type Attrs = Record<string, string | number | boolean | undefined>;

/** Creates an element. `class`, `text`, `html` and `on*` keys are handled specially. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k === 'class') node.className = String(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

/** Escapes text for insertion into innerHTML. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A labelled checkbox row. */
export function checkbox(
  label: string,
  checked: boolean,
  onChange: (v: boolean) => void,
  hint?: string,
): HTMLLabelElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const row = el('label', { class: 'ui-check', title: hint ?? '' }, [
    input,
    el('span', { class: 'ui-check-box' }),
    el('span', { class: 'ui-check-label', text: label }),
  ]);
  return row;
}

/** A labelled range slider with a live value readout. */
export function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  format: (v: number) => string,
  onChange: (v: number) => void,
): HTMLDivElement {
  const input = el('input', { type: 'range', min, max, step, value });
  const readout = el('span', { class: 'ui-slider-value', text: format(value) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    readout.textContent = format(v);
    onChange(v);
  });
  return el('div', { class: 'ui-slider' }, [
    el('div', { class: 'ui-slider-head' }, [el('span', { text: label }), readout]),
    input,
  ]);
}

/** A group of mutually exclusive buttons. */
export function segmented(
  options: Array<{ id: string; label: string; title?: string }>,
  selected: string,
  onChange: (id: string) => void,
): HTMLDivElement {
  const wrap = el('div', { class: 'ui-segmented' });
  const buttons = new Map<string, HTMLButtonElement>();
  for (const o of options) {
    const b = el('button', { type: 'button', text: o.label, title: o.title ?? o.label });
    b.addEventListener('click', () => {
      for (const [id, btn] of buttons) btn.classList.toggle('is-active', id === o.id);
      onChange(o.id);
    });
    if (o.id === selected) b.classList.add('is-active');
    buttons.set(o.id, b);
    wrap.append(b);
  }
  return wrap;
}

/** A collapsible titled section. */
export function section(title: string, children: Node[], open = true): HTMLDetailsElement {
  const d = el('details', { class: 'ui-section' });
  if (open) d.setAttribute('open', '');
  d.append(el('summary', { text: title }));
  const body = el('div', { class: 'ui-section-body' }, children);
  d.append(body);
  return d;
}

/** An icon button for the control cluster. */
export function iconButton(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { class: 'ui-icon-btn', type: 'button', title, 'aria-label': title });
  b.innerHTML = glyph;
  b.addEventListener('click', onClick);
  return b;
}

// The key bar for touch screens: what a phone keyboard lacks, in one row. Pressing a key keeps
// focus where it was, so it doesn't pop the keyboard up (or down).
import { icon } from './icons.js';

/** @typedef {import('./term.js').TermView} TermView */
/**
 * @param {HTMLElement} el where the keys go
 * @param {{view: () => TermView | undefined, ctrl: {get(): boolean, set(on: boolean): void}}} opts
 *   view: the terminal keys are sent to; ctrl: the sticky ctrl state
 */
export function keyBar(el, { view, ctrl }) {
  /** @type {{label?: string, icon?: string, title: string, send?: (v: TermView) => string, repeat?: boolean, toggle?: boolean, paste?: boolean}[]} */
  const keys = [
    { label: 'esc', send: () => '\x1b', title: 'Escape' },
    { label: 'tab', send: () => '\t', title: 'Tab' },
    { label: '⇧tab', send: () => '\x1b[Z', title: 'Shift+Tab' },
    { label: 'ctrl', toggle: true, title: 'Ctrl (applies to the next key)' },
    { label: '^C', send: () => '\x03', title: 'Ctrl+C' },
    { icon: 'arrow-left', send: v => v.arrow('D'), repeat: true, title: 'Left' },
    { icon: 'arrow-down', send: v => v.arrow('B'), repeat: true, title: 'Down' },
    { icon: 'arrow-up', send: v => v.arrow('A'), repeat: true, title: 'Up' },
    { icon: 'arrow-right', send: v => v.arrow('C'), repeat: true, title: 'Right' },
    { icon: 'clipboard-paste', paste: true, title: 'Paste' },
  ];
  /** @type {HTMLButtonElement | null} */ let ctrlBtn = null;
  for (const k of keys) {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = b.ariaLabel = k.title;
    if (k.icon) b.append(icon(k.icon)); else b.textContent = k.label ?? '';
    if (k.toggle) {
      ctrlBtn = b;
      b.onclick = () => ctrl.set(!ctrl.get());
    } else if (k.paste) {
      b.onclick = async () => {
        try { const t = await navigator.clipboard.readText(); if (t) view()?.paste(t); } catch {}
      };
    } else {
      let timer = 0;
      const send = k.send ?? (() => '');
      const fire = () => { const v = view(); if (v) v.send(send(v)); };
      const stop = () => { clearTimeout(timer); clearInterval(timer); b.classList.remove('pressed'); };
      b.addEventListener('pointerdown', e => {
        e.preventDefault();
        b.classList.add('pressed');
        fire();
        if (k.repeat) timer = setTimeout(() => { timer = setInterval(fire, 60); }, 380);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
    }
    // Keep focus (and the soft keyboard) where it is.
    b.addEventListener('mousedown', e => e.preventDefault());
    el.append(b);
  }
  return { setCtrl(/** @type {boolean} */ on) { ctrlBtn?.classList.toggle('on', on); if (ctrlBtn) ctrlBtn.ariaPressed = String(on); } };
}

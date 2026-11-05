// Only real buttons show a "Working…" label. Other controls (e.g. the role
// <select> menus) are just disabled: replacing a select's textContent would
// delete all of its <option> elements.
const labelled = control => !control.tagName || control.tagName === 'BUTTON';

export class PendingButtons {
  constructor() { this.buttons = new Map(); }
  begin(button, label = 'Working…') {
    if (!button) return true;
    if (this.buttons.has(button)) return false;
    this.buttons.set(button, { text: labelled(button) ? button.textContent : null, disabled: button.disabled, label });
    button.disabled = true; if (labelled(button)) button.textContent = label; button.setAttribute('aria-busy', 'true');
    return true;
  }
  apply() {
    for (const [button, pending] of this.buttons) {
      button.disabled = true; if (pending.text !== null) button.textContent = pending.label; button.setAttribute('aria-busy', 'true');
    }
  }
  has(button) { return this.buttons.has(button); }
  finish(button, render) {
    const pending = this.buttons.get(button);
    if (!pending) return;
    this.buttons.delete(button); if (pending.text !== null) button.textContent = pending.text; button.removeAttribute('aria-busy');
    if (render) render(); else button.disabled = pending.disabled;
  }
}

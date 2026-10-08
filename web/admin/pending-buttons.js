export class PendingButtons {
  constructor() { this.buttons = new Map(); }
  begin(button, label = 'Working…') {
    if (!button) return true;
    if (this.buttons.has(button)) return false;
    this.buttons.set(button, { text: button.textContent, disabled: button.disabled, label });
    button.disabled = true; button.textContent = label; button.setAttribute('aria-busy', 'true');
    return true;
  }
  apply() {
    for (const [button, pending] of this.buttons) {
      button.disabled = true; button.textContent = pending.label; button.setAttribute('aria-busy', 'true');
    }
  }
  finish(button, render) {
    const pending = this.buttons.get(button);
    if (!pending) return;
    this.buttons.delete(button); button.textContent = pending.text; button.removeAttribute('aria-busy');
    if (render) render(); else button.disabled = pending.disabled;
  }
}

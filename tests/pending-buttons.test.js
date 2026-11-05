import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingButtons } from '../web/admin/pending-buttons.js';

class Button {
  constructor() { this.textContent = 'Start export'; this.disabled = false; this.attributes = new Map(); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name); }
}

for (const outcome of ['success', 'failure']) {
  test(`pending button preserves its action state through a broadcast and restores after ${outcome}`, () => {
    const pending = new PendingButtons(); const button = new Button();
    let eligible = true; let pressed = false;
    const render = () => {
      button.disabled = !eligible;
      button.setAttribute('aria-pressed', String(pressed));
    };
    assert.equal(pending.begin(button, 'Exporting…'), true);
    assert.equal(pending.begin(button, 'Exporting…'), false, 'the same action cannot be submitted twice');
    eligible = outcome === 'failure'; pressed = outcome === 'success'; render(); pending.apply();
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, 'Exporting…');
    assert.equal(button.getAttribute('aria-busy'), 'true');
    pending.finish(button, render);
    assert.equal(button.textContent, 'Start export');
    assert.equal(button.disabled, !eligible, 'the latest eligibility state wins after the action');
    assert.equal(button.getAttribute('aria-pressed'), String(pressed), 'the latest pressed state is restored');
    assert.equal(button.getAttribute('aria-busy'), undefined);
  });
}

test('pending select menus are disabled without replacing their options', () => {
  const pending = new PendingButtons(); const select = new Button();
  select.tagName = 'SELECT'; select.textContent = 'option text'; select.options = ['', 'a', 'b'];
  Object.defineProperty(select, 'textContent', {
    get() { return this.options.join(''); },
    set() { throw new Error('textContent would delete <option> elements'); },
  });
  assert.equal(pending.begin(select, 'Working…'), true);
  assert.equal(select.disabled, true);
  assert.equal(select.getAttribute('aria-busy'), 'true');
  pending.apply();
  assert.equal(pending.has(select), true);
  pending.finish(select);
  assert.equal(select.disabled, false);
  assert.deepEqual(select.options, ['', 'a', 'b']);
  assert.equal(pending.has(select), false);
});

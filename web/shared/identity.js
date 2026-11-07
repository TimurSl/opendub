import { colorHex, initialsOf, isAvatarId, isColorId, MARKERS, PALETTE, AVATAR_IDS } from './identity-data.js';

export { PALETTE, AVATAR_IDS };

// Draws a player's avatar badge. Only allowlisted ids reach CSS or URLs; anything
// else falls back to the neutral color and initials.
export function renderAvatar(player, { size = 28 } = {}) {
  const badge = document.createElement('span');
  badge.className = 'player-avatar';
  badge.style.setProperty('--chip', colorHex(isColorId(player?.color) ? player.color : null));
  badge.style.setProperty('--size', `${size}px`);
  badge.dataset.marker = MARKERS.includes(player?.marker) ? player.marker : 'none';
  badge.setAttribute('aria-hidden', 'true');
  if (isAvatarId(player?.avatar)) {
    badge.classList.add('has-icon');
    badge.style.setProperty('--icon', `url(/shared/avatars/${player.avatar}.svg)`);
  } else badge.textContent = initialsOf(player?.nickname);
  return badge;
}

// One function draws every player chip on every screen.
export function renderPlayerChip(player, { size = 24, label } = {}) {
  const chip = document.createElement('span');
  chip.className = 'player-chip';
  chip.style.setProperty('--chip', colorHex(isColorId(player?.color) ? player.color : null));
  const name = document.createElement('span');
  name.className = 'player-chip-name';
  name.textContent = label ?? (player?.nickname || 'Player');
  chip.append(renderAvatar(player, { size }), name);
  return chip;
}

// Remember the join-screen choice. Storage can be unavailable, so never throw.
const profileKey = 'open-dub-profile';
export function loadProfileChoice() {
  try {
    const saved = JSON.parse(localStorage.getItem(profileKey) || '{}');
    return { color: isColorId(saved.color) ? saved.color : undefined, avatar: isAvatarId(saved.avatar) ? saved.avatar : undefined };
  } catch { return {}; }
}
export function saveProfileChoice({ color, avatar }) {
  try { localStorage.setItem(profileKey, JSON.stringify({ color, avatar })); } catch { /* optional convenience */ }
}

// A swatch row plus an avatar grid. Calls onChange({ color, avatar }) on every pick.
export function renderProfilePicker(container, { color, avatar, taken: initialTaken = new Set(), onChange }) {
  let taken = initialTaken;
  const state = { color, avatar };
  container.replaceChildren();
  const swatches = document.createElement('div'); swatches.className = 'swatch-row'; swatches.setAttribute('role', 'radiogroup'); swatches.setAttribute('aria-label', 'Color');
  const grid = document.createElement('div'); grid.className = 'avatar-grid'; grid.setAttribute('role', 'radiogroup'); grid.setAttribute('aria-label', 'Avatar');
  const refresh = () => {
    for (const button of swatches.children) {
      const selected = button.dataset.id === state.color; const used = taken.has(button.dataset.id);
      button.setAttribute('aria-checked', String(selected)); button.classList.toggle('selected', selected);
      button.classList.toggle('in-use', used && !selected);
      const name = PALETTE.find(entry => entry.id === button.dataset.id)?.name;
      button.setAttribute('aria-label', name + (used && !selected ? ' (in use)' : ''));
    }
    for (const button of grid.children) {
      const selected = (button.dataset.id || null) === (state.avatar || null);
      button.setAttribute('aria-checked', String(selected)); button.classList.toggle('selected', selected);
    }
  };
  const pick = patch => { Object.assign(state, patch); refresh(); onChange?.({ ...state }); };
  for (const entry of PALETTE) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.id = entry.id; button.className = 'swatch';
    button.setAttribute('role', 'radio'); button.style.setProperty('--chip', entry.hex);
    button.addEventListener('click', () => pick({ color: entry.id }));
    swatches.append(button);
  }
  const none = document.createElement('button');
  none.type = 'button'; none.className = 'avatar-choice initials'; none.setAttribute('role', 'radio'); none.setAttribute('aria-label', 'Initials');
  none.textContent = 'Aa'; none.addEventListener('click', () => pick({ avatar: null }));
  grid.append(none);
  for (const id of AVATAR_IDS) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.id = id; button.className = 'avatar-choice';
    button.setAttribute('role', 'radio'); button.setAttribute('aria-label', id);
    button.style.setProperty('--icon', `url(/shared/avatars/${id}.svg)`);
    button.addEventListener('click', () => pick({ avatar: id }));
    grid.append(button);
  }
  container.append(swatches, grid); refresh();
  return { get: () => ({ ...state }), set: ({ taken: nextTaken, ...patch }) => { if (nextTaken) taken = nextTaken; Object.assign(state, patch); refresh(); } };
}

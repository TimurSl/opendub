// Player identity allowlists shared by the server (validation) and the browser
// (rendering). Only these ids ever cross the wire, so no free text from a
// client can reach CSS or an asset URL.
//
// Every color has a relative luminance between 0.12 and 0.30, which keeps it at
// least 3:1 against both the dark (#121212) and light (#ffffff) page
// backgrounds. tests/identity.test.js enforces this.
export const PALETTE = Object.freeze([
  { id: 'red', name: 'Red', hex: '#e5484d' },
  { id: 'orange', name: 'Orange', hex: '#d9731a' },
  { id: 'amber', name: 'Amber', hex: '#b58900' },
  { id: 'lime', name: 'Lime', hex: '#6f9d1d' },
  { id: 'green', name: 'Green', hex: '#2f9e5b' },
  { id: 'teal', name: 'Teal', hex: '#12998e' },
  { id: 'cyan', name: 'Cyan', hex: '#1d96c4' },
  { id: 'blue', name: 'Blue', hex: '#4a7bea' },
  { id: 'violet', name: 'Violet', hex: '#8c6be0' },
  { id: 'purple', name: 'Purple', hex: '#b254c8' },
  { id: 'pink', name: 'Pink', hex: '#d6409f' },
  { id: 'slate', name: 'Slate', hex: '#7a8794' },
]);
export const COLOR_IDS = Object.freeze(PALETTE.map(color => color.id));
// Patterns distinguish players who must share a color once every color is taken.
export const MARKERS = Object.freeze(['none', 'dot', 'stripe']);

export const AVATAR_IDS = Object.freeze([
  'cat', 'dog', 'fox', 'owl', 'bear', 'rabbit', 'frog', 'panda', 'penguin', 'pig',
  'mouse', 'lion', 'koala', 'monkey', 'fish', 'bird', 'duck', 'bee', 'turtle', 'octopus',
  'star', 'heart', 'moon', 'sun', 'bolt', 'cloud', 'flame', 'leaf', 'flower', 'gem',
  'note', 'mic', 'headphones', 'crown', 'ghost', 'robot', 'rocket', 'cup', 'clapper', 'mask',
]);

export const colorHex = id => PALETTE.find(color => color.id === id)?.hex ?? '#7a8794';
export const isColorId = value => typeof value === 'string' && COLOR_IDS.includes(value);
export const isAvatarId = value => typeof value === 'string' && AVATAR_IDS.includes(value);
export const initialsOf = nickname => {
  const parts = String(nickname || '?').trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : [...(parts[0] || '?')].slice(0, 2).join('');
  return letters.toUpperCase();
};

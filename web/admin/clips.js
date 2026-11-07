import { node } from '../shared/api.js';
import { renderPlayerChip } from '../shared/identity.js';
import { clipOrder } from '../shared/clips.js';

const STATUS = { accepted: ['Accepted', 'badge-accepted'], recorded: ['Needs review', 'badge-review'], pending: ['Missing', 'badge-missing'] };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Who asked to redub a clip: an avatar and a name beside the clip, in the order they asked.
export function voterNodes(votes, players) {
  return (votes?.voters ?? []).map(id => players.find(player => player.id === id)).filter(Boolean).map(player => renderPlayerChip(player, { size: 22 }));
}
export const votersKey = (votes, players) => JSON.stringify((votes?.voters ?? []).map(id => { const player = players.find(item => item.id === id); return player ? [player.id, player.nickname, player.color, player.marker, player.avatar] : id; }));

// The clip grid: one tile per recording task, updated in place so a playing take is never interrupted.
// Tiles are ordered with CSS `order`, so clips with more redub requests float to the top as votes arrive.
export function createClipGrid({ container, onAccept, onRedub, onClear, isPending }) {
  const tiles = new Map();
  function build(line, index) {
    const element = node('article', undefined, 'clip-tile');
    const head = node('div', undefined, 'clip-head'); const title = node('strong'); const badge = node('span', '', 'badge');
    head.append(title, badge);
    const caption = node('p', undefined, 'clip-caption'); const meta = node('div', undefined, 'clip-meta'); const owner = node('span', undefined, 'clip-owner'); const times = node('small');
    meta.append(owner, times);
    const audio = node('audio'); audio.controls = true; audio.preload = 'none'; audio.setAttribute('aria-label', `Play clip ${index + 1}`);
    const placeholder = node('span', 'No take yet', 'take-placeholder');
    const requests = node('div', undefined, 'clip-requests'); const requestLabel = node('span', undefined, 'clip-request-count'); const voters = node('span', undefined, 'clip-voters');
    requests.append(requestLabel, voters);
    const actions = node('div', undefined, 'clip-actions');
    const accept = node('button', 'Accept'); accept.type = 'button';
    const redub = node('button', 'Redub', 'secondary'); redub.type = 'button';
    const clear = node('button', 'Dismiss requests', 'link-button'); clear.type = 'button';
    accept.addEventListener('click', () => onAccept(line, accept));
    redub.addEventListener('click', () => onRedub(line, index, redub));
    clear.addEventListener('click', () => onClear(line, clear));
    actions.append(accept, redub, clear);
    element.append(head, caption, meta, audio, placeholder, requests, actions);
    const tile = { element, title, badge, caption, owner, times, audio, placeholder, requests, requestLabel, voters, accept, redub, clear, takeId: null, ownerKey: null, votersKey: null };
    tiles.set(line.id, tile);
    container.append(element);
    return tile;
  }
  return {
    reset() { tiles.clear(); container.replaceChildren(); },
    // `ownerOf(line)` returns the player who owns the line; `filter` is the review filter value.
    render(session, { filter = 'all', ownerOf, canRetake }) {
      const pack = session.pack; if (!pack) return 0;
      const order = clipOrder(pack.lines, session.redubVotes);
      let visible = 0;
      for (const [index, line] of pack.lines.entries()) {
        const tile = tiles.get(line.id) ?? build(line, index);
        const take = session.lineTakes[line.id]; const status = take?.status || 'pending';
        const votes = session.redubVotes?.[line.id]; const owner = ownerOf(line);
        const [label, badgeClass] = STATUS[status];
        tile.title.textContent = `#${index + 1} · ${line.character}`;
        tile.badge.textContent = label; tile.badge.className = `badge ${badgeClass}`;
        tile.caption.textContent = line.caption || (line.captionHidden ? '???' : '');
        const ownerKey = owner ? `${owner.id}:${owner.nickname}:${owner.color}:${owner.marker}:${owner.avatar}` : '';
        if (tile.ownerKey !== ownerKey) { tile.ownerKey = ownerKey; tile.owner.replaceChildren(owner ? renderPlayerChip(owner, { size: 20 }) : node('span', 'No player assigned', 'muted')); }
        tile.times.textContent = `${line.startTime.toFixed(1)}–${line.endTime.toFixed(1)} s`;
        if (take?.id !== tile.takeId) {
          tile.takeId = take?.id; tile.audio.pause();
          if (take) tile.audio.src = take.url; else { tile.audio.removeAttribute('src'); tile.audio.load(); }
        }
        tile.audio.hidden = !take; tile.placeholder.hidden = !!take;
        const count = votes?.count ?? 0;
        tile.requests.hidden = !count;
        tile.requestLabel.textContent = count ? `${plural(count, 'redub request')}` : '';
        const key = votersKey(votes, session.players);
        if (tile.votersKey !== key) { tile.votersKey = key; tile.voters.replaceChildren(...voterNodes(votes, session.players)); }
        tile.accept.hidden = take?.status !== 'recorded';
        if (!isPending(tile.accept)) tile.accept.disabled = !['recording', 'review'].includes(session.state);
        tile.redub.hidden = !canRetake(line, take); tile.redub.textContent = take?.status === 'accepted' ? 'Redub' : 'Ask for retake';
        if (!isPending(tile.redub)) tile.redub.disabled = session.state === 'playback';
        tile.clear.hidden = !count;
        tile.element.classList.toggle('has-requests', count > 0);
        tile.element.classList.toggle('is-blind', !!session.blindLines?.[line.id]);
        tile.element.dataset.status = status;
        tile.element.style.order = String(order.get(line.id));
        tile.element.hidden = filter !== 'all' && status !== filter;
        if (!tile.element.hidden) visible++;
      }
      return visible;
    },
  };
}

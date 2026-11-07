import { fail } from "./store.js";

// Match modes that hand out lines compile to `lineAssignments` ({ lineId: playerId }).
// ownerForLine stays the single source of truth; these functions are pure so they are easy to test.
//
//   line   shuffle every task, deal round robin
//   duet   every character gets two players; its lines alternate between them
//   relay  a character's lines rotate through all players, `relayEvery` lines at a time
//
// `players` is a list of player ids in the order the compiler should favour (the store shuffles it).
// `settings.random` (default Math.random) is only used by `line`.
export function compileAssignments(mode, pack, players, settings = {}) {
  if (!pack) fail("Select a pack first", 409);
  const ids = [...new Set(players)];
  if (!ids.length) fail("At least one connected player is required", 409);
  const assignments = Object.create(null);
  const byCharacter = character => pack.lines.filter(line => line.character === character);
  if (mode === "line") {
    const random = settings.random ?? Math.random;
    const tasks = [...pack.lines];
    for (let index = tasks.length - 1; index > 0; index--) {
      const target = Math.floor(random() * (index + 1));
      [tasks[index], tasks[target]] = [tasks[target], tasks[index]];
    }
    tasks.forEach((line, index) => { assignments[line.id] = ids[index % ids.length]; });
    return assignments;
  }
  if (mode === "duet") {
    // Biggest characters first, each paired with the two least-loaded players.
    const load = new Map(ids.map(id => [id, 0]));
    const characters = pack.characters.map((character, order) => ({ character, order, lines: byCharacter(character) })).sort((a, b) => b.lines.length - a.lines.length || a.order - b.order);
    for (const { lines } of characters) {
      const ranked = [...ids].sort((a, b) => load.get(a) - load.get(b) || ids.indexOf(a) - ids.indexOf(b));
      const pair = [ranked[0], ranked[1] ?? ranked[0]];
      lines.forEach((line, index) => { assignments[line.id] = pair[index % 2]; load.set(pair[index % 2], load.get(pair[index % 2]) + 1); });
    }
    return assignments;
  }
  if (mode === "relay") {
    const every = settings.relayEvery ?? 3;
    if (!Number.isInteger(every) || every < 1) fail("Relay hand-over must be at least one line");
    // Each chunk of `every` lines goes to the least-loaded player who did not just have the character,
    // ties broken in rotation order. Everyone voices every character a bit, and totals stay within `every` lines.
    const load = new Map(ids.map(id => [id, 0]));
    for (const character of pack.characters) {
      const lines = byCharacter(character);
      let previous = null;
      for (let start = 0; start < lines.length; start += every) {
        const chunk = lines.slice(start, start + every);
        const turn = id => previous === null ? ids.indexOf(id) : (ids.indexOf(id) - ids.indexOf(previous) + ids.length) % ids.length;
        const ranked = [...ids].filter(id => ids.length === 1 || id !== previous).sort((a, b) => load.get(a) - load.get(b) || turn(a) - turn(b));
        const owner = ranked[0];
        for (const line of chunk) assignments[line.id] = owner;
        load.set(owner, load.get(owner) + chunk.length);
        previous = owner;
      }
    }
    return assignments;
  }
  fail("This mode does not compile assignments", 409);
}

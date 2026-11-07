// Per-viewer redaction: the last step of snapshot(). Pure: it never mutates its input.
//
// The host sees everything. A player sees blind lines without the hidden parts until the
// reveal. Both the caption text and the reference-audio URL are removed from the pack that
// every player receives, so nothing secret exists in a player's JSON to be read from devtools.
// (The scene video cannot be withheld: it drives recording timing. See docs/ROADMAP.md §4.)
//
// Mystery matches also hide who records what: other players' lines lose their character name,
// and the assignment tables, takes and recorder badges of other players are emptied until the reveal.
// Cards are filtered where they are built (SessionStore.cardsView), by the same reveal flag.
export const HIDDEN_CHARACTER = "???";

export function redactFor(viewer, session, { blindLines = {}, revealed = false, mystery = false } = {}) {
  const flagged = Object.keys(blindLines).length > 0;
  if (viewer.kind === "admin") return flagged ? { ...session, blindLines } : session;
  const hideOwners = mystery && !revealed;
  if (!session.pack || (!flagged && !hideOwners)) return session;
  const secret = !revealed;
  const own = new Set(Object.entries(session.lineAssignments ?? {}).filter(([, playerId]) => playerId === viewer.playerId).map(([lineId]) => lineId));
  const lines = session.pack.lines.map(line => {
    const blind = blindLines[line.id];
    if (!blind && !(hideOwners && !own.has(line.id))) return line;
    const next = { ...line };
    if (blind) {
      next.blind = { ...blind };
      if (secret && blind.caption) { next.caption = ""; next.captionHidden = true; }
      if (secret && blind.reference) { next.referenceAudio = null; next.referenceHidden = true; }
    }
    if (hideOwners && !own.has(line.id)) {
      next.character = HIDDEN_CHARACTER;
      next.segments = (line.segments ?? []).map(segment => ({ ...segment, character: HIDDEN_CHARACTER }));
    }
    return next;
  });
  const result = { ...session, pack: { ...session.pack, lines } };
  if (hideOwners) {
    result.roleAssignments = {};
    result.lineAssignments = Object.fromEntries([...own].map(lineId => [lineId, viewer.playerId]));
    result.players = session.players.map(player => ({ ...player, assignedCharacters: [] }));
    result.lineTakes = Object.fromEntries(Object.entries(session.lineTakes).map(([lineId, take]) => [lineId, own.has(lineId) ? take : { ...take, playerId: null, character: HIDDEN_CHARACTER, recorder: null }]));
  }
  return result;
}

// Asset ids (the last path segment of a reference-audio URL) that players may not fetch yet.
export function hiddenReferenceAssets(pack, blindLines, revealed) {
  const hidden = new Set();
  if (!pack || revealed) return hidden;
  for (const line of pack.lines) if (blindLines[line.id]?.reference && line.referenceAudio) hidden.add(line.referenceAudio.split("/").pop());
  return hidden;
}

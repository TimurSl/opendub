// Per-viewer redaction: the last step of snapshot(). Pure: it never mutates its input.
//
// The host sees everything. A player sees blind lines without the hidden parts until the
// reveal. Both the caption text and the reference-audio URL are removed from the pack that
// every player receives, so nothing secret exists in a player's JSON to be read from devtools.
// (The scene video cannot be withheld: it drives recording timing. See docs/ROADMAP.md §4.)
export function redactFor(viewer, session, { blindLines = {}, revealed = false } = {}) {
  const flagged = Object.keys(blindLines).length > 0;
  if (viewer.kind === "admin") return flagged ? { ...session, blindLines } : session;
  if (!session.pack || !flagged) return session;
  const secret = !revealed;
  const lines = session.pack.lines.map(line => {
    const blind = blindLines[line.id];
    if (!blind) return line;
    const next = { ...line, blind: { ...blind } };
    if (secret && blind.caption) { next.caption = ""; next.captionHidden = true; }
    if (secret && blind.reference) { next.referenceAudio = null; next.referenceHidden = true; }
    return next;
  });
  return { ...session, pack: { ...session.pack, lines } };
}

// Asset ids (the last path segment of a reference-audio URL) that players may not fetch yet.
export function hiddenReferenceAssets(pack, blindLines, revealed) {
  const hidden = new Set();
  if (!pack || revealed) return hidden;
  for (const line of pack.lines) if (blindLines[line.id]?.reference && line.referenceAudio) hidden.add(line.referenceAudio.split("/").pop());
  return hidden;
}

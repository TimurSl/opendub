export function currentStage(session) {
  if (!session.partyCreated || !session.pack) return 1;
  return ({ lobby: 2, assignment: 3, recording: 4, paused: 4, review: 5, playback: 6 })[session.state] || 2;
}

// The furthest stage the host may open. While players record, the Review
// screen is already useful for listening to, accepting, or retaking uploads.
export function maxViewableStage(session) {
  const progress = currentStage(session);
  return progress === 4 ? 5 : progress;
}

// Manual navigation is valid only within the current phase. When the host
// changes phase (or a new match/party starts), follow the authoritative state.
export function reconcileStage(viewedStage, previousProgress, progress, contextChanged, maxStage = progress) {
  if (contextChanged || (previousProgress !== null && previousProgress !== progress)) return null;
  return viewedStage !== null && viewedStage >= 1 && viewedStage <= maxStage ? viewedStage : null;
}

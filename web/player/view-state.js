// The visible stage follows the host's session phase, not this browser's
// microphone permission or the local READY gesture. RECORD requests mic access
// on demand, and SOUNDPAD never needs microphone permission at all.
export function roleView({ state, hasPack, lineMode, hasTasks, rolesLocked }) {
  const picking = hasPack && !lineMode && ['lobby', 'assignment'].includes(state);
  const needsReady = state === 'assignment' && hasTasks;
  const showRoles = picking || needsReady;
  const canPick = picking && !rolesLocked;
  const canReady = state === 'assignment' && hasTasks && !rolesLocked;
  return { showRoles, needsReady, canPick, canReady };
}

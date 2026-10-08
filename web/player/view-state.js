// One source of truth for the player's visible stage. Character claiming opens
// as soon as the host chooses a pack; READY still waits for assignment to open.
export function roleView({ state, hasPack, lineMode, hasTasks, prepared, incomplete, rolesLocked }) {
  const picking = hasPack && !lineMode && ['lobby', 'assignment'].includes(state);
  const needsReady = (state === 'assignment' && hasTasks) ||
    (state === 'recording' && hasTasks && incomplete && !prepared);
  const showRoles = picking || needsReady;
  const canPick = picking && !rolesLocked;
  const canReady = state === 'assignment' && hasTasks && !rolesLocked;
  return { showRoles, needsReady, canPick, canReady };
}

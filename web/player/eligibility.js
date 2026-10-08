export function canRecordSelectedLine({ state, hasTasks, lineId, prepared, hasUnfinishedRequiredLine, activeRetakeLineId = null, hasRetakeAttemptForTab = false }) {
  if (state !== 'recording' || !hasTasks || !lineId || !prepared) return false;
  return hasUnfinishedRequiredLine || (hasRetakeAttemptForTab && activeRetakeLineId === lineId);
}

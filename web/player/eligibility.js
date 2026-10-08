// A recording-stage player with an assigned line can open the recorder before
// granting microphone permission. LineRecorder.record() requests permission on
// the RECORD gesture; SOUNDPAD imports require no microphone at all.
export function canRecordSelectedLine({ state, hasTasks, lineId, hasUnfinishedRequiredLine, activeRetakeLineId = null, hasRetakeAttemptForTab = false }) {
  if (state !== 'recording' || !hasTasks || !lineId) return false;
  return hasUnfinishedRequiredLine || (hasRetakeAttemptForTab && activeRetakeLineId === lineId);
}

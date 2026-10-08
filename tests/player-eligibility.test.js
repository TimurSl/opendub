import test from 'node:test';
import assert from 'node:assert/strict';
import { canRecordSelectedLine } from '../web/player/eligibility.js';

test('an active selected retake stays recordable after the last unfinished line is accepted', () => {
  assert.equal(canRecordSelectedLine({
    state: 'recording', hasTasks: true, lineId: 'line-a', prepared: true,
    hasUnfinishedRequiredLine: false, activeRetakeLineId: 'line-a', hasRetakeAttemptForTab: true,
  }), true);
});

test('global completion does not open another line or a different tab', () => {
  const common = { state: 'recording', hasTasks: true, prepared: true, hasUnfinishedRequiredLine: false };
  assert.equal(canRecordSelectedLine({ ...common, lineId: 'line-b', activeRetakeLineId: 'line-a', hasRetakeAttemptForTab: true }), false);
  assert.equal(canRecordSelectedLine({ ...common, lineId: 'line-a', activeRetakeLineId: 'line-a', hasRetakeAttemptForTab: false }), false);
  assert.equal(canRecordSelectedLine({ ...common, lineId: 'line-b', activeRetakeLineId: 'line-b', hasRetakeAttemptForTab: false }), false);
});

test('unfinished lines remain recordable and capture still requires recording state and readiness', () => {
  const common = { state: 'recording', hasTasks: true, lineId: 'line-b', prepared: true, hasUnfinishedRequiredLine: true };
  assert.equal(canRecordSelectedLine(common), true);
  assert.equal(canRecordSelectedLine({ ...common, state: 'review' }), false);
  assert.equal(canRecordSelectedLine({ ...common, prepared: false }), false);
  assert.equal(canRecordSelectedLine({ ...common, hasTasks: false }), false);
});

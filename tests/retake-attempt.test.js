import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureRuntime } from './helpers.js';

test('retake begin retries are idempotent per attempt and do not expose IDs to snapshots', async t => {
  const lines = [
    { id: 'accepted_line', character: 'Actor', start: 0.1, end: 0.4 },
    { id: 'last_line', character: 'Actor', start: 0.5, end: 0.8 },
  ];
  const host = await startFixtureRuntime(t, { lines });
  const selected = await host.select();
  const settings = await host.admin('/api/admin/settings', {
    gameMode: 'line', freeRolePicking: true, allowMultipleRoles: true, maxRolesPerPlayer: 0,
    autoBalanceSuggestions: true, lockRolesWhenReady: true, referencePlaybackEnabled: true,
    voiceEffectsEnabled: true, compactMobilePreferred: false,
  });
  assert.equal(settings.status, 200);
  const player = await host.join(selected.session, 'Retaker');
  await host.admin('/api/admin/open-lobby', {});
  for (const line of lines) await host.admin('/api/admin/assign-line', { lineId: line.id, playerId: player.id });
  await host.admin('/api/admin/start', {});

  const firstUpload = await host.upload(player, 'accepted_line');
  assert.equal(firstUpload.status, 200);
  const firstAccept = await host.accept(player, 'accepted_line', firstUpload.data.session.lineTakes.accepted_line.id);
  assert.equal(firstAccept.status, 200);

  const begin = attemptId => host.request('/api/takes/accepted_line/retake', {
    method: 'POST', token: player.token, body: { matchId: selected.session.matchId, attemptId },
  });
  const first = await begin('tab-one-attempt');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.session.activeRetakes.length, 1);
  const summary = first.data.session.activeRetakes[0];
  assert.equal(summary.retakeId, undefined);
  assert.equal(summary.id, undefined);
  assert.equal(summary.attemptId, undefined);

  const retry = await begin('tab-one-attempt');
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.retakeId, first.data.retakeId, 'the initiating tab can recover a lost response');

  const competingTab = await begin('tab-two-attempt');
  assert.equal(competingTab.status, 409, 'a different tab cannot adopt the active retake');

  const finalUpload = await host.upload(player, 'last_line');
  assert.equal(finalUpload.status, 200);
  const finalAccept = await host.accept(player, 'last_line', finalUpload.data.session.lineTakes.last_line.id);
  assert.equal(finalAccept.status, 200);
  const completedRetry = await begin('tab-one-attempt');
  assert.equal(completedRetry.status, 200, 'the same active attempt remains recoverable after global completion');
  assert.equal(completedRetry.data.retakeId, first.data.retakeId);
  const newAfterCompletion = await host.request('/api/takes/last_line/retake', {
    method: 'POST', token: player.token, body: { matchId: selected.session.matchId, attemptId: 'new-after-completion' },
  });
  assert.equal(newAfterCompletion.status, 409, 'global completion blocks starting another retake');

  const cancelled = await host.request('/api/takes/accepted_line/retake/cancel', {
    method: 'POST', token: player.token, body: { matchId: selected.session.matchId, retakeId: first.data.retakeId },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.session.lineTakes.accepted_line.status, 'accepted');
});

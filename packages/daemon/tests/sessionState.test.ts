// The product's user-visible session state machine, extracted from Session as a pure
// function so it is testable over plain event objects instead of only through a spawned `claude`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSessionState } from '../src/infrastructure/sessionState.ts';

test('init -> idle', () => {
  assert.equal(deriveSessionState({ type: 'system', subtype: 'init', session_id: 'x', model: 'sonnet' }), 'idle');
});

test('notification permission_prompt -> waiting_approval', () => {
  assert.equal(deriveSessionState({ type: 'system', subtype: 'notification', notification_type: 'permission_prompt' }), 'waiting_approval');
});

test('notification agent_needs_input / idle_prompt -> waiting_input', () => {
  assert.equal(deriveSessionState({ type: 'system', subtype: 'notification', notification_type: 'agent_needs_input' }), 'waiting_input');
  assert.equal(deriveSessionState({ type: 'system', subtype: 'notification', notification_type: 'idle_prompt' }), 'waiting_input');
});

test('notification agent_completed -> idle', () => {
  assert.equal(deriveSessionState({ type: 'system', subtype: 'notification', notification_type: 'agent_completed' }), 'idle');
});

test('assistant -> working; result -> idle', () => {
  assert.equal(deriveSessionState({ type: 'assistant' }), 'working');
  assert.equal(deriveSessionState({ type: 'result' }), 'idle');
});

test('events that imply no transition return null', () => {
  assert.equal(deriveSessionState({ type: 'stream' }), null);
  assert.equal(deriveSessionState({ type: 'system', subtype: 'notification', notification_type: 'something_new' }), null);
  assert.equal(deriveSessionState({ type: 'user' }), null);
  assert.equal(deriveSessionState(null), null, 'a malformed/absent event does not throw');
  assert.equal(deriveSessionState({}), null);
});

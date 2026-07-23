// First dedicated unit test for commands.ts, prompted by adding the `revoke` case, proves
// dispatch logic works without a real socket, which is the whole point of extracting it
// from the composition root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { wire, createCommandHandler } from '../src/application/commands.ts';
import type { ServerEvent } from '@claude-code-remote/protocol';

/** A push registrar that does nothing, for the tests that don't exercise push. */
const noopPush = { register: () => {}, unregister: () => {} } as any;

function harness() {
  const replies: ServerEvent[] = [];
  const disconnected: string[] = [];
  const revokeCalls: string[] = [];
  const historyLimits: number[] = [];
  const identity = {
    revoke: (deviceId: string) => {
      revokeCalls.push(deviceId);
      return deviceId === 'known-device';
    },
  } as any;
  const db = {
    queryRecentApprovals: (limit: number) => {
      historyLimits.push(limit);
      return [{ toolUseId: 't1', sessionId: 's', toolName: 'Bash', requestedAt: 0, decision: 'allow', reason: '', decidedBy: 'x', decidedAt: 1 }];
    },
  } as any;
  const pushRegister: [string, string, string][] = [];
  const pushUnregister: string[] = [];
  const push = {
    register: (deviceId: string, token: string, platform: string) => pushRegister.push([deviceId, token, platform]),
    unregister: (deviceId: string) => pushUnregister.push(deviceId),
  } as any;

  const handleCommand = createCommandHandler({
    sessions: new Map(),
    broker: { decide: () => 'unknown', get: () => undefined } as any,
    jobQueue: { enqueue: () => ({ state: 'failed', error: 'n/a' }) } as any,
    identity,
    db,
    push,
    disconnectDevice: (deviceId: string) => disconnected.push(deviceId),
    log: () => {},
    reply: (_sock, ev) => replies.push(ev),
  });

  return { handleCommand, replies, disconnected, revokeCalls, historyLimits, pushRegister, pushUnregister };
}

test('revoke: unknown device replies with an error and never disconnects anything', () => {
  const { handleCommand, replies, disconnected, revokeCalls } = harness();
  handleCommand({ type: 'revoke', deviceId: 'unknown-device' }, {} as any, 'requester');

  assert.deepEqual(revokeCalls, ['unknown-device']);
  assert.equal(disconnected.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].type, 'error');
});

test('revoke: known device disconnects it and replies with confirmation', () => {
  const { handleCommand, replies, disconnected } = harness();
  handleCommand({ type: 'revoke', deviceId: 'known-device' }, {} as any, 'requester');

  assert.deepEqual(disconnected, ['known-device']);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], { type: 'revoked', deviceId: 'known-device' });
});

test('revoke also forgets the device push token (no push to a device we no longer trust)', () => {
  const { handleCommand, pushUnregister } = harness();
  handleCommand({ type: 'revoke', deviceId: 'known-device' }, {} as any, 'requester');
  assert.deepEqual(pushUnregister, ['known-device']);
});

test('register_push binds the token to the AUTHENTICATED device, not a caller-chosen field', () => {
  const { handleCommand, pushRegister } = harness();
  // The deviceId argument is the sealed frame's authenticated identity; there is no device field in
  // the command for a caller to spoof.
  handleCommand({ type: 'register_push', token: 'ExponentPushToken[abc]', platform: 'ios' }, {} as any, 'auth-device');
  assert.deepEqual(pushRegister, [['auth-device', 'ExponentPushToken[abc]', 'ios']]);
});

test('history: replies with approval_history from the db, defaulting the limit to 50', () => {
  const { handleCommand, replies, historyLimits } = harness();
  handleCommand({ type: 'history' }, {} as any, 'requester');

  assert.deepEqual(historyLimits, [50]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].type, 'approval_history');
});

test('history: an explicit limit is passed through, capped at 500', () => {
  const { handleCommand, historyLimits } = harness();
  handleCommand({ type: 'history', limit: 5 }, {} as any, 'requester');
  handleCommand({ type: 'history', limit: 9999 }, {} as any, 'requester');
  handleCommand({ type: 'history', limit: -3 }, {} as any, 'requester'); // invalid → default

  assert.deepEqual(historyLimits, [5, 500, 50]);
});

test('an unrecognized command type is a loud throw (exhaustiveness guard), never a silent no-op', () => {
  // The compile-time payoff (a new ClientCommand that this switch forgets is a type error) can't be
  // asserted at runtime, but the runtime backstop can: a command type outside the union hits the
  // assertNever default and throws, so in production guardMessage logs it loudly and does NOT ack,
  // rather than the old silent fall-through that acked a command which never ran.
  const { handleCommand } = harness();
  assert.throws(() => handleCommand({ type: 'totally-unknown' } as any, {} as any, 'dev1'),
    /unhandled union member/);
});

// --- a session must leave the fleet map when it exits ---
//
// Sessions were only ever added, never removed, so every session the daemon spawned was retained for
// the process lifetime, unbounded memory, a monotonically growing snapshot, and dead sessions still
// addressable by id (which is what let `send`/`interrupt` reach a dead handle).

class FakeSession extends EventEmitter {
  id: string;
  label = 'demo';
  state = 'working';
  sent: string[] = [];
  interrupts = 0;
  models: string[] = [];
  modes: string[] = [];
  constructor(id: string) { super(); this.id = id; }
  info() { return { id: this.id, label: this.label, state: this.state } as any; }
  send(text: string) { this.sent.push(text); }
  interrupt() { this.interrupts++; }
  setModel(m: string) { this.models.push(m); }
  setPermissionMode(m: string) { this.modes.push(m); }
}

// --- session config commands (model / permission mode / effort coverage) ---

function configHarness() {
  const replies: ServerEvent[] = [];
  const sessions = new Map<string, any>();
  const handleCommand = createCommandHandler({
    sessions,
    broker: { decide: () => 'unknown', get: () => undefined } as any,
    jobQueue: { enqueue: (req: any) => ({ state: 'queued', ...req }) } as any,
    identity: { revoke: () => false } as any,
    db: { queryRecentApprovals: () => [] } as any,
    push: noopPush,
    disconnectDevice: () => {},
    log: () => {},
    reply: (_sock: any, ev: ServerEvent) => replies.push(ev),
  });
  return { handleCommand, replies, sessions };
}

test('set_model steers the running session; unknown session errors', () => {
  const { handleCommand, replies, sessions } = configHarness();
  const s = new FakeSession('sess-1');
  sessions.set('sess-1', s);
  handleCommand({ type: 'set_model', sessionId: 'sess-1', model: 'opus' }, {} as any, 'dev1');
  assert.deepEqual(s.models, ['opus']);
  handleCommand({ type: 'set_model', sessionId: 'nope', model: 'opus' }, {} as any, 'dev1');
  assert.equal(replies.at(-1)!.type, 'error');
});

test('set_permission_mode allows plan, refuses an auto-approving mode', () => {
  const { handleCommand, replies, sessions } = configHarness();
  const s = new FakeSession('sess-1');
  sessions.set('sess-1', s);
  handleCommand({ type: 'set_permission_mode', sessionId: 'sess-1', mode: 'plan' }, {} as any, 'dev1');
  assert.deepEqual(s.modes, ['plan'], 'plan is applied');

  handleCommand({ type: 'set_permission_mode', sessionId: 'sess-1', mode: 'bypassPermissions' as any }, {} as any, 'dev1');
  assert.deepEqual(s.modes, ['plan'], 'the unsafe mode was NOT applied');
  const err = replies.at(-1)!;
  assert.equal(err.type, 'error');
  assert.match((err as any).message, /bypassPermissions/);
});

test('spawn refuses an auto-approving permission mode before enqueuing', () => {
  const { handleCommand, replies } = configHarness();
  handleCommand({ type: 'spawn', cwd: '/tmp/x', permissionMode: 'bypassPermissions' as any }, {} as any, 'dev1');
  assert.equal(replies.at(-1)!.type, 'error', 'the spawn is rejected, not queued');
  assert.match((replies.at(-1) as any).message, /remote approval/i);
});

test('spawn passes model / plan mode / effort through to the queue', () => {
  const { handleCommand } = configHarness();
  const enqueued: any[] = [];
  // re-wire with an enqueue spy
  const sessions = new Map<string, any>();
  const hc = createCommandHandler({
    sessions,
    broker: { decide: () => 'unknown', get: () => undefined } as any,
    jobQueue: { enqueue: (req: any) => { enqueued.push(req); return { state: 'queued' }; } } as any,
    identity: { revoke: () => false } as any,
    db: { queryRecentApprovals: () => [] } as any,
    push: noopPush,
    disconnectDevice: () => {},
    log: () => {},
    reply: () => {},
  });
  hc({ type: 'spawn', cwd: '/tmp/x', label: 'y', model: 'opus', permissionMode: 'plan', effort: 'high' }, {} as any, 'dev1');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].model, 'opus');
  assert.equal(enqueued[0].permissionMode, 'plan');
  assert.equal(enqueued[0].effort, 'high');
});

test('wire: an exited session is dropped from the fleet map', () => {
  const sessions = new Map<string, any>();
  const s = new FakeSession('sess-1');
  wire(s as any, sessions, () => {}, () => {});
  assert.ok(sessions.has('sess-1'), 'a live session is addressable');
  s.emit('exit', 0);
  assert.ok(!sessions.has('sess-1'), 'a dead session is removed, not retained for the process lifetime');
});

test('send/interrupt to an exited session gets the "no session" error, never a dead-handle no-op', () => {
  const replies: ServerEvent[] = [];
  const sessions = new Map<string, any>();
  const handleCommand = createCommandHandler({
    sessions,
    broker: { decide: () => 'unknown', get: () => undefined } as any,
    jobQueue: { enqueue: () => ({ state: 'failed', error: 'n/a' }) } as any,
    identity: { revoke: () => false } as any,
    db: { queryRecentApprovals: () => [] } as any,
    push: noopPush,
    disconnectDevice: () => {},
    log: () => {},
    reply: (_sock, ev) => replies.push(ev),
  });

  const s = new FakeSession('sess-1');
  wire(s as any, sessions, () => {}, () => {});
  s.emit('exit', 0); // the session ends and wire() prunes it

  handleCommand({ type: 'send', sessionId: 'sess-1', text: 'hi' }, {} as any, 'dev1');
  handleCommand({ type: 'interrupt', sessionId: 'sess-1' }, {} as any, 'dev1');

  assert.equal(s.sent.length, 0, 'the dead session was never written to');
  assert.equal(s.interrupts, 0);
  assert.equal(replies.length, 2);
  assert.ok(replies.every((r) => r.type === 'error'), 'both steer commands get an explicit no-session error');
});

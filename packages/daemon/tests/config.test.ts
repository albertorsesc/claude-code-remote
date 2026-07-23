// Environment parsing, with the emphasis on the cases that used to fail OPEN.
//
// Several of these values are safety caps compared with `>=`. Bare Number() returns NaN for
// garbage, and every comparison against NaN is false, so `CC_MAX_PAIRED_DEVICES=abc` did not fall
// back to 50, it removed the pairing cap entirely, silently. These tests pin the replacement
// behavior: understand the value, or refuse to start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/infrastructure/config.ts';

test('defaults apply when nothing is set', () => {
  const c = loadConfig({});
  assert.equal(c.maxPairedDevices, 50);
  assert.equal(c.maxConcurrentSessions, Infinity);
  assert.equal(c.clientTcpPort, null);
  assert.equal(c.clientTcpHost, 'auto');
  assert.equal(c.selfDenyMs, 20 * 60 * 1000);
  assert.equal(c.replayMaxDevices, undefined);
  assert.equal(c.pushEnabled, false, 'push is opt-in: off by default, so no third-party call is made unasked');
  assert.equal(c.pushEndpoint, 'https://exp.host/--/api/v2/push/send');
});

test('push flags parse: enabled accepts the boolean synonyms, endpoint overrides', () => {
  for (const on of ['1', 'true', 'YES', 'on']) {
    assert.equal(loadConfig({ CC_PUSH_ENABLED: on }).pushEnabled, true, `${on} → true`);
  }
  for (const off of ['0', 'false', 'no', 'OFF']) {
    assert.equal(loadConfig({ CC_PUSH_ENABLED: off }).pushEnabled, false, `${off} → false`);
  }
  assert.equal(
    loadConfig({ CC_PUSH_ENDPOINT: 'http://127.0.0.1:9/push' }).pushEndpoint,
    'http://127.0.0.1:9/push',
  );
});

test('a non-boolean CC_PUSH_ENABLED refuses to start rather than silently reading as off', () => {
  assert.throws(() => loadConfig({ CC_PUSH_ENABLED: 'ture' }), ConfigError);
  assert.throws(() => loadConfig({ CC_PUSH_ENABLED: '2' }), ConfigError);
});

test('valid values are honored', () => {
  const c = loadConfig({
    CC_MAX_PAIRED_DEVICES: '2',
    CC_MAX_CONCURRENT_SESSIONS: '1',
    CC_HOOK_SELF_DENY_MS: '120000',
    CC_CLIENT_TCP_PORT: '7443',
    CC_CLIENT_TCP_HOST: '127.0.0.1',
    CC_REPLAY_MAX_DEVICES: '10',
  });
  assert.equal(c.maxPairedDevices, 2);
  assert.equal(c.maxConcurrentSessions, 1);
  assert.equal(c.selfDenyMs, 120000);
  assert.equal(c.clientTcpPort, 7443);
  assert.equal(c.clientTcpHost, '127.0.0.1');
  assert.equal(c.replayMaxDevices, 10);
});

// --- the fail-open cases, now refusals ---

test('a non-numeric cap refuses to start instead of silently disabling the cap', () => {
  // The regression: Number('abc') is NaN, and `paired >= NaN` is false forever, so pairing
  // became unbounded with no warning anywhere.
  for (const bad of ['abc', '10x', 'Infinity', 'NaN']) {
    assert.throws(
      () => loadConfig({ CC_MAX_PAIRED_DEVICES: bad }),
      ConfigError,
      `CC_MAX_PAIRED_DEVICES=${bad} must refuse to start`,
    );
  }
});

test('zero and negative caps are refused (a cap of 0 or -5 is a mistake, not a policy)', () => {
  for (const bad of ['0', '-5', '-1']) {
    assert.throws(() => loadConfig({ CC_MAX_PAIRED_DEVICES: bad }), ConfigError);
  }
});

test('a fractional cap is refused rather than silently truncated', () => {
  assert.throws(() => loadConfig({ CC_MAX_PAIRED_DEVICES: '2.5' }), ConfigError);
});

test('the concurrency cap gets the same treatment', () => {
  assert.throws(() => loadConfig({ CC_MAX_CONCURRENT_SESSIONS: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ CC_MAX_CONCURRENT_SESSIONS: '0' }), ConfigError);
});

test('replay bounds are refused when unparseable', () => {
  assert.throws(() => loadConfig({ CC_REPLAY_MAX_DEVICES: 'lots' }), ConfigError);
  assert.throws(() => loadConfig({ CC_REPLAY_MAX_EVENTS_PER_DEVICE: '-1' }), ConfigError);
});

test('an out-of-range or non-numeric TCP port is refused', () => {
  for (const bad of ['abc', '0', '65536', '-1', '7443.5']) {
    assert.throws(() => loadConfig({ CC_CLIENT_TCP_PORT: bad }), ConfigError, `port ${bad} must be refused`);
  }
});

test('an empty string is treated as unset, not as garbage', () => {
  // Shell scripts export empty values all the time; that should mean "default", not "crash".
  const c = loadConfig({ CC_MAX_PAIRED_DEVICES: '', CC_CLIENT_TCP_PORT: '', CC_REPLAY_MAX_DEVICES: '' });
  assert.equal(c.maxPairedDevices, 50);
  assert.equal(c.clientTcpPort, null);
  assert.equal(c.replayMaxDevices, undefined);
});

test('the refusal message names the variable and the offending value', () => {
  try {
    loadConfig({ CC_MAX_PAIRED_DEVICES: 'abc' });
    assert.fail('should have thrown');
  } catch (err: any) {
    assert.match(err.message, /CC_MAX_PAIRED_DEVICES/);
    assert.match(err.message, /"abc"/);
  }
});

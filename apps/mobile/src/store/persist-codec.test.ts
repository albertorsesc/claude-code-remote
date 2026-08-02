import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeq, parseStoredDevice } from './persist-codec.ts';

test('parseSeq clamps a missing, non-numeric, or negative value to 0', () => {
  assert.equal(parseSeq(null), 0, 'never persisted');
  assert.equal(parseSeq(''), 0);
  assert.equal(parseSeq('not-a-number'), 0, 'a corrupt entry cannot seed the counter');
  assert.equal(parseSeq('-5'), 0, 'a negative value is rejected');
  assert.equal(parseSeq('42'), 42, 'a valid mark is kept');
});

test('parseStoredDevice returns null for missing or corrupt entries, never throws', () => {
  assert.equal(parseStoredDevice(null), null, 'never paired');
  assert.equal(parseStoredDevice('{ not valid json'), null, 'a corrupt entry does not crash hydration');
  const device = { record: { deviceId: 'd' }, deviceName: 'iPad', pairedAt: 1 };
  assert.deepEqual(parseStoredDevice(JSON.stringify(device)), device);
});

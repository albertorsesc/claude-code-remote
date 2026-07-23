// inbound dedup drops replays
// seq is strictly monotonic under interleaved use
//
// The old replayFrom / buffer-overflow gap-detection tests were retired: they tested
// OutboundStream's old ciphertext replay buffer, which was provably unusable across a reconnect
// (a fresh session key every `hello` means old ciphertext is undecryptable garbage) and was never
// called in production either. The same gap-detection algorithm now lives in the daemon's
// DeviceReplayLog (packages/daemon/src/domain/replay.ts, plaintext and seq-addressed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutboundStream, InboundStream } from '@claudecode/protocol';

test('inbound dedup drops replays, including out-of-order', () => {
  const inb = new InboundStream();
  assert.equal(inb.accept(1), true);
  assert.equal(inb.accept(1), false);
  assert.equal(inb.accept(2), true);

  assert.equal(inb.accept(10), true);
  assert.equal(inb.accept(5), true);
  assert.equal(inb.accept(5), false);
});

test('seq is strictly monotonic over 1000 draws', () => {
  const out = new OutboundStream();
  const seqs = Array.from({ length: 1000 }, () => out.next());
  const mono = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
  assert.ok(mono);
});

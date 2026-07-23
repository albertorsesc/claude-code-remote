import fs from 'node:fs';
import path from 'node:path';

/**
 * The client's device record and its outbound sequence numbering.
 *
 * Extracted from cc.ts because the sequence reservation is the one piece of client state shared
 * between CONCURRENT invocations, which makes it the one piece that needs a test of its own, and
 * cc.ts is an entry point that opens sockets on import, so nothing inside it can be unit tested.
 */

export interface DeviceRecord {
  deviceId: string;
  devicePrivateKey: string; // DER base64, this device's own identity
  devicePublicKey: string;
  daemonPublicKey: string;  // DER base64, learned at pairing time
  /** Persisted per-device outbound seq high-water. The daemon's inbound dedup is per-device and
   *  persistent, so each new CLI invocation must continue the sequence rather than restart at 1
   *  (which would collide with the previous invocation's command and get deduped away). */
  outSeq?: number;
}

export function loadDevice(storePath: string): DeviceRecord | null {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Persist just the outbound seq high-water, preserving the rest of the device record. */
export function persistOutSeq(storePath: string, seq: number) {
  const d = loadDevice(storePath);
  if (!d) return;
  d.outSeq = seq;
  saveDevice(storePath, d);
}

/** Synchronous sleep. This process must not continue until it actually holds a sequence number. */
function sleepMs(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reserve the next outbound sequence number, atomically across concurrent invocations.
 *
 * The seq space belongs to the DEVICE, not to this process, because the daemon dedups per device.
 * Reading device.json, incrementing in memory and writing back is a read-modify-write, so two `cc`
 * processes that overlap read the same high-water and allocate the SAME seq. The daemon then treats
 * the second as a duplicate resend and drops it, so a command the user issued never runs.
 *
 * Measured with five concurrent invocations before this existed: only two landed; one exited 0
 * having done nothing at all, and two hung indefinitely waiting for an ack that belonged to another
 * process's command. Silent loss, false success, and a hang, from the same race.
 *
 * An exclusive lock file is the smallest thing that actually fixes it: O_EXCL creation is atomic,
 * and the critical section is two file operations.
 */
export function reserveOutSeq(storePath: string): number {
  const lockPath = `${storePath}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'));   // atomic: EEXIST if another process holds it
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      // A lock older than any plausible critical section belonged to a process that died holding it.
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 10_000) fs.unlinkSync(lockPath);
      } catch { /* another process cleaned it up first */ }
      if (Date.now() > deadline) {
        console.error(`could not reserve a command sequence number: ${lockPath} is held. ` +
          'If no other cc process is running, delete that file.');
        process.exit(1);
      }
      sleepMs(20);
      continue;
    }
    try {
      const rec = loadDevice(storePath);
      const next = (rec?.outSeq ?? 0) + 1;
      persistOutSeq(storePath, next);
      return next;
    } finally {
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }
}

export function saveDevice(storePath: string, d: DeviceRecord) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.chmodSync(storePath, 0o600);
}

// ---------------------------------------------------------------------------
// `cc pair`: plaintext handshake, by necessity, this is how trust is first established.
// Physical possession of the daemon's one-time pairing secret is the authentication.
// ---------------------------------------------------------------------------

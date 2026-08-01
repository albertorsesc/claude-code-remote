#!/usr/bin/env node
// Minimal client. Stands in for both the Warp-tab client and the mobile app,
// they speak the same protocol, so proving it here proves it for both.
//
//   cc pair                         pair this (local) device with the daemon (do this first)
//   cc pair-code                    on the daemon machine: mint an out-of-band code for a SECOND machine
//   cc pair-qr                      on the daemon machine: show a scannable QR of that code, for a phone
//   CC_PAIR_CODE=<code> cc pair     on the second machine: redeem that code, pairing over the network
//   cc watch                        stream fleet + approvals
//   cc history [limit]              print the durable approval decision history
//   cc spawn <cwd> [label] [--model X] [--mode plan] [--effort high]   start a managed session
//   cc send <sessionId> <text...>   steer a session (slash commands ride this too, e.g. "/model opus")
//   cc interrupt <sessionId>
//   cc model <sessionId> <model>    change the running session's model
//   cc mode  <sessionId> <mode>     change permission mode (approval-preserving modes only, e.g. plan)
//   cc effort <sessionId> <level>   change reasoning effort (low|medium|high|xhigh|max) via /effort
//   cc allow <toolUseId> [reason]
//   cc deny  <toolUseId> [reason]
//   cc revoke <deviceId>            revoke a paired device (disconnects it if currently connected)

import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ReliableClient, LineFramer, type SessionCrypto, type ServerEvent } from '@claude-code-remote/protocol';
import {
  generateIdentity, exportPublic, exportPrivate, importPublic, importPrivate,
  deriveSessionKey, seal, open, pairingProof, type KeyPair,
} from '@claude-code-remote/protocol/node';
import { type DeviceRecord, loadDevice, saveDevice, reserveOutSeq } from './deviceStore.ts';
import { encodePairCode, decodePairCode, tcpTargetFromAddr, type PairPayload } from './pairing.ts';
import { encode as encodeQr, renderToTerminal } from './qr.ts';
import { render } from './render.ts';

const SOCK = process.env.CC_CLIENT_SOCK || '/tmp/cc-client.sock';
const DEVICE_STORE = process.env.CC_DEVICE_STORE ||
  path.join(os.homedir(), '.config', 'claude-code-remote', 'device.json');
const WHO = `${os.hostname()}/cli`;
const [cmd, ...rest] = process.argv.slice(2);

/** Connect to a `host:port` target, splitting on the last colon so IPv4/MagicDNS names (no internal
 *  colon) survive. Exits with a clear message on a malformed target. */
function dial(target: string, label = 'address'): net.Socket {
  const i = target.lastIndexOf(':');
  if (i < 0) {
    console.error(`${label} must be host:port, got "${target}"`);
    process.exit(1);
  }
  return net.createConnection({ host: target.slice(0, i), port: Number(target.slice(i + 1)) });
}

/** Connects over CC_CLIENT_TCP_ADDR (host:port, e.g. a Tailscale address) if set, else the local Unix socket. */
function connectToDaemon(): net.Socket {
  const tcpAddr = process.env.CC_CLIENT_TCP_ADDR;
  return tcpAddr ? dial(tcpAddr, 'CC_CLIENT_TCP_ADDR') : net.createConnection(SOCK);
}
const TARGET = process.env.CC_CLIENT_TCP_ADDR || SOCK;

/**
 * Prove possession of the one-time secret and ask the daemon to register this device. The proof
 * binds both public keys, so a relay cannot substitute its own (the MITM on an unauthenticated ECDH).
 * Shared by both pairing flows, local self-pair and out-of-band redemption differ only in where the
 * secret and daemon key come from, not in how the exchange completes.
 */
function sendCompletePair(sock: net.Socket, secret: string, devicePublicKeyB64: string, daemonPubB64: string) {
  const proof = pairingProof(secret, devicePublicKeyB64, daemonPubB64);
  sock.write(JSON.stringify({
    type: 'complete_pair', devicePublicKey: devicePublicKeyB64, deviceName: WHO, proof,
  }) + '\n');
}

/**
 * Persist the newly paired device, report, and exit. The daemon key is passed in rather than read
 * from the `paired` reply: the caller already holds the key it authenticated the proof against.
 */
function savePairedDevice(deviceId: string, keys: KeyPair, devicePublicKeyB64: string, daemonPubB64: string, reach?: string): never {
  saveDevice(DEVICE_STORE, {
    deviceId,
    devicePrivateKey: exportPrivate(keys.privateKey),
    devicePublicKey: devicePublicKeyB64,
    daemonPublicKey: daemonPubB64,
  });
  console.log(`paired. deviceId=${deviceId}`);
  if (reach) console.log(`reach the daemon with:  ${reach}`);
  process.exit(0);
}

function runPair() {
  const sock = connectToDaemon();
  sock.on('error', (e: any) => { console.error(`cannot reach daemon at ${TARGET}: ${e.code ?? e.message}`); process.exit(1); });

  const keys = generateIdentity();
  const devicePublicKeyB64 = exportPublic(keys.publicKey);
  // The daemon key the proof authenticated (from the QR), captured so it, not the value echoed back
  // in the `paired` reply, is what gets persisted. 'paired' only follows 'pair_qr', so it is set.
  let daemonPubB64 = '';

  const framer = new LineFramer({ onLine: (line) => {
    const msg = JSON.parse(line);
    if (msg.type === 'pair_qr') {
      const qr = JSON.parse(msg.qr);
      daemonPubB64 = qr.pk;
      sendCompletePair(sock, qr.s, devicePublicKeyB64, qr.pk);
    } else if (msg.type === 'paired') {
      savePairedDevice(msg.deviceId, keys, devicePublicKeyB64, daemonPubB64);
    } else if (msg.type === 'pair_failed') {
      console.error('pairing failed (secret expired or already used, run cc pair again)');
      process.exit(1);
    }
  } });
  sock.on('connect', () => sock.write(JSON.stringify({ type: 'begin_pair' }) + '\n'));
  sock.on('data', (chunk) => framer.push(chunk.toString('utf8')));
}

/**
 * On the DAEMON machine: run `begin_pair` on the LOCAL socket and hand the resulting one-time payload
 * to `render`, without completing pairing. Shared by `pair-code` (prints a code for a second machine)
 * and `pair-qr` (prints a QR for a phone). Both mint the secret here and carry it out of band; it
 * never leaves over the network, so neither reopens the self-service hole.
 */
function beginPairLocal(emit: (info: { qr: any; code: string; target: string | null }) => void) {
  // begin_pair is local-only by design, so always use the local Unix socket here, never TCP, even if
  // CC_CLIENT_TCP_ADDR is set in this shell.
  const sock = net.createConnection(SOCK);
  sock.on('error', (e: any) => {
    console.error(`cannot reach the local daemon at ${SOCK}: ${e.code ?? e.message}. ` +
      `Run this on the machine running the daemon.`);
    process.exit(1);
  });

  const framer = new LineFramer({ onLine: (line) => {
    const msg = JSON.parse(line);
    if (msg.type === 'pair_qr') {
      const qr = JSON.parse(msg.qr);
      emit({ qr, code: encodePairCode(msg.qr), target: tcpTargetFromAddr(qr.addr) });
      process.exit(0);
    } else if (msg.type === 'pair_failed') {
      console.error('the daemon refused begin_pair (it is local-only, run this on the daemon machine)');
      process.exit(1);
    }
  } });
  sock.on('connect', () => sock.write(JSON.stringify({ type: 'begin_pair' }) + '\n'));
  sock.on('data', (chunk) => framer.push(chunk.toString('utf8')));
}

/** Print the pairing payload as a copy-pasteable code for a SECOND machine (`CC_PAIR_CODE=<code> cc pair`). */
function runPairCode() {
  beginPairLocal(({ qr, code, target }) => {
    console.log('\nPairing code (one use, valid ~3 minutes):\n');
    console.log(`  ${code}\n`);
    if (target) {
      console.log('On the SECOND machine, run:\n');
      console.log(`  CC_PAIR_CODE='${code}' cc pair\n`);
      console.log(`Then reach the daemon from there with:  CC_CLIENT_TCP_ADDR=${target} cc <command>\n`);
    } else {
      console.error(`WARNING: the daemon advertises ${qr.addr}, not a tcp:// address, so a second ` +
        `machine cannot reach it. Set CC_CLIENT_TCP_PORT on the daemon to enable remote pairing.`);
    }
  });
}

/** Render the pairing payload as a scannable QR for a phone. Encodes the same base64url `code` that
 *  `pair-code` prints, so the app decodes it exactly like a pasted `CC_PAIR_CODE`. */
function runPairQr() {
  beginPairLocal(({ qr, code, target }) => {
    console.log('\nScan this with the app to pair (one use, valid ~3 minutes):\n');
    console.log(renderToTerminal(encodeQr(code)));
    console.log(`\nOr redeem it on another machine with:  CC_PAIR_CODE='${code}' cc pair\n`);
    if (!target) {
      console.error(`WARNING: the daemon advertises ${qr.addr}, not a tcp:// address, so a phone ` +
        `cannot reach it. Set CC_CLIENT_TCP_PORT on the daemon to enable remote pairing.`);
    }
  });
}

/**
 * On the SECOND machine: redeem a `CC_PAIR_CODE` minted by `cc pair-code`. The code carries the
 * daemon's address, public key, and the one-time secret (all obtained out of band), so this goes
 * straight to `complete_pair` over the network, it never asks the daemon for a secret. The daemon's
 * public key stored in device.json is taken from the CODE, not the wire: the proof already
 * authenticated it, so trusting the code (not a network reply) for the key is the tighter choice.
 */
function runPairFromCode() {
  let payload: PairPayload;
  try {
    payload = decodePairCode(process.env.CC_PAIR_CODE!);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }

  // The code's own address is the default target; CC_CLIENT_TCP_ADDR overrides it if the operator
  // needs a different route to the same daemon.
  const target = process.env.CC_CLIENT_TCP_ADDR || tcpTargetFromAddr(payload.addr);
  if (!target) {
    console.error(`this pairing code's daemon address (${payload.addr}) is not reachable over TCP. ` +
      `Set CC_CLIENT_TCP_ADDR=host:port to the daemon's tailnet address and retry.`);
    process.exit(1);
  }
  const sock = dial(target, "the pairing code's daemon address");
  sock.on('error', (e: any) => { console.error(`cannot reach daemon at ${target}: ${e.code ?? e.message}`); process.exit(1); });

  const keys = generateIdentity();
  const devicePublicKeyB64 = exportPublic(keys.publicKey);

  const framer = new LineFramer({ onLine: (line) => {
    const msg = JSON.parse(line);
    if (msg.type === 'paired') {
      savePairedDevice(msg.deviceId, keys, devicePublicKeyB64, payload.pk, `CC_CLIENT_TCP_ADDR=${target} cc <command>`);
    } else if (msg.type === 'pair_failed') {
      console.error('pairing failed (code expired or already used, mint a fresh one with `cc pair-code` on the daemon machine)');
      process.exit(1);
    }
  } });
  // Straight to complete_pair, the secret came out of band in the code, so there is no begin_pair.
  sock.on('connect', () => sendCompletePair(sock, payload.s, devicePublicKeyB64, payload.pk));
  sock.on('data', (chunk) => framer.push(chunk.toString('utf8')));
}

if (cmd === 'pair-code') {
  runPairCode();
} else if (cmd === 'pair-qr') {
  runPairQr();
} else if (cmd === 'pair') {
  // Same command, two flows: with an out-of-band code this is the SECOND machine redeeming it over
  // the network; without one it is the local machine bootstrapping trust on the daemon's own socket.
  if (process.env.CC_PAIR_CODE) runPairFromCode();
  else runPair();
} else {
  runAuthenticated();
}

// ---------------------------------------------------------------------------
// Every other command: hello with the stored deviceId, derive the session key, then
// everything is a SealedFrame. No plaintext command execution after this point.
//
// The reliable-delivery state machine (reconnect-replay, inbound dedup, command resend, ack
// accounting) is NOT here, it lives in @claude-code-remote/protocol's ReliableClient, shared byte-for-byte
// with the RN app. This file is only the CLI HOST for that engine: it owns the node:net socket, the
// newline framing, the reconnect backoff timer, the node:crypto adapter, the cross-process seq lock,
// and the render/exit policy below (a one-shot read/write exits on its reply/ack; `watch` streams
// forever). The engine owns everything subtle; the host owns everything platform-specific.
// ---------------------------------------------------------------------------
/** Split `rest` into positionals and `--flag value` options, for the named flags only. */
function parseFlags(args: string[], flags: string[]): { positionals: string[]; opts: Record<string, string> } {
  const positionals: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && flags.includes(a.slice(2))) opts[a.slice(2)] = args[++i];
    else positionals.push(a);
  }
  return { positionals, opts };
}

/**
 * How the host awaits completion, kept with the payload so a command's whole lifecycle is defined in
 * one place: `watch` streams forever; a `write` is one-shot confirmed by its ack; a `read` (and
 * `revoke`) is one-shot confirmed when `terminalEvent` arrives. Adding a command is a single case.
 */
type CommandPlan = { payload: unknown; kind: 'watch' | 'read' | 'write'; terminalEvent?: ServerEvent['type'] };

function resolveCommand(): CommandPlan {
  switch (cmd) {
    case 'watch': return { payload: null, kind: 'watch' };
    case 'history': return { payload: { type: 'history', limit: rest[0] ? Number(rest[0]) : undefined }, kind: 'read', terminalEvent: 'approval_history' };
    case 'spawn': {
      // cc spawn <cwd> [label] [--model X] [--mode plan] [--effort high]
      const { positionals, opts } = parseFlags(rest, ['model', 'mode', 'effort']);
      return { payload: { type: 'spawn', cwd: positionals[0], label: positionals[1], model: opts.model, permissionMode: opts.mode, effort: opts.effort }, kind: 'write' };
    }
    case 'send': return { payload: { type: 'send', sessionId: rest[0], text: rest.slice(1).join(' ') }, kind: 'write' };
    case 'interrupt': return { payload: { type: 'interrupt', sessionId: rest[0] }, kind: 'write' };
    case 'model': return { payload: { type: 'set_model', sessionId: rest[0], model: rest[1] }, kind: 'write' };
    case 'mode': return { payload: { type: 'set_permission_mode', sessionId: rest[0], mode: rest[1] }, kind: 'write' };
    // effort has no control request; it is the `/effort` slash command delivered as user text.
    case 'effort': return { payload: { type: 'send', sessionId: rest[0], text: `/effort ${rest[1]}` }, kind: 'write' };
    case 'allow': return { payload: { type: 'decide', toolUseId: rest[0], decision: 'allow', reason: rest.slice(1).join(' '), by: WHO }, kind: 'write' };
    case 'deny': return { payload: { type: 'decide', toolUseId: rest[0], decision: 'deny', reason: rest.slice(1).join(' '), by: WHO }, kind: 'write' };
    case 'revoke': return { payload: { type: 'revoke', deviceId: rest[0] }, kind: 'write', terminalEvent: 'revoked' };
    default:
      console.error('usage: cc pair|pair-code|watch|history|spawn|send|interrupt|model|mode|effort|allow|deny|revoke');
      return process.exit(1);
  }
}

/**
 * The paired device record, or exit. Returning a non-nullable record rather than null-checking at
 * the call site matters here: the connection callbacks below are closures, and TypeScript re-widens
 * a `| null` binding inside them even after an outer guard, so every use inside connect() would
 * need its own assertion. Making "unpaired" terminate here means the rest of the flow simply has a
 * device.
 */
function requireDevice(): DeviceRecord {
  const d = loadDevice(DEVICE_STORE);
  if (!d) {
    console.error(`not paired. run: cc pair`);
    process.exit(1);
  }
  return d;
}

/** The node:crypto adapter, with this device's keys bound. The engine treats the key opaquely. */
function sessionCryptoFor(device: DeviceRecord): SessionCrypto {
  const priv = importPrivate(device.devicePrivateKey);
  const daemonPub = importPublic(device.daemonPublicKey);
  return {
    deriveKey: (saltB64) => deriveSessionKey(priv, daemonPub, Buffer.from(saltB64, 'base64')),
    seal: (key, seq, plaintext, direction) => seal(key as Buffer, seq, plaintext, direction),
    open: (key, frame, direction) => open(key as Buffer, frame, direction),
  };
}

function runAuthenticated() {
  const device = requireDevice();

  const RECONNECT_MAX_ATTEMPTS = Number(process.env.CC_RECONNECT_MAX_ATTEMPTS || 10);
  const RECONNECT_BASE_MS = Number(process.env.CC_RECONNECT_BASE_MS || 1000);
  const RECONNECT_MAX_DELAY_MS = Number(process.env.CC_RECONNECT_MAX_DELAY_MS || 15000);

  const { payload, kind, terminalEvent } = resolveCommand();
  const isWatch = kind === 'watch';
  const isRead = kind === 'read';
  const isWrite = kind === 'write';
  const isRevokeSelf = cmd === 'revoke' && rest[0] === device.deviceId;

  // Host-side lifecycle state (the reliability state is inside `client`).
  let myCmdSeq = 0;      // the seq of this process's one write command
  let issued = false;    // writes are issued exactly once; reconnects rely on the engine's resend
  let everConnected = false;
  let attempt = 0;

  const client = new ReliableClient({
    deviceId: device.deviceId,
    crypto: sessionCryptoFor(device),
    // Reserved under a cross-process lock: the seq space is per device, so concurrent `cc`
    // invocations must not both draw the same number (the daemon would dedup one away).
    nextSeq: () => reserveOutSeq(DEVICE_STORE),

    onReady: ({ resumed, replayedCount }) => {
      if (everConnected) {
        console.error(resumed
          ? `[reconnected, resumed, ${replayedCount} event(s) replayed]`
          : `[reconnected, resynced]`);
      }
      everConnected = true;
      attempt = 0; // backoff resets only once the handshake actually completes
      // Issue this process's command: reads reissue fresh every connect (a deduped read yields no
      // reply); a write is issued exactly once, then auto-resent by the engine on later reconnects.
      if (isRead && payload) client.send(payload, { reliable: false });
      else if (isWrite && payload && !issued) { myCmdSeq = client.send(payload, { reliable: true }); issued = true; }
    },

    onAck: () => {
      if (isWrite && issued && client.lastAcked >= myCmdSeq) process.exit(0); // command confirmed
    },

    onEvent: (ev) => {
      if (isWatch) { render(ev); return; }
      // One-shot (read or write): render its own reply/error, then exit. Anything else
      // (session_list/session_update/job_update/stream) is not this command's business, ignore it
      // and keep waiting for the ack/reply.
      if (ev.type === 'error') { render(ev); process.exit(1); }
      if (terminalEvent && ev.type === terminalEvent) { render(ev); process.exit(0); }
    },

    onHelloRejected: () => {
      if (isRevokeSelf) {
        // We revoked our own device; the daemon no longer recognizes us, that IS success.
        console.log(`  revoked device ${device.deviceId} (confirmed on reconnect)`);
        process.exit(0);
      }
      console.error('daemon did not recognize this device (fresh daemon identity, or paired ' +
        'to a different daemon). run: cc pair');
      process.exit(1);
    },

    onAuthError: () => console.error('received a frame that failed to authenticate, dropped'),
  });

  function connect() {
    const sock = connectToDaemon();
    const flush = () => { for (const o of client.drain()) sock.write(JSON.stringify(o) + '\n'); };

    sock.on('error', (e: any) => {
      if (!everConnected) {
        // Fail fast if we can't reach the daemon on the very first attempt (daemon not running).
        console.error(`cannot reach daemon at ${TARGET}: ${e.code ?? e.message}`);
        process.exit(1);
      }
      // After we've connected once, a drop is handled by 'close' (reconnect + resend).
    });

    sock.on('connect', () => { client.onOpen(); flush(); });

    const framer = new LineFramer({
      onLine: (line) => { client.onMessage(JSON.parse(line)); flush(); }, // resends, issued command, hello all leave in order
      maxBytes: 16 * 1024 * 1024, // drop a peer that streams without a frame boundary rather than grow unbounded
      onOverflow: (n, cap) => { console.error(`[dropping connection: ${n} bytes with no frame boundary (cap ${cap})]`); sock.destroy(); },
    });
    sock.on('data', (chunk) => framer.push(chunk.toString('utf8')));

    sock.on('close', () => {
      client.onClose();
      if (attempt >= RECONNECT_MAX_ATTEMPTS) {
        console.error(`[connection lost, gave up after ${RECONNECT_MAX_ATTEMPTS} attempts]`);
        process.exit(1);
      }
      attempt++;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
      console.error(`[reconnecting... attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS}, retrying in ${delay}ms]`);
      setTimeout(connect, delay);
    });
  }

  connect();
}


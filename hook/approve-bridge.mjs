#!/usr/bin/env node
// Approval bridge: the security boundary of this product.
//
// Claude Code fails OPEN on every degraded hook path: a crash, hang, garbage output,
// empty output, or being killed by the settings timeout all execute the tool.
// So this file has one job: ALWAYS print a
// valid decision, and make that decision "deny" unless something explicitly allowed it.
//
// Deliberately plain .mjs with zero dependencies and no imports beyond node:net.
// Every import is another way to fail open.

import net from 'node:net';

const SOCKET = process.env.CC_DAEMON_SOCK || '/tmp/cc-daemon.sock';

// Must be strictly below the `timeout` in settings.json, or the runtime kills us
// mid-wait and the tool runs. Margin is intentional and load-bearing.
const SELF_DENY_MS = Number(process.env.CC_HOOK_SELF_DENY_MS || 20 * 60 * 1000);

let settled = false;

function decide(decision, reason) {
  if (settled) return;
  settled = true;
  // stdout must contain exactly one JSON object and nothing else.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

const deny = (why) => decide('deny', why);

// Belt and braces: nothing may escape without a decision.
process.on('uncaughtException', (e) => deny(`bridge error: ${e?.message ?? e}`));
process.on('unhandledRejection', (e) => deny(`bridge rejection: ${e?.message ?? e}`));
const selfDeny = setTimeout(() => deny('no decision before bridge deadline'), SELF_DENY_MS);
selfDeny.unref?.();

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    return deny('unparseable hook payload');
  }

  const sock = net.createConnection(SOCKET);
  sock.setNoDelay(true);

  // Daemon unreachable, socket closed, or any transport error => deny locally.
  // The bridge must never depend on the daemon being alive to stay safe.
  sock.on('error', (e) => deny(`daemon unreachable: ${e?.code ?? e?.message ?? 'error'}`));
  sock.on('close', () => deny('daemon closed connection before deciding'));

  sock.on('connect', () => {
    sock.write(JSON.stringify({ kind: 'approval_request', event }) + '\n');
  });

  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return deny('malformed daemon response');
      }
      if (msg.kind !== 'approval_decision') continue;
      // Only an explicit, well-formed allow may open the gate.
      if (msg.decision === 'allow') {
        return decide('allow', msg.reason || 'approved remotely');
      }
      return deny(msg.reason || 'rejected remotely');
    }
  });
}

main().catch((e) => deny(`bridge fatal: ${e?.message ?? e}`));

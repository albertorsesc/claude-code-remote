import net from 'node:net';
import type { PendingApproval, ServerEvent, SessionInfo } from '@claude-code-remote/protocol';
import type { ApprovalBroker } from '../domain/approvals.ts';
import type { Logger } from '../application/ports.ts';
import { guardMessage } from './messageGuard.ts';

/** What the bridge needs to know about the session that owns a tool call. The pending-approval set
 *  is the session's own state, so it is mutated through intent-revealing methods rather than by
 *  exposing the raw Set, the bridge tells the session, it does not reach into it. */
export interface ApprovalOwner {
  id: string;
  label: string;
  trackPendingApproval(toolUseId: string): void;
  untrackPendingApproval(toolUseId: string): void;
  info(): SessionInfo;
}

export interface HookBridgeDeps {
  broker: ApprovalBroker;
  /** Maps the hook's `session_id` (Claude's own id) to the session this daemon spawned. */
  sessionByClaudeId: (claudeSessionId: string | undefined) => ApprovalOwner | undefined;
  selfDenyMs: number;
  broadcast: (ev: ServerEvent) => void;
  log: Logger;
}

/** A hook payload carries tool_input, which can be a whole file edit, generous, but not infinite. */
const MAX_HOOK_LINE = 8 * 1024 * 1024;

/**
 * The hook bridge socket: one connection per blocked tool call, held open until decided.
 *
 * This is a delivery mechanism, not policy. It translates the bridge's line protocol into a
 * PendingApproval, hands it to the broker (which owns the actual first-decision-wins arbitration),
 * and writes the decision back. The connection staying open IS the block: the tool call cannot
 * proceed until something answers, and if this process dies the bridge denies on its own side.
 */
export function createHookServer(deps: HookBridgeDeps): net.Server {
  const { broker, sessionByClaudeId, selfDenyMs, broadcast, log } = deps;

  return net.createServer((sock) => {
    let buf = '';
    // The toolUseIds THIS socket actually claimed in the broker. Only these may be abandoned when
    // the socket closes, a duplicate whose open() was rejected must not abandon the legitimate
    // first request that owns the id (its socket-close would otherwise deny the real blocked hook).
    const claimed = new Set<string>();

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_HOOK_LINE) {
        log(`hook bridge: ${buf.length} bytes with no newline (cap ${MAX_HOOK_LINE}), dropping connection`);
        buf = '';
        sock.destroy();   // the bridge fails closed on its own side, so the tool call is denied
        return;
      }
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;

        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.kind !== 'approval_request') continue;

        // Guarded: this is where a duplicate tool_use_id once threw a UNIQUE violation out of the
        // socket callback and killed the daemon, abandoning every pending approval on the machine.
        guardMessage(log, 'opening an approval request from the hook bridge', () => {
          const event = msg.event ?? {};
          const toolUseId: string = event.tool_use_id ?? `${event.session_id}-${Date.now()}`;
          const owner = sessionByClaudeId(event.session_id);

          const approval: PendingApproval = {
            toolUseId,
            sessionId: owner?.id ?? event.session_id ?? 'unknown',
            toolName: event.tool_name ?? 'unknown',
            toolInput: event.tool_input ?? {},
            description: event.tool_input?.description,
            requestedAt: Date.now(),
            deadlineAt: Date.now() + selfDenyMs,
          };

          const won = broker.open(approval, {
            respond: (decision, reason) => {
              try {
                sock.write(JSON.stringify({ kind: 'approval_decision', decision, reason }) + '\n');
              } catch { /* bridge already gone; it denies on its own side */ }
              owner?.untrackPendingApproval(approval.toolUseId);
              if (owner) broadcast({ type: 'session_update', session: owner.info() });
            },
          });

          if (!won) {
            // Another live request already owns this tool_use_id. Fail THIS duplicate closed on its
            // own side and register nothing: no pendingApprovals entry, no broadcast, and crucially
            // not in `claimed`, so this socket's close cannot abandon the real request. The operator
            // keeps seeing (and the audit keeps) the first request's content.
            try {
              sock.write(JSON.stringify({ kind: 'approval_decision', decision: 'deny', reason: 'duplicate tool_use_id already pending' }) + '\n');
            } catch { /* peer already gone */ }
            log(`hook bridge: duplicate approval_request for ${toolUseId}, denied (already claimed)`);
            sock.destroy();
            return;
          }

          claimed.add(toolUseId);
          owner?.trackPendingApproval(approval.toolUseId);
          log(`approval pending: ${approval.toolName} in ${owner?.label ?? '?'} (${approval.toolUseId})`);
          broadcast({ type: 'approval_pending', approval });
          if (owner) broadcast({ type: 'session_update', session: owner.info() });
        });
      }
    });

    // Bridge disappeared before a decision: it fails closed locally, so just clean up. Only the ids
    // this socket actually claimed are abandoned; a decided id no-ops in abandon(), and a rejected
    // duplicate was never added, so it cannot deny the request that legitimately owns the id.
    sock.on('close', () => { for (const id of claimed) broker.abandon(id); });
    sock.on('error', () => { /* bridge handles its own failure */ });
  });
}

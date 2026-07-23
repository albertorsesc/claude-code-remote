import type net from 'node:net';
import type { SessionHandle } from './ports.ts';
import type { ApprovalBroker } from '../domain/approvals.ts';
import type { ApprovalHistoryReader, DeviceTrustRegistry, JobEnqueuer, Logger, PushRegistrar } from './ports.ts';
import { permissionModeIsAllowed, permissionModeRefusal } from '../domain/permissionMode.ts';
import { assertNever, type ClientCommand, type ServerEvent } from '@claudecode/protocol';

/** Wires a spawned session's events to broadcasts. Called once per session, from the job queue. */
export function wire(
  session: SessionHandle,
  sessions: Map<string, SessionHandle>,
  broadcast: (ev: ServerEvent) => void,
  log: Logger,
) {
  sessions.set(session.id, session);
  session.on('state', () => broadcast({ type: 'session_update', session: session.info() }));
  session.on('stream', (ev) => broadcast({ type: 'stream', sessionId: session.id, event: ev }));
  session.on('exit', () => {
    // Broadcast the terminal transition ONCE, then drop the session from the live fleet map. Its
    // history is durable (recordSessionEnded), so nothing is lost; keeping the dead Session here
    // leaked its EventEmitter and stdout buffer for the daemon's lifetime, made every reconnecting
    // device's snapshot grow without bound, and left the exited session addressable by id, which is
    // what let `send`/`interrupt` reach a dead handle. Removed, those commands hit the "no session"
    // error path instead.
    broadcast({ type: 'session_update', session: session.info() });
    log(`session ${session.label} (${session.id}) exited`);
    sessions.delete(session.id);
  });
  broadcast({ type: 'session_update', session: session.info() });
}

export function createCommandHandler(deps: {
  sessions: Map<string, SessionHandle>;
  broker: ApprovalBroker;
  jobQueue: JobEnqueuer;
  identity: DeviceTrustRegistry;
  db: ApprovalHistoryReader;
  push: PushRegistrar;
  /** Closes the live connection for a device, if any, the socket-map scan lives in index.ts,
   *  since commands.ts has no reason to know about sockets beyond the one it's replying to. */
  disconnectDevice: (deviceId: string) => void;
  log: Logger;
  reply: (sock: net.Socket, ev: ServerEvent) => void;
}) {
  const { sessions, broker, jobQueue, identity, db, push, disconnectDevice, log, reply } = deps;

  return function handleCommand(cmd: ClientCommand, sock: net.Socket, deviceId: string) {
    const send = (ev: ServerEvent) => reply(sock, ev);

    switch (cmd.type) {
      case 'list':
        return send({ type: 'session_list', sessions: [...sessions.values()].map((s) => s.info()) });

      case 'history': {
        const limit = Number.isInteger(cmd.limit) && cmd.limit! > 0 ? Math.min(cmd.limit!, 500) : 50;
        return send({ type: 'approval_history', approvals: db.queryRecentApprovals(limit) });
      }

      case 'spawn': {
        // Refuse a permission mode that would let a tool run without a remote decision, before
        // enqueuing, so a client gets the immediate, exact error contract for a rejected spawn.
        if (cmd.permissionMode && !permissionModeIsAllowed(cmd.permissionMode)) {
          return send({ type: 'error', message: permissionModeRefusal(cmd.permissionMode) });
        }
        // enqueue() is synchronous-feeling for the common (unbounded-concurrency) case: a
        // margin-check failure resolves immediately, so reply directly to preserve the exact
        // client-visible error contract from before the job queue existed. Later transitions
        // (real queueing, async margin re-check, session exit) have no requester to reply to,
        // those go out only as job_update broadcasts, which every client already gets.
        const job = jobQueue.enqueue(
          {
            cwd: cmd.cwd, label: cmd.label, disallowedTools: cmd.disallowedTools,
            model: cmd.model, permissionMode: cmd.permissionMode, effort: cmd.effort,
          },
          deviceId,
        );
        if (job.state === 'failed') {
          return send({ type: 'error', message: job.error! });
        }
        return;
      }

      case 'send': {
        const s = sessions.get(cmd.sessionId);
        if (!s) return send({ type: 'error', message: `no session ${cmd.sessionId}` });
        s.send(cmd.text);
        return;
      }

      case 'interrupt': {
        const s = sessions.get(cmd.sessionId);
        if (!s) return send({ type: 'error', message: `no session ${cmd.sessionId}` });
        s.interrupt();
        return;
      }

      case 'set_model': {
        const s = sessions.get(cmd.sessionId);
        if (!s) return send({ type: 'error', message: `no session ${cmd.sessionId}` });
        s.setModel(cmd.model);
        log(`set model ${cmd.model} on ${cmd.sessionId} (by ${deviceId})`);
        return;
      }

      case 'set_permission_mode': {
        const s = sessions.get(cmd.sessionId);
        if (!s) return send({ type: 'error', message: `no session ${cmd.sessionId}` });
        if (!permissionModeIsAllowed(cmd.mode)) {
          return send({ type: 'error', message: permissionModeRefusal(cmd.mode) });
        }
        s.setPermissionMode(cmd.mode);
        log(`set permission mode ${cmd.mode} on ${cmd.sessionId} (by ${deviceId})`);
        return;
      }

      case 'decide': {
        // Bind the decision to the AUTHENTICATED device. `cmd.by` is a human label the caller
        // chooses and is not evidence of anything, it was previously written into the permanent
        // audit trail verbatim, so any paired device could attribute its own approvals to another
        // operator. The deviceId comes from the sealed frame's authentication, so it goes FIRST:
        // a caller cannot spoof it and cannot prepend anything ahead of it.
        const attribution = `${deviceId} (${cmd.by})`;
        const outcome = broker.decide(cmd.toolUseId, cmd.decision, cmd.reason ?? '', attribution);
        if (outcome === 'unknown') {
          return send({ type: 'error', message: `no pending approval ${cmd.toolUseId}` });
        }
        if (outcome === 'already') {
          const a = broker.get(cmd.toolUseId);
          return send({ type: 'error', message: `already decided by ${a?.decision?.by}` });
        }
        log(`decision ${cmd.decision} by ${attribution} for ${cmd.toolUseId}`);
        return;
      }

      case 'revoke': {
        const ok = identity.revoke(cmd.deviceId);
        if (!ok) return send({ type: 'error', message: `no such device ${cmd.deviceId}` });
        // A revoked device is no longer trusted, so it must no longer be a push target: forget its
        // token here, in the same "stop knowing this device" step as the trust and socket teardown.
        push.unregister(cmd.deviceId);
        // Confirm BEFORE disconnecting: revoking your own device closes your own socket, so a
        // reply sent after disconnectDevice() would have nowhere to go. Order is irrelevant when
        // revoking a different device (its socket, not the requester's, is the one being closed).
        send({ type: 'revoked', deviceId: cmd.deviceId });
        disconnectDevice(cmd.deviceId);
        log(`revoked device ${cmd.deviceId} (requested by ${deviceId})`);
        return;
      }

      case 'register_push': {
        // Bound to the AUTHENTICATED device (the sealed frame's deviceId), never a field the caller
        // chooses, the same rule `decide` follows, so one device can never register a push token
        // under another's identity.
        push.register(deviceId, cmd.token, cmd.platform);
        return;
      }

      // Closes the union for modification: a new ClientCommand that this dispatcher forgets to handle
      // becomes a compile error here, rather than a command that silently falls through, gets acked,
      // and never runs, the silent-drop failure this project treats as cardinal.
      default:
        return assertNever(cmd);
    }
  };
}

/**
 * Composition root.
 *
 * This file builds the object graph and starts the listeners. That is ALL it does: every rule,
 * adapter and protocol handler lives in domain/, application/, infrastructure/ or interface/, and
 * this is the single place permitted to know all four. It used to be a 400-line module that also
 * owned env parsing, Tailscale discovery, crypto framing, fan-out, the hook protocol, the client
 * handshake, dedup, acks and lifecycle, so none of it could be exercised without starting a real
 * daemon on real sockets.
 *
 * Wiring reads top to bottom: configuration, then state, then sessions/jobs, then delivery, then boot.
 */
import net from 'node:net';
import fs from 'node:fs';

import { loadConfig, ConfigError, type DaemonConfig } from './infrastructure/config.ts';
import { createLogger } from './infrastructure/logger.ts';
import { resolveTcpHost } from './infrastructure/tailscale.ts';
import { Session } from './infrastructure/session.ts';
import { Identity } from './infrastructure/pairing.ts';
import { Db } from './infrastructure/db.ts';
import { FileHookMarginPolicy } from './infrastructure/hookMarginFile.ts';
import { createExpoPushSender, noopPushSender } from './infrastructure/expoPush.ts';

import { ApprovalBroker } from './domain/approvals.ts';
import { DeviceSessionRegistry } from './domain/deviceSessions.ts';

import { JobQueue, mergeSnapshotJobs, type Job, type SpawnRequest } from './application/jobs.ts';
import { wire, createCommandHandler } from './application/commands.ts';
import { createPushService } from './application/pushService.ts';

import { ClientHub } from './interface/clientHub.ts';
import { createHookServer } from './interface/hookBridge.ts';
import { createClientConnectionHandler } from './interface/clientConnection.ts';
import { createWebSocketServer } from './interface/wsServer.ts';

import type { PendingApproval, ServerEvent } from '@claude-code-remote/protocol';

// --- configuration ---------------------------------------------------------------------------

const log = createLogger();

let config: DaemonConfig;
try {
  config = loadConfig();
} catch (err) {
  // A daemon that cannot understand its own configuration must not start: several of these values
  // are safety caps, and running with one silently disabled is strictly worse than not running.
  if (err instanceof ConfigError) {
    log(`configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// --- state -----------------------------------------------------------------------------------

const sessions = new Map<string, Session>();
const broker = new ApprovalBroker();

/** The daemon's own persistent identity: key custody + paired-device registry. */
const identity = Identity.load(config.storePath);

/** The daemon's durable store: approval/session history, the job queue's own state. */
const db = new Db(config.dbPath);

/** Per-device seq + cross-reconnect replay bookkeeping (in-memory only, lost on daemon restart,
 *  same as everything else that isn't the durable store). */
const deviceSessions = new DeviceSessionRegistry(config.replayMaxDevices, config.replayMaxEventsPerDevice);

const hub = new ClientHub(deviceSessions, log);
const broadcast = (ev: ServerEvent) => hub.broadcast(ev);

/** Push wake-ups on new approvals. Opt-in: disabled → registrations are still recorded (so enabling
 *  it later needs no re-registration) but nothing is ever sent, and no third-party call is made. */
const pushService = createPushService({
  store: db,
  sender: config.pushEnabled ? createExpoPushSender(config.pushEndpoint, log) : noopPushSender,
  now: () => Date.now(),
  log,
});
if (config.pushEnabled) log(`push notifications enabled -> ${config.pushEndpoint}`);

function sessionByClaudeId(claudeSessionId: string | undefined): Session | undefined {
  if (!claudeSessionId) return undefined;
  for (const s of sessions.values()) {
    if (s.claudeSessionId === claudeSessionId) return s;
  }
  return undefined;
}

/** Today's full snapshot: used on a first-ever hello, or whenever resume isn't possible
 *  (daemon-restart guard or a genuine replay-buffer gap). */
function snapshot(): ServerEvent[] {
  const jobs = mergeSnapshotJobs(jobQueue.list(), db.queryRecentJobs(50));
  return [
    { type: 'session_list', sessions: [...sessions.values()].map((s) => s.info()) },
    ...broker.list().map((a): ServerEvent => ({ type: 'approval_pending', approval: a })),
    ...jobs.map((job): ServerEvent => ({ type: 'job_update', job })),
  ];
}

// --- sessions and jobs -----------------------------------------------------------------------

function spawnSession(req: SpawnRequest): Session {
  return new Session({
    cwd: req.cwd, label: req.label, disallowedTools: req.disallowedTools,
    model: req.model, permissionMode: req.permissionMode, effort: req.effort,
    socketPath: config.hookSock, selfDenyMs: config.selfDenyMs,
  });
}

function onSession(job: Job, session: Session) {
  db.recordSessionStarted({ id: session.id, cwd: session.cwd, label: session.label, startedAt: session.startedAt });
  wire(session, sessions, broadcast, log);
  log(`spawned ${session.label} in ${session.cwd} (${session.id}), job ${job.id}`);
  session.on('state', () => db.updateSessionActivity(session.id, session.claudeSessionId, session.model, session.lastActivityAt));
  session.on('exit', (code: number | null) => db.recordSessionEnded(session.id, session.state, code, Date.now()));
  // Without this listener everything a spawned session writes to stderr is silently discarded, and
  // a session that failed to start, hit a rate limit, or died on a bad flag looks identical to one
  // thinking quietly. Truncated because stderr is untrusted volume, not a log stream we control.
  session.on('stderr', (text: string) => {
    const line = text.trim();
    if (line) log(`session ${session.label} (${session.id}) stderr: ${line.slice(0, 500)}`);
  });
}

const jobQueue = new JobQueue({
  db,
  maxConcurrent: config.maxConcurrentSessions,
  selfDenyMs: config.selfDenyMs,
  hookMargin: new FileHookMarginPolicy(),
  spawnSession,
  onSession,
  log,
});
jobQueue.on('update', (job: Job) => broadcast({ type: 'job_update', job }));

// --- delivery --------------------------------------------------------------------------------

/** Whichever client-facing address is genuinely live right now; updated once the TCP listener
 *  starts, which is why the handler reads it through a getter rather than capturing the value. */
let advertisedAddress = `unix://${config.clientSock}`;

const handleCommand = createCommandHandler({
  sessions, broker, jobQueue, identity, db, push: pushService, log,
  reply: (sock, ev) => hub.sendTo(sock, ev),
  disconnectDevice: (deviceId) => hub.disconnectDevice(deviceId),
});

const hookServer = createHookServer({
  broker, sessionByClaudeId, selfDenyMs: config.selfDenyMs, broadcast, log,
});

/** Same protocol on both listeners; they differ only in whether trust may be bootstrapped there. */
const connectionHandler = (allowPairingBootstrap: boolean) => createClientConnectionHandler({
  hub, identity, deviceSessions,
  maxPairedDevices: config.maxPairedDevices,
  allowPairingBootstrap,
  snapshot,
  advertisedAddress: () => advertisedAddress,
  handleCommand,
  log,
});

// Local socket: reaching it already implies local access, so pairing may start here.
const clientServer = net.createServer(connectionHandler(true));
// Network listeners (TCP for the CLI, WebSocket for an Expo Go phone): reachable by anything on the
// tailnet, so they may USE existing trust (hello + sealed commands) but may never mint it. Both carry
// the identical protocol; the WebSocket one is a thin transport bridge over the same handler.
const clientTcpServer = config.clientTcpPort ? net.createServer(connectionHandler(false)) : null;

broker.on('pending', (a: PendingApproval) => {
  db.recordApprovalRequested(a);
  // Wake registered phones. Fire-and-forget and fail-soft, and it runs AFTER the durable record so a
  // push can never precede the audit row it corresponds to.
  pushService.notifyApprovalPending();
});
broker.on('resolved', (a: PendingApproval) => {
  db.recordApprovalDecision(a.toolUseId, a.decision!.decision, a.decision!.reason, a.decision!.by, a.decision!.at);
  broadcast({
    type: 'approval_resolved',
    toolUseId: a.toolUseId,
    decision: a.decision!.decision,
    by: a.decision!.by,
  });
});

// --- boot ------------------------------------------------------------------------------------

// A queued/running job or an unfinished session row from a daemon process that no longer exists is
// never going to resolve itself, the claude -p child dies with the daemon, and there's no
// re-attach. Reconcile once at boot, before anything can add new rows.
{
  const bootTime = Date.now();
  const orphanedSessions = db.reconcileOrphanedSessions(bootTime);
  const orphanedJobs = db.reconcileOrphanedJobs(bootTime);
  if (orphanedSessions) log(`reconciled ${orphanedSessions} orphaned session row(s) from a previous daemon process`);
  if (orphanedJobs) log(`reconciled ${orphanedJobs} orphaned job row(s) from a previous daemon process`);
}

for (const p of [config.hookSock, config.clientSock]) {
  try { fs.unlinkSync(p); } catch { /* not present */ }
}
hookServer.listen(config.hookSock, () => log(`hook bridge listening on ${config.hookSock}`));
clientServer.listen(config.clientSock, () => log(`client API listening on ${config.clientSock}`));

// Resolve the tailnet host once and start whichever network listeners are configured. The advertised
// address (what a paired client is told to dial) prefers WebSocket when it is enabled, since that is
// the phone's transport and the QR is scanned by the phone; a CLI second machine is given the tcp://
// address explicitly via `cc pair-code` when only TCP is on.
if ((clientTcpServer && config.clientTcpPort) || config.clientWsPort) {
  const host = resolveTcpHost(config.clientTcpHost, config.clientSock, log);
  if (host) {
    if (clientTcpServer && config.clientTcpPort) {
      clientTcpServer.on('error', (err) => log(`client TCP listener error: ${err.message}`));
      clientTcpServer.listen(config.clientTcpPort, host, () => {
        if (!config.clientWsPort) advertisedAddress = `tcp://${host}:${config.clientTcpPort}`;
        log(`client API also listening on ${host}:${config.clientTcpPort} (tcp), set ` +
            `CC_CLIENT_TCP_ADDR=${host}:${config.clientTcpPort} on the other machine to reach it`);
      });
    }
    if (config.clientWsPort) {
      const ws = createWebSocketServer({ host, port: config.clientWsPort, onConnection: connectionHandler(false), log });
      ws.on('listening', () => {
        advertisedAddress = `ws://${host}:${config.clientWsPort}`;
        log(`client WebSocket API listening on ws://${host}:${config.clientWsPort}, scan the QR from ` +
            '`cc pair-qr` on this machine to pair a phone');
      });
    }
  }
}

const shutdown = () => {
  log('shutting down');
  for (const s of sessions.values()) s.close();
  db.close();
  for (const p of [config.hookSock, config.clientSock]) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

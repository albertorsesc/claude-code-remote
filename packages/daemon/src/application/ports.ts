/**
 * Ports: the interfaces the application layer needs, declared BY the application layer.
 *
 * This is the dependency inversion that the layering exists for. Previously `jobs.ts` imported the
 * concrete `Session` and `Db` classes, so a use case could not be reasoned about, or tested, without
 * dragging in `child_process` and `node:sqlite`. Now infrastructure implements these interfaces and
 * the arrow points inward: application defines what it needs, infrastructure conforms.
 *
 * Each port is deliberately narrow (ISP). `JobStore` exposes two methods, not the whole 12-method
 * `Db`, because the job queue genuinely uses two, a port that mirrors the concrete class inverts
 * nothing and just adds a file. The narrowness is the point: it states the real coupling.
 *
 * Conformance is structural, so infrastructure classes satisfy these without importing them.
 */
import type { ApprovalHistoryEntry, EffortLevel, JobInfo, JobState, PermissionMode, PushPlatform, SessionInfo } from '@claude-code-remote/protocol';

/** A unit of spawn work. Same shape as the wire type, the queue adds state, not fields. */
export type Job = JobInfo;

export interface SpawnRequest {
  cwd: string;
  label?: string;
  disallowedTools?: string[];
  /** Per-session `claude` config applied at launch. Omitted values use `claude`'s own defaults. */
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
}

export type Logger = (...a: unknown[]) => void;

/**
 * A running headless session, as the application layer sees it: something addressable, steerable,
 * and observable. Notably NOT "a child process", that a session happens to be `claude -p` today is
 * an infrastructure detail, and nothing in the application layer should encode it.
 */
export interface SessionHandle {
  readonly id: string;
  readonly label: string;
  info(): SessionInfo;
  send(text: string): void;
  interrupt(): void;
  setModel(model: string): void;
  setPermissionMode(mode: PermissionMode): void;
  on(event: string, listener: (...args: any[]) => void): this;
}

/** Durable job state. Exactly what JobQueue writes, nothing more. */
export interface JobStore {
  insertJob(job: Job): void;
  updateJobState(
    id: string,
    patch: { state: JobState; sessionId?: string; error?: string; startedAt?: number; finishedAt?: number },
  ): void;
}

/**
 * What command handling needs from the job queue: the ability to enqueue a spawn request.
 * Depending on the concrete JobQueue instead coupled dispatch to the queue's whole surface, and
 * to its session type parameter, so a queue of concrete Sessions was not assignable where a
 * queue of handles was expected, for a method neither of them varies over.
 */
export interface JobEnqueuer {
  enqueue(req: SpawnRequest, requestedBy: string): Job;
}

/** The read side of the audit trail, for the `history` command. */
export interface ApprovalHistoryReader {
  queryRecentApprovals(limit?: number): ApprovalHistoryEntry[];
}

/**
 * Pairing and device lookup, as the client handshake needs it.
 *
 * The point of this port is what it does NOT expose. The handshake previously reached through the
 * concrete Identity for `keys.privateKey` to derive a session key, which meant the daemon's private
 * key crossed into the delivery layer for one ECDH call. Here the service performs the derivation
 * internally and returns only the derived key, so the private key never leaves the module that owns
 * it. The one-time pairing secret is likewise absent from beginPairing's result: the delivery layer
 * only ever needs the QR payload and its expiry.
 */
export type PairingFailure = 'no_pending_pairing' | 'expired' | 'bad_proof';

export interface PairedDeviceRef {
  deviceId: string;
  name: string;
  publicKey: string;
  pairedAt: number;
}

export type PairingOutcome =
  | { ok: true; device: PairedDeviceRef }
  | { ok: false; reason: PairingFailure };

export interface PairingService {
  readonly publicKeyB64: string;
  /** How many devices are currently paired, for the operational cap, without exposing the list. */
  pairedCount(): number;
  beginPairing(address: string): { qr: string; expiresAt: number };
  completePairing(devicePublicKey: string, deviceName: string, proof: string): PairingOutcome;
  find(deviceId: string): PairedDeviceRef | undefined;
  /** Derives this connection's session key. The daemon's private key stays inside. */
  deriveSessionKey(devicePublicKeyB64: string, salt: Buffer): Buffer;
}

/** Device trust, as command handling needs it: revocation only, never key material. */
export interface DeviceTrustRegistry {
  revoke(deviceId: string): boolean;
}

/**
 * Durable per-device push registrations. Infrastructure (the Db) conforms; the PushService reads and
 * writes through this so it never names sqlite. Upsert semantics live in the impl (a device rotates
 * its token), so this port only states the three operations the service performs.
 */
export interface PushRegistrationStore {
  upsertPushRegistration(deviceId: string, token: string, platform: PushPlatform, at: number): void;
  listPushTokens(): string[];
  deletePushRegistration(deviceId: string): void;
}

/**
 * The delivery side: hand a set of tokens to whatever actually pushes (Expo today). Deliberately
 * takes ONLY tokens and carries no per-approval data, the wake ping is generic, and the phone pulls
 * the real pending approval over the E2E channel, so nothing sensitive transits the push relay.
 * Fire-and-forget and fail-soft by contract: a push failure must never disturb the approval flow.
 */
export interface PushSender {
  send(tokens: string[]): Promise<void>;
}

/**
 * What command handling needs of push: register this authenticated device's token, and forget it on
 * revoke. Narrow on purpose (ISP), dispatch never fans out a notification, so it does not see the
 * sender or the token list.
 */
export interface PushRegistrar {
  register(deviceId: string, token: string, platform: PushPlatform): void;
  unregister(deviceId: string): void;
}

/**
 * The safety precondition for spawning: a project's hook timeout must exceed the bridge's
 * self-deny by a real margin, or a tool call can execute unguarded. The application layer must
 * enforce it but must not know it lives in a settings.json, the rule is domain, the file is
 * infrastructure, and this port is the seam between them.
 */
export interface HookMarginPolicy {
  check(cwd: string, selfDenyMs: number): { ok: true } | { ok: false; reason: string };
}

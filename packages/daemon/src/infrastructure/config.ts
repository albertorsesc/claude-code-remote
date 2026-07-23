import path from 'node:path';
import os from 'node:os';

/**
 * Daemon configuration, parsed and VALIDATED from the environment.
 *
 * Previously these were bare `Number(process.env.X || default)` constants scattered across the
 * entry point. That is quietly dangerous, because several of them are safety caps compared with
 * `>=`, and `Number('abc')` is NaN: every comparison against NaN is false, so a typo in
 * CC_MAX_PAIRED_DEVICES did not fall back to the default, it removed the cap entirely and
 * silently. The same shape applies to the concurrency cap and the replay bounds.
 *
 * So parsing fails LOUD here: a daemon that cannot understand its own configuration refuses to
 * start rather than starting with a security control invisibly disabled. Booting with a cap that
 * silently does nothing is the worst of the three outcomes (correct / refuse / pretend).
 *
 * Taking `env` as a parameter rather than reading process.env at module scope is what makes all of
 * this testable without spawning a process. The store and database paths live here for the same
 * reason: read at module scope inside pairing.ts and db.ts, they forced their unit tests to set an
 * env var and then `await import(...)` the module, which types as `any` and silently opted those
 * tests out of type checking entirely.
 */

export interface DaemonConfig {
  hookSock: string;
  clientSock: string;
  /** Identity + paired-device store. Injected rather than read at module scope so the modules
   *  that use it stay testable by static import (see the note in loadConfig). */
  storePath: string;
  dbPath: string;
  /** null = do not expose over TCP at all (Unix socket only). */
  clientTcpPort: number | null;
  clientTcpHost: string;
  selfDenyMs: number;
  /** Infinity = unbounded, which is the default and today's historical behavior. */
  maxConcurrentSessions: number;
  replayMaxDevices: number | undefined;
  replayMaxEventsPerDevice: number | undefined;
  maxPairedDevices: number;
  /** Opt-in: when false (default), the daemon records push registrations but sends no push, so it
   *  makes no third-party network calls unless the operator asks for it. */
  pushEnabled: boolean;
  /** The push relay to POST to. Overridable so tests can point it at a local mock. */
  pushEndpoint: string;
}

export class ConfigError extends Error {}

/**
 * Parse a variable that must be a positive integer if present at all.
 * Absent → fallback. Present but not a positive integer → refuse to start.
 */
function positiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new ConfigError(
      `${name}=${JSON.stringify(raw)} is not a positive integer. ` +
      `Refusing to start: this value is used as a cap, and an unparseable one would silently ` +
      `disable it rather than fall back to ${fallback}.`,
    );
  }
  return n;
}

/**
 * Parse a boolean flag. Absent/empty → fallback. `1`/`true`/`yes`/`on` → true; `0`/`false`/`no`/`off`
 * → false. Anything else refuses to start rather than guessing, the same fail-loud stance the
 * numeric caps take, because a mistyped `CC_PUSH_ENABLED=ture` silently reading as false would leave
 * an operator who asked for push wondering why none arrives.
 */
function boolFlag(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`${name}=${JSON.stringify(raw)} is not a boolean (use 1/0, true/false, yes/no, on/off).`);
}

/** Same contract, but absent means "unset" rather than a default value. */
function optionalPositiveInt(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new ConfigError(`${name}=${JSON.stringify(raw)} is not a positive integer.`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): DaemonConfig {
  const rawPort = env.CC_CLIENT_TCP_PORT;
  let clientTcpPort: number | null = null;
  if (rawPort !== undefined && rawPort !== '') {
    const n = Number(rawPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new ConfigError(`CC_CLIENT_TCP_PORT=${JSON.stringify(rawPort)} is not a valid TCP port (1-65535).`);
    }
    clientTcpPort = n;
  }

  return {
    hookSock: env.CC_DAEMON_SOCK || '/tmp/cc-daemon.sock',
    clientSock: env.CC_CLIENT_SOCK || '/tmp/cc-client.sock',
    storePath: env.CC_STORE || path.join(os.homedir(), '.config', 'app.claudecode', 'daemon.json'),
    dbPath: env.CC_DB_PATH || path.join(os.homedir(), '.config', 'app.claudecode', 'daemon.db'),
    clientTcpPort,
    clientTcpHost: env.CC_CLIENT_TCP_HOST || 'auto',
    selfDenyMs: positiveInt(env, 'CC_HOOK_SELF_DENY_MS', 20 * 60 * 1000),
    // Unbounded by default; only a value that is present AND valid caps it.
    maxConcurrentSessions: env.CC_MAX_CONCURRENT_SESSIONS
      ? positiveInt(env, 'CC_MAX_CONCURRENT_SESSIONS', Infinity)
      : Infinity,
    replayMaxDevices: optionalPositiveInt(env, 'CC_REPLAY_MAX_DEVICES'),
    replayMaxEventsPerDevice: optionalPositiveInt(env, 'CC_REPLAY_MAX_EVENTS_PER_DEVICE'),
    maxPairedDevices: positiveInt(env, 'CC_MAX_PAIRED_DEVICES', 50),
    pushEnabled: boolFlag(env, 'CC_PUSH_ENABLED', false),
    pushEndpoint: env.CC_PUSH_ENDPOINT || 'https://exp.host/--/api/v2/push/send',
  };
}

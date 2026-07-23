import { neutralizeControlChars } from '@claude-code-remote/protocol';
import type { Logger } from '../application/ports.ts';

/**
 * Escape control characters in a string log argument so an interpolated value (often UNAUTHENTICATED
 * peer input, e.g. an unknown deviceId at the client handshake) cannot forge whole operator-log
 * lines. Shares the exact neutralizer the CLI uses for its rendered audit trail, so the daemon log
 * and `cc history` give the identical guarantee. Non-string args pass through untouched, so the
 * structured logging of objects/numbers elsewhere is unaffected.
 */
function sanitizeLogArg(a: unknown): unknown {
  return typeof a === 'string' ? neutralizeControlChars(a) : a;
}

/**
 * Timestamped logger. Trivial, but injected as a port everywhere rather than having modules reach
 * for console.log directly, that is what keeps the application and domain layers silent and
 * testable, and lets the whole daemon's output be redirected from one place.
 */
export function createLogger(sink: (...a: unknown[]) => void = console.log): Logger {
  return (...a: unknown[]) => sink(new Date().toISOString(), ...a.map(sanitizeLogArg));
}

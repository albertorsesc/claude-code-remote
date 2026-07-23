import type { Logger } from '../application/ports.ts';

/**
 * Runs one message's handling so that a failure cannot take the process down.
 *
 * Socket handlers run inside EventEmitter callbacks, so an exception thrown while processing a
 * single message propagates as an uncaught exception and terminates the daemon. That is a wildly
 * disproportionate response: it abandons every pending approval, orphans every managed session and
 * drops every connected client, because of one bad frame or one failed row insert. It was not
 * theoretical, a duplicate tool_use_id killed the daemon in testing.
 *
 * The trade this makes, deliberately: availability over completeness. A swallowed error can hide a
 * bug, which is why the failure is logged loudly with its stack rather than ignored. But the
 * approval system's safety does not depend on this process staying healthy, the bridge fails
 * closed on its own when the daemon is unreachable, so a daemon that survives with one missing
 * audit row is strictly better than a daemon that dies and denies everything.
 *
 * This is a backstop, not error handling. Failures that a caller can act on (a frame that fails to
 * authenticate, a command for an unknown session) are still handled explicitly at their call site.
 *
 * @returns whether `fn` completed. Callers MUST NOT treat a guarded call as done: the first version
 * of this returned void, so the command path kept acknowledging commands whose handler had thrown,
 * converting a loud crash into silent loss with a false confirmation to the client.
 */
export function guardMessage(log: Logger, context: string, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (err: any) {
    log(`ERROR while ${context}, the daemon stayed up, but this message was dropped: ` +
        `${err?.stack ?? err?.message ?? err}`);
    return false;
  }
}

/**
 * The hook-margin safety rule, as a pure function.
 *
 * A project is only safe to spawn a session in if its settings install the approve-bridge hook with
 * a `timeout` (seconds, per Claude Code's hook schema) comfortably larger than the bridge's own
 * self-deny. Otherwise the settings timeout fires first, the runtime kills the bridge mid-decision,
 * and the tool call executes UNGUARDED, the exact failure the approval system exists to prevent.
 *
 * This lives in the domain, separate from the settings.json reader, because it is the safety rule
 * itself: it decides whether spawning is permitted. Keeping it pure means the dangerous edge cases
 * (missing hook, zero margin, several competing hooks) are testable as plain values, with no
 * temp directories and no filesystem, so the rule that guards tool execution is cheap to exercise
 * exhaustively. Reading the file is a separate, replaceable concern.
 */

/** Minimum slack between the settings timeout and self-deny. Below this, spawning is refused. */
export const MIN_MARGIN_MS = 30_000;

export type MarginResult = { ok: true } | { ok: false; reason: string };

/**
 * @param settings   Parsed settings object (already read and JSON-parsed by a caller).
 * @param selfDenyMs How long the bridge waits before denying on its own.
 * @param label      How to refer to the settings source in failure reasons (a path, typically).
 */
export function evaluateHookMargin(settings: unknown, selfDenyMs: number, label: string): MarginResult {
  const preToolUse = (settings as any)?.hooks?.PreToolUse ?? [];
  const timeouts: number[] = [];
  for (const entry of preToolUse) {
    for (const h of entry?.hooks ?? []) {
      // Number.isFinite, NOT `typeof === 'number'`: typeof NaN is 'number', so a non-finite
      // timeout used to sail through here and then poison the arithmetic below, Math.min gives
      // NaN, `NaN < MIN_MARGIN_MS` is false, and the rule returned ok:true, PERMITTING a spawn it
      // should have refused. A safety check that fails open on garbage input is worse than none,
      // because it reports that it verified something. Anything not a finite number is refused.
      if (typeof h?.command === 'string' && h.command.includes('approve-bridge.mjs') && Number.isFinite(h.timeout)) {
        timeouts.push(h.timeout);
      }
    }
  }
  if (timeouts.length === 0) {
    return { ok: false, reason: `no PreToolUse hook running approve-bridge.mjs in ${label}` };
  }

  // The SMALLEST timeout governs: whichever hook fires first is the one that can kill the bridge,
  // so a single tight entry makes the project unsafe no matter how generous the others are.
  const settingsTimeoutMs = Math.min(...timeouts) * 1000;
  const marginMs = settingsTimeoutMs - selfDenyMs;
  if (marginMs < MIN_MARGIN_MS) {
    return {
      ok: false,
      reason: `settings timeout (${settingsTimeoutMs}ms) leaves only ${marginMs}ms of margin over ` +
        `self-deny (${selfDenyMs}ms); need at least ${MIN_MARGIN_MS}ms`,
    };
  }
  return { ok: true };
}

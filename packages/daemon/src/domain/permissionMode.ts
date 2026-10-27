import type { PermissionMode } from '@claude-code-remote/protocol';

/**
 * Which `--permission-mode` values the daemon will actually apply to a session.
 *
 * This daemon's entire purpose is to gate every tool call through a REMOTE approval, which works
 * only while the approve-bridge PreToolUse hook blocks the tool. `plan` preserves that: the agent
 * produces a plan without executing, and any tool it later proposes still blocks for a decision.
 *
 * Explicit permission modes differ: `acceptEdits`, `auto`, and `bypassPermissions` can approve
 * tools automatically; `dontAsk` automatically denies calls that require approval unless they
 * are already permitted; and `manual` aliases Claude Code's standard mode. They are not all
 * auto-approving. This daemon conservatively refuses these explicit mode selections to keep
 * its remote approval model narrow. Operators needing other modes can use `claude` directly.
 *
 * Omitting the mode entirely is always allowed: it uses `claude`'s own default, the normal per-tool
 * approval flow the daemon is built around.
 */
export const APPROVAL_PRESERVING_MODES: readonly PermissionMode[] = ['plan'];

export function permissionModeIsAllowed(mode: PermissionMode): boolean {
  return APPROVAL_PRESERVING_MODES.includes(mode);
}

/** The operator-facing reason a mode was refused, for a clear error. */
export function permissionModeRefusal(mode: PermissionMode): string {
  return `refusing permission mode '${mode}': this daemon conservatively supports only explicit remote approval-preserving ` +
    `approval-preserving modes. Allowed: ${APPROVAL_PRESERVING_MODES.join(', ')} ` +
    `(or omit it for the default per-tool approval flow).`;
}

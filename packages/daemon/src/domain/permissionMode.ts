import type { PermissionMode } from '@claudecode/protocol';

/**
 * Which `--permission-mode` values the daemon will actually apply to a session.
 *
 * This daemon's entire purpose is to gate every tool call through a REMOTE approval, which works
 * only while the approve-bridge PreToolUse hook blocks the tool. `plan` preserves that: the agent
 * produces a plan without executing, and any tool it later proposes still blocks for a decision.
 *
 * The auto-approving modes (`acceptEdits`, `auto`, `bypassPermissions`, `dontAsk`) and `manual`
 * would let a tool run, or a permission rule be applied, WITHOUT a remote decision. Accepting them
 * from a client would silently disable the one guarantee the daemon exists to provide, so they are
 * refused, the same fail-closed stance the hook-margin check takes when the hook is missing. An
 * operator who genuinely wants an unsupervised session runs `claude` directly; they do not get one
 * by remote-controlling this daemon.
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
  return `refusing permission mode '${mode}': it can let a tool run without a remote approval, ` +
    `which is the guarantee this daemon exists to enforce. Allowed: ${APPROVAL_PRESERVING_MODES.join(', ')} ` +
    `(or omit it for the default per-tool approval flow).`;
}

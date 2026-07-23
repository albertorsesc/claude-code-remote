import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { EffortLevel, PermissionMode, SessionInfo, SessionState } from '@claudecode/protocol';
import { deriveSessionState } from './sessionState.ts';

export interface SpawnOptions {
  cwd: string;
  label?: string;
  /** Hook-independent second layer. The only control that survives a hook failure. */
  disallowedTools?: string[];
  /** Per-session `claude` launch config. Omitted values use the CLI's own defaults. */
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  socketPath: string;
  selfDenyMs: number;
}

/**
 * One headless Claude Code session.
 *
 * Headless inherits the full local ecosystem (MCP servers, agents, skills, hooks),
 * so nothing is lost versus an interactive session.
 */
export class Session extends EventEmitter {
  readonly id = randomUUID();
  readonly cwd: string;
  readonly label: string;
  claudeSessionId: string | null = null;
  model: string | null = null;
  state: SessionState = 'starting';
  readonly startedAt = Date.now();
  lastActivityAt = Date.now();
  /** Tool calls of this session currently blocked on a human decision. Private: mutated only through
   *  trackPendingApproval/untrackPendingApproval so the count cannot be corrupted from outside. */
  private pendingApprovals = new Set<string>();

  private proc: ChildProcessWithoutNullStreams;
  private buf = '';

  constructor(opts: SpawnOptions) {
    super();
    this.cwd = opts.cwd;
    this.label = opts.label ?? opts.cwd.split('/').pop() ?? 'session';

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose', // required with stream-json under --print, or the CLI errors out
    ];
    // NOTE: --allowedTools is additive, NOT an exclusive whitelist. Never use it to confine.
    for (const t of opts.disallowedTools ?? []) args.push('--disallowedTools', t);
    // Per-session config. Never --bare: it skips hooks, which would kill the approval bridge.
    if (opts.model) args.push('--model', opts.model);
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
    if (opts.effort) args.push('--effort', opts.effort);
    if (opts.model) this.model = opts.model; // reflect the requested model until init reports one

    this.proc = spawn('claude', args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CC_DAEMON_SOCK: opts.socketPath,
        CC_HOOK_SELF_DENY_MS: String(opts.selfDenyMs),
      },
    });

    // A headless session emits no `system/init` until its first input, so it would
    // otherwise sit in 'starting' forever in the fleet view. 'ready' is the honest state:
    // alive and accepting input, just never used.
    this.proc.once('spawn', () => {
      if (this.state === 'starting') this.setState('ready');
    });

    this.proc.stdout.on('data', (c) => this.onStdout(c.toString('utf8')));
    this.proc.stderr.on('data', (c) => this.emit('stderr', c.toString('utf8')));
    this.proc.on('exit', (code) => {
      // Node's docs say 'exit' may fire AFTER 'error' for the same failure. If 'error' already drove
      // this to a terminal state and emitted our 'exit', do not emit a second time: the job queue
      // decrements `running` on every 'exit', so a double-emit would corrupt the concurrency count.
      if (this.state === 'finished' || this.state === 'errored') return;
      this.setState(code === 0 ? 'finished' : 'errored');
      this.emit('exit', code);
    });
    // A claude binary that can't even be spawned must still reach a terminal state, not hang in
    // 'starting' forever. Symmetric guard to the 'exit' handler above: whichever of error/exit fires
    // first reaches terminal and emits once; the other is a no-op.
    this.proc.on('error', (err) => {
      if (this.state === 'finished' || this.state === 'errored') return;
      this.setState('errored');
      this.emit('exit', null, err);
    });
  }

  private onStdout(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleEvent(ev);
    }
  }

  private handleEvent(ev: any) {
    this.lastActivityAt = Date.now();

    // The init event also carries identity/model, instance state, so it stays here, but the state
    // transition it (and every other event) implies is the pure mapping in deriveSessionState.
    if (ev.type === 'system' && ev.subtype === 'init') {
      this.claudeSessionId = ev.session_id ?? null;
      this.model = ev.model ?? null;
    }

    // Typed state signals. Strictly better than scraping terminal output.
    const next = deriveSessionState(ev);
    if (next) this.setState(next);

    this.emit('stream', ev);
  }

  private setState(s: SessionState) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  /** Once the child has exited there is no process to steer: its stdin is destroyed, so writing is a
   *  silent no-op, and flipping the state back to 'working' would strand a terminal session as
   *  "working" forever (nothing can move it out, the transitions come from a stdout that never
   *  comes). Guard the write path so a steer command against a dead session does nothing. */
  private get isTerminal(): boolean {
    return this.state === 'finished' || this.state === 'errored';
  }

  send(text: string) {
    if (this.isTerminal) return;
    this.write({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    this.setState('working');
  }

  /**
   * Interrupt via the control protocol.
   * No `result` event follows an interrupt, treat the control_response as completion.
   */
  interrupt() {
    if (this.isTerminal) return;
    this.write({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    });
  }

  setModel(model: string) {
    if (this.isTerminal) return;
    this.model = model;
    this.write({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'set_model', model },
    });
  }

  setPermissionMode(mode: PermissionMode) {
    if (this.isTerminal) return;
    this.write({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'set_permission_mode', mode },
    });
  }

  private write(msg: unknown) {
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** The hook bridge records a tool call of this session as blocked on a decision. */
  trackPendingApproval(toolUseId: string) {
    this.pendingApprovals.add(toolUseId);
  }

  /** ...and clears it once decided or abandoned. */
  untrackPendingApproval(toolUseId: string) {
    this.pendingApprovals.delete(toolUseId);
  }

  info(): SessionInfo {
    return {
      id: this.id,
      claudeSessionId: this.claudeSessionId,
      cwd: this.cwd,
      label: this.label,
      state: this.state,
      model: this.model,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      pendingApprovals: this.pendingApprovals.size,
    };
  }

  close() {
    try { this.proc.stdin.end(); } catch { /* already gone */ }
  }
}

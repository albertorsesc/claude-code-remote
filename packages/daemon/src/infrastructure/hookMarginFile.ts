import fs from 'node:fs';
import { evaluateHookMargin, type MarginResult } from '../domain/hookMargin.ts';
import type { HookMarginPolicy } from '../application/ports.ts';

/**
 * Reads a project's `.claude/settings.json` and applies the domain margin rule to it.
 *
 * Only the I/O lives here: locating the file, reading it, parsing it, and turning the two failure
 * modes that are genuinely about the file (absent, unparseable) into refusal reasons. The decision
 * about whether the margin is safe belongs to the domain and is delegated, not duplicated.
 *
 * Checks only the project-level settings.json installed per the README, not the full
 * user/local settings merge.
 */
export class FileHookMarginPolicy implements HookMarginPolicy {
  check(cwd: string, selfDenyMs: number): MarginResult {
    const settingsPath = `${cwd}/.claude/settings.json`;

    let raw: string;
    try {
      raw = fs.readFileSync(settingsPath, 'utf8');
    } catch {
      return { ok: false, reason: `no ${settingsPath}, approve-bridge hook not installed` };
    }

    let settings: unknown;
    try {
      settings = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `${settingsPath} is not valid JSON` };
    }

    return evaluateHookMargin(settings, selfDenyMs, settingsPath);
  }
}

/**
 * Neutralize control characters in a string bound for a trust record a human reads.
 *
 * Two such records exist and must give the identical guarantee: the daemon's operator log
 * (`createLogger`) and the client's rendered audit trail (`cc history`, and every other line the CLI
 * prints from daemon/session-supplied strings). An authenticated-but-untrusted peer controls fields
 * that reach both, a decision `reason`, an approval `by`, a session `label`, a tool name, and an
 * embedded newline or ANSI escape in any of them could forge a whole log/history line or rewrite the
 * reviewing terminal. Binding this in one shared function is what keeps the two records consistent.
 *
 * CR and LF become visible escapes (`\r`, `\n`); every other C0 control and DEL, including ESC
 * (0x1b), the ANSI lead-in, becomes `\xNN`; tab is left literal (it cannot forge a line and is
 * common in legitimate text). Pure and dependency-free, so it belongs in the shared kernel.
 */
export function neutralizeControlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += ch; continue; }
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}

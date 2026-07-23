import { execFileSync } from 'node:child_process';
import type { Logger } from '../application/ports.ts';

/**
 * Resolves the address to bind the client TCP listener to.
 *
 * Fails closed: if Tailscale's IP can't be discovered, the TCP listener simply doesn't start (the
 * Unix socket is unaffected), it never silently falls back to binding every interface. Binding
 * 0.0.0.0 by accident would expose the control plane for every session on this machine to the
 * local network, so "no listener" is unambiguously the safer failure.
 */
export function resolveTcpHost(configuredHost: string, unixSocketPath: string, log: Logger): string | null {
  if (configuredHost === '0.0.0.0') {
    log(`WARNING: CC_CLIENT_TCP_HOST=0.0.0.0 binds beyond your tailnet, not just to it.`);
    return '0.0.0.0';
  }
  if (configuredHost !== 'auto') return configuredHost;
  try {
    const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
    if (!ip) throw new Error('empty output');
    return ip;
  } catch (err: any) {
    log(`CC_CLIENT_TCP_PORT set but could not resolve a Tailscale IP via 'tailscale ip -4' ` +
        `(${err?.message ?? err}). Set CC_CLIENT_TCP_HOST explicitly to override. ` +
        `TCP listener not started; ${unixSocketPath} is unaffected.`);
    return null;
  }
}

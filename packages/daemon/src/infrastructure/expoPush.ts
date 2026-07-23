import http from 'node:http';
import https from 'node:https';
import type { Logger, PushSender } from '../application/ports.ts';

/**
 * The Expo push-service adapter: POSTs a generic approval wake ping to registered devices.
 *
 * Two deliberate constraints, both about the daemon's whole reason to exist:
 *
 *  - PRIVACY. The message carries no session label, tool name, command, or id, only a fixed generic
 *    title/body and `data.kind`. A relay (here, Expo's servers) sees "some device has an approval",
 *    nothing about WHAT. The phone wakes and pulls the real pending approval over the E2E channel,
 *    which is the only authoritative source. So the same secrecy the sealed frames give on the tailnet
 *    is not undone by routing a notification through a third party.
 *  - FAIL-SOFT. Every network and HTTP error is logged and swallowed. A push that does not send must
 *    never disturb the approval flow: the tool call is already blocked and every connected client
 *    already got the sealed `approval_pending`. The push is a courtesy wake-up, not the mechanism.
 *
 * node:http/https only, no dependency, matching the rest of the daemon. The endpoint is injected
 * (not hardcoded) so a test can point it at a local mock and exercise the whole path without touching
 * Expo, and an `http:` endpoint is honored for exactly that reason.
 */

const EXPO_MAX_BATCH = 100; // Expo accepts up to 100 message objects per request.

export function createExpoPushSender(endpoint: string, log: Logger): PushSender {
  return {
    send(tokens: string[]): Promise<void> {
      if (tokens.length === 0) return Promise.resolve();

      let batch = tokens;
      if (tokens.length > EXPO_MAX_BATCH) {
        // Never silently truncate a fan-out: say what was dropped.
        log(`push: ${tokens.length} tokens exceeds Expo's ${EXPO_MAX_BATCH}-per-request cap, ` +
          `sending the first ${EXPO_MAX_BATCH}, dropping ${tokens.length - EXPO_MAX_BATCH}`);
        batch = tokens.slice(0, EXPO_MAX_BATCH);
      }

      const messages = batch.map((to) => ({
        to,
        title: 'Approval needed',
        body: 'A tool call is waiting for your decision.',
        priority: 'high',
        // No identifiers on purpose: the app wakes and fetches the pending approval over E2E.
        data: { kind: 'approval' },
      }));
      const body = Buffer.from(JSON.stringify(messages), 'utf8');

      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        log(`push: invalid endpoint ${JSON.stringify(endpoint)}, not sending`);
        return Promise.resolve();
      }
      const mod = url.protocol === 'http:' ? http : https;

      return new Promise<void>((resolve) => {
        const req = mod.request(
          url,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              'content-length': body.length,
            },
          },
          (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { if (data.length < 2000) data += c; });
            res.on('end', () => {
              if ((res.statusCode ?? 0) >= 300) {
                log(`push: ${url.host} returned ${res.statusCode}: ${data.slice(0, 200)}`);
              }
              resolve();
            });
          },
        );
        req.on('error', (e: Error) => { log(`push: send to ${url.host} failed: ${e.message}`); resolve(); });
        req.write(body);
        req.end();
      });
    },
  };
}

/** Push disabled (the default): registrations are still recorded, but nothing is ever sent. */
export const noopPushSender: PushSender = { send: () => Promise.resolve() };

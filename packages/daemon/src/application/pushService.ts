import type { PushPlatform } from '@claude-code-remote/protocol';
import type { Logger, PushRegistrar, PushRegistrationStore, PushSender } from './ports.ts';

/**
 * The push use case, sitting between the store (which devices, persistent) and the sender (how to
 * deliver). It is the only place that knows both, so command dispatch depends only on the narrow
 * `PushRegistrar` (register/unregister) and the approval trigger depends only on
 * `notifyApprovalPending()`. Neither sees sqlite or Expo.
 *
 * `notifyApprovalPending` is fire-and-forget by design: it is called from the broker's synchronous
 * `pending` handler, and a push must never block or fail an approval. It reads the current tokens and
 * hands them to the sender, whose own contract is fail-soft, so nothing here needs to await or catch.
 */
export interface PushService extends PushRegistrar {
  notifyApprovalPending(): void;
}

export function createPushService(deps: {
  store: PushRegistrationStore;
  sender: PushSender;
  now: () => number;
  log: Logger;
}): PushService {
  const { store, sender, now, log } = deps;
  return {
    register(deviceId: string, token: string, platform: PushPlatform) {
      store.upsertPushRegistration(deviceId, token, platform, now());
      log(`push: registered ${platform} device ${deviceId}`);
    },

    unregister(deviceId: string) {
      store.deletePushRegistration(deviceId);
    },

    notifyApprovalPending() {
      const tokens = store.listPushTokens();
      if (tokens.length === 0) return;
      // Fire-and-forget: sender.send is fail-soft, and a rejected promise here would be an unhandled
      // rejection with nowhere useful to go, so swallow it explicitly at the boundary.
      void sender.send(tokens).catch((e) => log(`push: notify failed: ${e?.message ?? e}`));
    },
  };
}

# @claude-code-remote/mobile

React Native (Expo) client for the daemon, pairs by scanning a QR, watches the session fleet,
steers sessions, and answers tool-approval prompts pushed to the phone, all over an E2E-encrypted
raw-TCP connection on a Tailscale tailnet.

## State (honest)

- **Verified and built:** the on-device crypto (`src/core/crypto/frameCrypto.ts`), pure-JS `@noble`,
  proven **byte-for-byte compatible** with the daemon's `@claude-code-remote/protocol/node` via fixed vectors
  (`src/core/crypto/frameCrypto.test.ts`, runs with zero `node:crypto`). It imports only the base
  `@claude-code-remote/protocol` (the portable wire contract), never `/node`.
- **Scaffolded, not yet built:** everything else. This package has the verified dependency manifest
  and Expo config, but no screens/transport/state yet, and the Expo app has **not** been built or run
  here (needs a machine with Xcode / Android SDK / EAS).

## Dependency versions

Pinned to **Expo SDK 57** (`expo` 57.0.8, RN 0.86, React 19.2.3), verified against the npm registry
and the SDK 57 bundle. Third-party (not SDK-pinned): `react-native-tcp-socket@6.4.1`, `@noble/*@2.2.0`,
`zustand@5.0.14`. Change SDK-pinned versions only through `npx expo install`.

## Build it (on a dev machine with native toolchains)

```bash
# from the monorepo root, apps/* is already a workspace
cd apps/mobile
npx expo install                      # installs the SDK-pinned native deps
npm install                           # third-party + workspace link
npx expo prebuild                     # generates native projects (react-native-tcp-socket is native)
npx expo run:ios                      # or eas build --profile development   (NOT Expo Go)
```

## Decisions already made (verified by spikes)

- **Transport:** `react-native-tcp-socket` (raw TCP, no config plugin, autolinks). Requires a **dev
  client**, not Expo Go.
- **Crypto:** pure-JS `@noble` + `react-native-get-random-values` (imported first in `index.js`).
- **Pairing key:** `expo-secure-store`. **QR:** `expo-camera` `CameraView` barcode scanning.
  **Push:** `expo-notifications` (deep-links to `/approval/[id]`).
- **iOS gotcha:** Tailscale IPs are in the CGNAT range, so a raw socket triggers the iOS Local Network
  prompt, `NSLocalNetworkUsageDescription` is set in `app.json`. Verify on a real device.

## Next

The shared reliability state machine is already extracted: import `ReliableClient` from
`@claude-code-remote/protocol` (base, RN-safe) and drive it with this app's transport (react-native-tcp-socket),
the `frameCrypto.ts` `SessionCrypto` adapter, and an in-memory seq counter, the CLI's `cc.ts` is the
reference host to mirror.

Push-on-approval is already wired on the daemon: register this device's Expo token with a sealed
`register_push` command (via `ReliableClient.send`), and the daemon wakes it when an approval goes
pending (generic ping only, fetch the real approval over the E2E channel). Enable it on the daemon
with `CC_PUSH_ENABLED=1`.

Remaining: pairing → fleet → steer → approval+push screens; and the one daemon addition still open,
rendering the pairing payload as a scannable QR (today it is the text `cc pair-code`).

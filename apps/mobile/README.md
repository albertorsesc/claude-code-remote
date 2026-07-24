# @claude-code-remote/mobile

Expo (React Native) client for the daemon: pair by scanning a QR, watch the session fleet, steer
sessions, and answer tool-approval prompts, over an end-to-end-encrypted WebSocket on a Tailscale
tailnet.

## State (honest)

The entire client protocol layer is built and verified; only the screens remain.

- **Built and verified** (20 unit tests plus an end-to-end run against a real daemon over a real
  WebSocket):
  - `src/core/crypto/frameCrypto.ts`, the on-device crypto (pure-JS `@noble`), byte-for-byte
    compatible with the daemon's `@claude-code-remote/protocol/node`.
  - `src/core/protocol/sessionCrypto.ts`, adapts that crypto to the shared `ReliableClient`.
  - `src/core/protocol/clientController.ts`, the RN host for `ReliableClient` (framing, drain/write).
  - `src/core/transport.ts`, the WebSocket transport (global `WebSocket`, so it runs in Expo Go).
  - `src/core/protocol/pairing.ts`, decode a scanned code, build `complete_pair`, persist the record.
  - `src/core/state/fleetState.ts`, the pure reducer the screens render (sessions, approvals, jobs).
- **Not built yet:** the UI screens and the native glue that only runs on a device (the `expo-camera`
  QR scan, `expo-secure-store` persistence, `expo-notifications` registration). The app has not been
  built or run here; that needs a machine with the Expo toolchain.

## Transport: WebSocket, so it runs in Expo Go

The app reaches the daemon over a WebSocket (the daemon exposes one via `CC_CLIENT_WS_PORT`). This
uses the global `WebSocket`, present in Expo Go, so there is no native transport module and no dev
client is needed for the core flow. Each WebSocket message carries one sealed frame; the crypto,
reliability, and pairing are identical to the CLI's.

One caveat: remote push registration (`expo-notifications`, `getExpoPushTokenAsync`) requires a
development build on recent Expo SDKs, so the push wake-up feature specifically needs a dev build even
though everything else runs in Expo Go.

## Dependency versions

Pinned to **Expo SDK 57** (`expo` 57.0.8, RN 0.86, React 19.2.3), verified against the npm registry.
Third-party (not SDK-pinned): `@noble/*@2.2.0`, `zustand@5.0.14`. Change SDK-pinned versions only
through `npx expo install`.

## Run it

```bash
# from the monorepo root
cd apps/mobile
npm install          # third-party + workspace link to @claude-code-remote/protocol
npx expo start       # then open in Expo Go (or a dev build if you want push)
```

On the daemon machine, enable the WebSocket listener and show a pairing QR:

```bash
CC_CLIENT_WS_PORT=7443 node packages/daemon/src/index.ts   # (plus CC_CLIENT_TCP_PORT if you also want the CLI)
node packages/cli/src/cc.ts pair-qr                        # scan this in the app
```

## iOS gotcha

Tailscale IPs are in the CGNAT range, so connecting to one triggers the iOS Local Network prompt.
`NSLocalNetworkUsageDescription` is set in `app.json`. Verify on a real device.

## Next

Build the screens on top of the verified client layer: pairing (QR scan via `expo-camera` →
`decodePairCode` → `startPairing` → connect via `openWebSocket` → persist with `expo-secure-store`),
then fleet, session detail, and the approval screen. The state they render is already in
`fleetState.ts`; connecting a socket is `openWebSocket` from `src/core/transport.ts`.

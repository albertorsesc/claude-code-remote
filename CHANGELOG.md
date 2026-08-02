# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from its first tagged release.
Until then, everything lives under Unreleased and the API may change without notice.

## [Unreleased]

### Added

- Mobile app UI (Expo / React Native, "Nocturne" design): the pairing gate, the session fleet, the
  approvals list, the tool-approval decision screen, and settings, built on the verified
  end-to-end-encrypted client layer. Session detail and the pairing camera are in progress.
- Root `npm run mobile` shortcut that starts the Expo app.

### Changed

- The Expo app installs independently of the daemon workspace. It is deliberately not a root
  workspace member so a daemon-only clone stays dependency-light; see
  [apps/mobile/README.md](apps/mobile/README.md) for its own install and run steps.

### Fixed

- Phone quickstart docs (README and `docs/PAIRING.md`) now set `CC_CLIENT_WS_PORT`. The app is
  WebSocket-only, and the previous TCP-only instructions produced a pairing QR the phone could not
  connect to.
- Mobile approval and fleet countdowns now update every second (they were frozen between events
  because the list did not re-render on the timer tick).

### Security

- WebSocket transport: a frame is now rejected when its declared length exceeds the message-size cap,
  before any payload is buffered. Previously a peer with tailnet access could declare a huge frame
  length and stream bytes to exhaust the daemon's memory (an unauthenticated OOM that would take down
  every session and pending approval).

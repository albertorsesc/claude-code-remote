# Security policy

claude-code-remote gates whether arbitrary tool calls execute on a machine, over a network socket,
protected by end-to-end encryption. Security reports are taken seriously. This file is about
**reporting a vulnerability**. For the design-level trust model, see
[docs/SECURITY.md](docs/SECURITY.md).

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.** Public disclosure before a fix is
available puts every user at risk.

Instead, use GitHub's private vulnerability reporting: on the repository's **Security** tab, choose
**Report a vulnerability**. If that is unavailable, contact the maintainers privately and wait for a
response before disclosing.

Please include:

- A description of the issue and the trust boundary it crosses (see below).
- Steps to reproduce, or a proof of concept.
- The affected version or commit, and your Node version and transport (local Unix socket or Tailscale
  TCP).
- The impact you believe it has.

## Scope

The boundaries most relevant to this project's security:

- **The fail-closed guarantee of the approval bridge** (`hook/approve-bridge.mjs`): any path where a
  tool executes without an explicit allow.
- **Pairing and the local-only `begin_pair` boundary**: any way a device could become trusted without
  possessing an out-of-band secret, or over the network listener.
- **Frame authentication and encryption**: any way to have a frame accepted without the session key,
  to decrypt a payload, or to replay or reflect a frame.
- **Device revocation**: any way a revoked device retains access.
- **The audit trail**: any way to forge, suppress, or misattribute a recorded decision.

## Out of scope (by design, documented, not bugs)

These are stated in [docs/SECURITY.md](docs/SECURITY.md) as deliberate behavior, not defects:

- Claude Code fails open on degraded hook paths. This project's mitigation is the always-answer
  bridge; the underlying Claude Code behavior is upstream.
- `--allowedTools` is additive, not an exclusive whitelist. Use `--disallowedTools` to confine.
- A Tailscale hosted coordination server can observe device identity and connection timing (never
  payload).

## Supported versions

This project is pre-1.0 and moves fast. Security fixes land on the latest `main`. Until a stable
release line exists, please test against `main` before reporting.

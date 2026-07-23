# Security model

This is the design-level trust model. To **report a vulnerability**, see the disclosure policy in
[SECURITY.md](../SECURITY.md) at the repo root.

claude-code-remote runs tool calls on your machine on behalf of a remote client. Its whole reason to
exist is that a tool never runs without a decision you control. This document states how that holds,
and where the boundaries are.

## The core problem: Claude Code fails open

Claude Code fails open on every degraded hook path. A crash, a hang, garbage output, empty output, or
the hook being killed by the settings `timeout` all result in the tool executing. Permission modes do
not gate in headless mode either: all five permission modes ran the tool with no hook installed. This
was measured, not assumed.

The counterweight is that an explicit `deny` from the hook is honored in every permission mode,
including `bypassPermissions`. So the hook is fully authoritative when it answers.

Everything therefore reduces to a single question: **does the bridge always answer?**

## The bridge always answers, and defaults to deny

`hook/approve-bridge.mjs` is built so that it cannot fail to answer:

- It is plain `.mjs` with zero dependencies and no imports beyond `node:net`, so there is no
  dependency that can fail to load.
- A catch-all denies on any exception.
- A self-deny timer fires strictly before the settings `timeout`, so a stalled decision becomes a
  deny rather than a timeout-triggered execution. The daemon refuses to spawn into a project whose
  settings `timeout` is not comfortably larger than the self-deny window, so this margin cannot be
  misconfigured into uselessness.
- If the daemon is unreachable, the bridge denies locally.

Verified by killing the daemon while an approval was pending: the tool stayed unexecuted, checked
against filesystem ground truth rather than log inspection.

## What survives a bridge failure

- `--disallowedTools` at spawn is the only control that survives a bridge failure. Use it for the
  categorically-never-allowed set.
- **Never rely on `--allowedTools` as a whitelist.** It is additive, not exclusive. Allowing only
  `Read` still permits `Bash`. This is a documented Claude Code behavior, not a bug in this project,
  and it is the most likely way to build a false sense of confinement.

## Client authentication and encryption

The client socket requires pairing before it will do anything.

- **Pairing.** `begin_pair` / `complete_pair` mirror QR-code pairing: the daemon hands out a one-time
  secret, and possession of that secret is the authentication, not a password or a stored credential.
  `begin_pair` is served on the **local socket only**. See [PAIRING.md](PAIRING.md) for why this is a
  security boundary and how a phone or a second machine pairs out of band.
- **Encryption.** Once paired, `hello` derives a session key via X25519 ECDH and HKDF-SHA256, and
  every frame after that is AES-256-GCM. Anything sent before authentication, an unrecognized device,
  or a frame that fails to decrypt closes the connection. There is no plaintext fallback path.
- **Direction binding.** The frame's direction and sequence are authenticated as associated data, so
  a frame the daemon sealed for a client cannot be reflected back into the daemon and accepted.

Verified against the live socket, not just the crypto primitives in isolation: an unauthenticated
`spawn` creates no session, an unknown device is refused, and a frame sealed under the wrong key is
rejected. The trust model is identical over TCP and the Unix socket.

## Network exposure

The TCP listener defaults to the machine's discovered Tailscale IP, never `0.0.0.0`. It fails closed:
if Tailscale is not installed or `tailscale ip -4` fails, the daemon skips the TCP listener and logs
why, leaving the Unix socket unaffected, rather than silently binding every interface. Binding a
wider interface is possible with `CC_CLIENT_TCP_HOST` but logs a warning.

## An honest tradeoff, not "zero knowledge"

The payload is end-to-end encrypted. If you use Tailscale's hosted coordination server, Tailscale can
see device identity and connection timing, though never the payload (confirmed against Tailscale's own
documentation). That is a real, named tradeoff. If it matters to you, run your own coordination server
(Headscale) or a direct network path.

## Audit trail

Every approval decision is recorded durably (who decided, what, when, and why), attributed to the
authenticated device rather than to a client-supplied label. `cc history` reads it back over the
encrypted channel. Session labels, tool names, and decision reasons from an authenticated-but-untrusted
peer are neutralized of control characters before they are rendered, so a crafted value cannot forge a
line or drive the reviewing terminal.

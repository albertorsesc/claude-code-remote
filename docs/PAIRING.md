# Pairing and remote access

A client must pair with the daemon once before it can do anything. Pairing is the moment trust is
established, and it has one firm rule: the one-time secret leaves the daemon machine **out of band**,
never over the network.

## Local pairing (same machine)

With the daemon running, on the same machine:

```bash
cc pair
```

This runs `begin_pair` over the local Unix socket, receives the one-time secret, proves possession of
it, and persists the paired identity to `~/.config/claude-code-remote/device.json`. You do this once per
machine.

## Why `begin_pair` is local-only, and why that is a security boundary

`begin_pair` returns the one-time secret to whoever calls it. If the network listener served it,
anything that could reach the port could mint a secret, compute the proof itself, and become a
trusted device. A trusted device can spawn sessions and approve tool calls, which is code execution
on your machine. Reachability is not authorization.

So the network listener refuses `begin_pair`. Only `complete_pair`, `hello`, and sealed commands are
served over the network. The secret must arrive at the new device by a channel the network cannot
observe: a QR shown on the daemon's screen and read by a phone camera, or a copy-pasteable code
carried to a second machine.

## Reaching the daemon from another machine (Tailscale)

On the daemon's machine, with `tailscale` on PATH (the standalone or Homebrew installer provides it;
the Mac App Store build does not), and both machines on the same tailnet:

```bash
CC_CLIENT_TCP_PORT=7443 node packages/daemon/src/index.ts
# logs: client API also listening on 100.x.x.x:7443
```

`CC_CLIENT_TCP_PORT` alone auto-discovers the tailnet IP. The listener binds that IP, never
`0.0.0.0`. `CC_CLIENT_TCP_HOST` can override the bind address (a literal IP, or `0.0.0.0` to bind
every interface, which logs a warning because it reaches beyond your tailnet). The local Unix socket
keeps working unchanged.

## Pairing a second machine, out of band

On the daemon's machine, mint a one-time code:

```bash
cc pair-code
```

This performs a local `begin_pair` and prints the pairing payload as a single copy-pasteable code
(base64url), together with the exact command to run on the other machine. The secret is printed, not
sent: the code is the out-of-band channel.

Carry the code to the second machine and redeem it:

```bash
CC_PAIR_CODE='<code>' node packages/cli/src/cc.ts pair
CC_CLIENT_TCP_ADDR=100.x.x.x:7443 node packages/cli/src/cc.ts watch
```

Redeeming goes straight to `complete_pair` over the tailnet. The daemon's public key stored on the
second machine is taken from the code, whose proof already authenticated it, not from a network
reply. The secret never crosses the network.

## Pairing a phone

The phone flow is the same shape as the second-machine flow, with the QR as the out-of-band channel:
the daemon displays a QR, the phone camera reads it (genuinely out of band), and `complete_pair`,
`hello`, and every command run over the tailnet. The QR rendering on the daemon side is the one piece
of this flow still to be built.

## Revoking a device

```bash
cc revoke <deviceId>
```

Revocation removes the device from the trust registry, closes its connection immediately if it is
connected, and forgets any push token it registered. Pairing is capped at `CC_MAX_PAIRED_DEVICES`
(default 50), checked before the one-time secret is consumed, so a device rejected at the cap can
retry the same secret once a slot frees up.

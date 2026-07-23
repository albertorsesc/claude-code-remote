---
name: Bug report
about: Something is not working as documented
title: ''
labels: bug
assignees: ''
---

**Do not use this for security vulnerabilities.** See [SECURITY.md](../../SECURITY.md) and use private
vulnerability reporting instead.

## What happened

A clear description of the bug, and what you expected instead.

## Steps to reproduce

1.
2.
3.

## Environment

- Node version (`node --version`): (must be 24+)
- Transport: local Unix socket / Tailscale TCP
- `claude` version, if the bug involves spawning a session:
- OS:

## Hook configuration (if the bug involves approvals or spawning)

- The `command` and `timeout` in the target project's `.claude/settings.json`:
- Your `CC_HOOK_SELF_DENY_MS`, if set:

## Logs or output

Paste relevant daemon or CLI output. Scrub anything sensitive first.

# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-10-08

### Added

- `stop` stops the running service and returns once it has exited, without
  asking for the PIN; it never starts one to stop it.
- `--version` / `-v` prints the CLI version, and `--help` / `-h` prints usage
  to stdout with exit code 0. Neither starts the service.
- `start` and `setup` show the version of the running service and warn when it
  is not the installed one, with the way to switch.

### Changed

- **A service started by 0.2.0 must be stopped by hand once.** It does not
  understand this CLI's `start` or `stop`. End it, then `start` again:
  `kill "$(cut -d: -f1 ~/.secure-telegram-mcp/sessions/.daemon-running/owner)"`
  (adjust the path if `TELEGRAM_MCP_SESSION_DIR` is set).
- An unknown command names itself and points at `--help` instead of printing the
  whole usage.

## [0.2.0] — 2026-10-08

### Changed

- **A PIN file must be owner-only.** `TELEGRAM_MCP_SESSION_PASSPHRASE_FILE` now
  refuses a file that group or other users can read, naming its mode, instead of
  using it. `docs/USAGE.md` always asked for `0600`; it is now enforced. If an
  upgrade stops unlocking, run `chmod 600` on the file.

### Fixed

- The anti-ban circuit breaker could never trip: its long-wait threshold (10 s)
  was above the longest back-off any bucket can produce (8 s). It now trips after
  three long back-offs and pauses every quota-bearing operation on that account
  for the cooldown, while other accounts keep working.
- A client without elicitation support now gets `CONFIRMATION_REQUIRED` for a
  protected write, as documented, without being prompted. A confirmation request
  that fails in transit still reports `GATEWAY_UNAVAILABLE`.
- The setup review screen lists rights changes on chats that stay in scope —
  for example `read → read + write` — instead of "no changes vs. saved config".
- The server reports the published package version in `initialize`; it was
  fixed at `0.1.0`.

## [0.1.0] — 2026-07-17

### Added

- Multi-account Telegram MCP server with per-endpoint API keys and
  folder/chat-scoped ACLs — 18 tools gated by 8 permission verbs, re-checked on
  every call.
- Encrypted-at-rest sessions and sealed policy (AES-256-GCM envelopes;
  machine-bound, PIN, and recovery-keyfile unlock slots).
- Interactive setup wizard: QR or phone login, chat/folder access picker,
  one-shot endpoint key mint with ready-to-paste client config.
- Anti-ban pacing: per-account token buckets (messages, forwards, search) and a
  circuit breaker.
- Optional human-in-the-loop write confirmation via MCP elicitation
  (fail-closed on clients without elicitation support).
- Append-only NDJSON audit log for writes, denials, and media egress.

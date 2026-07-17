# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

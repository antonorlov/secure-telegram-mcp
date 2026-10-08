# Usage and operations

[Quickstart](../README.md#quickstart) | [Security](../SECURITY.md) |
[Architecture](../ARCHITECTURE.md) | [Example config](../telegram-mcp.config.example.json)

This document owns operational and advanced usage. The README intentionally keeps
only the shortest safe onboarding path.

## One endpoint per MCP client

An endpoint key selects one endpoint and therefore one Telegram scope. Give each AI
client only the endpoint intended for it.

Personal agent configuration:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "npx",
      "args": ["-y", "secure-telegram-mcp", "connect"],
      "env": {
        "TELEGRAM_MCP_ENDPOINT_TOKEN": "<personal-endpoint-key>"
      }
    }
  }
}
```

Work agent configuration, stored in that other client's configuration:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "npx",
      "args": ["-y", "secure-telegram-mcp", "connect"],
      "env": {
        "TELEGRAM_MCP_ENDPOINT_TOKEN": "<work-endpoint-key>"
      }
    }
  }
}
```

Do not merge these entries into one client unless that client intentionally needs
both scopes. Multiple clients can connect simultaneously: their stdio shims share
the one local service that owns Telegram's auth key.

At exit, setup prints one config block per endpoint whose key was minted in that
run — keys are shown once and never stored, so only those blocks are actionable.
Paste each block only into its intended client. Endpoints from earlier runs are
listed by name; re-create one in setup to mint a fresh key. When stdout is piped,
the freshly minted entries are additionally emitted there as one parseable
`mcpServers` JSON bundle.

## Commands

```text
npx -y secure-telegram-mcp setup    # login, accounts, endpoints, and session security
npx -y secure-telegram-mcp start    # start, show status, or interactively unlock
npx -y secure-telegram-mcp apply    # validate and apply config.json
npx -y secure-telegram-mcp connect  # stdio shim launched by an MCP client
```

`connect` starts or joins the local service and pipes MCP stdio to it. Run it from
an MCP client configuration rather than as an interactive shell command.

## Session protection

### Machine-bound (default)

No unlock secret is needed. `connect` starts the local service automatically. This
protects the encrypted files from being copied alone, but not from a copied system
disk that also contains the machine identity.

### PIN-protected

The normal interactive path stores no PIN in an MCP client configuration:

```bash
npx -y secure-telegram-mcp start
```

Enter the PIN when prompted. The unlocked service remains available until it stops
or reaches `TELEGRAM_MCP_IDLE_HOURS` (12 hours by default).

For a headless operator, point `TELEGRAM_MCP_SESSION_PASSPHRASE_FILE` to a regular
0600 file containing the PIN. This is an automation option, not the Quickstart.
The inline passphrase variable exists for controlled secret-manager environments,
but a file-backed secret avoids putting the PIN directly in process environment
configuration.

A recovery keyfile opens only the encrypted data present when it was exported.
Export a new recovery key after adding or replacing an account, or changing the PIN.

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_MCP_ENDPOINT_TOKEN` | `connect` | Endpoint API key; selects and authorizes exactly one endpoint |
| `TELEGRAM_API_ID` | no | Optional setup pre-fill or override of the value sealed into the session |
| `TELEGRAM_API_HASH` | no | Optional masked setup pre-fill or override of the sealed value |
| `TELEGRAM_MCP_SESSION_PASSPHRASE_FILE` | PIN automation | Path to a regular 0600 file containing the PIN |
| `TELEGRAM_MCP_SESSION_PASSPHRASE` | PIN automation | PIN inline; the file variable is preferred |
| `TELEGRAM_MCP_SESSION_KEYFILE` | recovery | Recovery keyfile for data present at export time |
| `TELEGRAM_MCP_CONFIG` | no | Draft config path; default `~/.secure-telegram-mcp/config.json` |
| `TELEGRAM_MCP_SESSION_DIR` | no | Encrypted session directory; default `~/.secure-telegram-mcp/sessions` |
| `TELEGRAM_MCP_AUDIT_LOG` | no | Audit path; default `<session-dir>/audit.log` |
| `TELEGRAM_MCP_MEDIA_DIR` | no | Shared media root; default `~/.secure-telegram-mcp/media` |
| `TELEGRAM_MCP_IDLE_HOURS` | no | PIN idle auto-lock window; default `12`, `0` disables |
| `TELEGRAM_MCP_ENDPOINT` | no | Optional endpoint-name assertion; must match the endpoint selected by the token |
| `TELEGRAM_MCP_DEBUG_LOG` | no | Owner-only setup diagnostic file; exception messages are omitted |

Passphrase files are limited to 4096 bytes plus a trailing CRLF. Recovery/key files
are limited to 1 MiB. Secret paths must resolve to regular files, not devices or
FIFOs.

`setup` prompts for `api_id` and `api_hash`; exporting them is unnecessary. When
present, the environment values are prompt defaults. After setup, the local service
reads the credentials sealed into the encrypted session.

## Configuration and policy apply

`~/.secure-telegram-mcp/config.json` is an editable draft. The runtime trusts only
the encrypted policy committed by setup or `apply`:

```bash
npx -y secure-telegram-mcp apply
```

On a PIN-protected install, `apply` has no interactive prompt: supply the unlock
secret via `TELEGRAM_MCP_SESSION_PASSPHRASE_FILE` (or `TELEGRAM_MCP_SESSION_KEYFILE`),
or use the interactive paths — `setup` applies on save, `start` unlocks.

Within setup, completing an endpoint field or access save writes the validated draft
atomically and applies those exact bytes. Ordinary read-only chat edits save directly;
writable access and live-tracked folder-unit changes pass through Review first. Back
does not perform a deferred save.

The complete schema-shaped example is
[`telegram-mcp.config.example.json`](../telegram-mcp.config.example.json). Its
`tokenHash` values are deliberately unusable placeholders. Setup mints endpoint
keys and stores only salted hashes; do not author token hashes manually.

Chat references accept `"me"`, `"@username"`, or a numeric peer id. Folder
references accept a Telegram folder title or numeric id. Explicit folder members
are resolved when an endpoint binding is built. Rule-matched members selected in
setup are stored as individual chat snapshots.

The global `killSwitch.disabledVerbs` list removes verbs from every endpoint.
`maxDownloadBytes` is a global strict download limit and defaults to 50 MiB.

## Permission verbs

| Verb | Operations |
| --- | --- |
| `read` | messages, search, dialogs, topics, chat info, media metadata, pins, participants |
| `read_media` | download media to the confined server directory |
| `send` | send/edit messages, prepare media, send media |
| `draft` | save drafts |
| `delete` | delete messages |
| `mark_read` | fire read receipts |
| `forward` | forward messages |
| `react` | send reactions |

The setup picker's `r` bit grants `read` and `read_media`; an explicit config can
remove `read_media` for text-only access. Its `w` bit grants the full write tier.
A hand-authored narrower verb list collapses to the tier when edited in the picker.

### Picker keys

`↑`/`k` and `↓`/`j` move, `←`/`h` and `→`/`l` switch tabs, `/` filters. On a chat
or folder row: `r` (or Space) grants read, `w` grants write, `0`/Backspace
removes it from scope. `v` starts a visual range, `a` selects all shown, `i` inverts. `s` saves —
writable access and live-tracked folder changes pass a review screen first —
`Esc` cancels, and `?` shows the full keymap in the picker itself.

Forwarding is two-sided: the source chat requires `read`, and the destination chat
requires `forward`.

## Human confirmation

`hitl.confirmWrites` uses MCP elicitation. It defaults to OFF; enable it per
endpoint (the endpoint hub's "Confirm writes" setting) where a human should
approve writes before they execute. If the MCP client does not support
elicitation, a protected write fails closed with `CONFIRMATION_REQUIRED`. The
MCP host is trusted to show the prompt and return the human decision.

## Media directory

All endpoints share one media root. By default:

```text
~/.secure-telegram-mcp/media/
└── downloads/
```

Downloads use server-chosen names under `downloads/` and enforce the byte cap
before, during, and after transfer. Partial failures are removed. Sending local
media is a two-step flow: `prepare_media` accepts a path inside the media root and
returns an opaque, scoped, expiring handle; `send_media` consumes the handle.

## Docker

```bash
docker build -t secure-telegram-mcp .
mkdir -p config media

# Interactive setup: writable config and session volumes.
docker run --rm -it \
  --env-file ./telegram.env \
  -v "$PWD/config:/config" \
  -v tg-sessions:/sessions \
  -v "$PWD/media:/media" \
  secure-telegram-mcp setup

# MCP stdio: config mounted read-only.
docker run --rm -i \
  --env-file ./telegram.env \
  -v "$PWD/config:/config:ro" \
  -v tg-sessions:/sessions \
  -v "$PWD/media:/media" \
  secure-telegram-mcp connect
```

The image runs as UID 1000 (`node`). On native Linux, make the bind-mounted config
and media directories writable by that UID for setup; do not make them
world-writable. Supply secrets through `--env-file` or a secret manager, never in
the image.

## Troubleshooting

- **Login asks you to wait (FLOOD_WAIT)** — Telegram rate-limited the login.
  Wait the indicated seconds and retry once; rapid retries lengthen the penalty.
- **QR code expired** — setup refreshes the QR automatically; scan the newest
  one. If login then fails with "session was reset or expired", restart the
  login for a fresh code.
- **Two-step verification password is incorrect** — the 2FA password is your
  Telegram cloud password, not the phone code. Entry is bounded to a few
  attempts, then the flow stops; re-run login.
- **Every tool call fails with `SESSION_LOCKED`** — the service is PIN-locked
  (tools still appear in the client's menu). Run
  `npx -y secure-telegram-mcp start` and enter the PIN. With
  `TELEGRAM_MCP_IDLE_HOURS` (default 12) the service re-locks after idling.
- **Writes fail with `CONFIRMATION_REQUIRED`** — the endpoint has
  `confirmWrites` on but the client cannot show an MCP elicitation prompt. Use
  a client that supports elicitation, or disable confirmation for that endpoint
  in setup.
- **Forgotten PIN** — a PIN cannot be recovered. A previously exported recovery
  keyfile (`TELEGRAM_MCP_SESSION_KEYFILE`) unlocks the data present when it was
  exported; without one, delete the session directory and log in again.
- **Client cannot connect at all** — check `node -v` is ≥ 20.10, then run
  `npx -y secure-telegram-mcp start` to see the service status.

## Tool catalogue

Read tools: `get_messages`, `search_messages`, `list_dialogs`, `list_topics`,
`get_chat_info`, `get_media_info`, `get_pinned_messages`, and
`list_participants`.

Media egress: `download_media`.

Write tools: `send_message`, `edit_message`, `delete_message`, `save_draft`,
`mark_read`, `send_reaction`, `forward_message`, `prepare_media`, and `send_media`.

The tool menu is static discovery. Every call still resolves the target through the
scope-bound adapter and checks its effective verb set and the global kill
switch. See [Security](../SECURITY.md) for guarantees and residual risks,
and [Architecture](../ARCHITECTURE.md) for the runtime path.

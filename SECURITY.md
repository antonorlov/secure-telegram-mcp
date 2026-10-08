# Security Model

[Quickstart](./README.md#quickstart) | [Usage and operations](./docs/USAGE.md) |
[Architecture](./ARCHITECTURE.md)

## Document status

This document describes the security design of `secure-telegram-mcp` 0.1.x as
implemented in this repository. The project is alpha software and has not
received an independent security audit. This is a threat model and an
implementation guide, not a certification or a guarantee that the software is
free of vulnerabilities.

Security fixes for 0.1.x are best effort. Vulnerabilities are reported through
GitHub private vulnerability reporting; see the end of this document.

The scope is the local Telegram MCP service, its command-line clients, local
persistence, and the GramJS MTProto adapter. Telegram, the MCP host, the model,
the operating system, Node.js, and third-party dependencies are external systems
with their own security properties.

When this document and the implementation disagree, treat the implementation as
the current behavior and report the documentation defect. See the
[Quickstart](./README.md#quickstart) for onboarding and
[Usage and operations](./docs/USAGE.md) for commands and hardened deployment.

## System summary

For one managed state directory, one long-lived local service process owns its
configured Telegram MTProto sessions and serves MCP clients through a local
socket. A small `connect` process forwards MCP stdio to that socket. Setup and
administrative operations use a separate local operator socket.

```text
MCP host / model
      | stdio
      v
connect shim ---> MCP socket ---> local service ---> GramJS / MTProto ---> Telegram
                                    ^      |
                                    |      +-- encrypted state, media, audit log
                         operator socket
                                    ^
                                    |
                          setup / start / apply
```

Endpoint bearer tokens authorize MCP clients to use one endpoint. They prove
possession, not the identity of a named client or process. The sealed policy
defines each endpoint's peers and permitted verbs. The editable `config.json` is
a draft and does not become runtime authority until the operator applies it.

## Security objectives

The design aims to provide these properties while the trusted computing base
remains trustworthy:

1. A holder of an endpoint token can act only as the endpoint selected by that
   token.
2. Every tool invocation is authorized against the currently published sealed
   policy before the scoped Telegram operation begins.
3. Peer-addressed operations are limited to the endpoint's resolved peer set and
   effective per-peer verbs.
4. The model-facing surface cannot invoke arbitrary MTProto methods or change its
   own policy.
5. Telegram sessions, app credentials, and the enforced policy are encrypted and
   integrity-protected at rest.
6. Application-controlled protocol inputs, outputs, and Telegram prose are
   validated, sanitized where applicable, and bounded at their adapters.
7. Telegram writes can use human confirmation, anti-abuse quotas, and an audit
   trail, subject to the limitations below.
8. Service instances sharing one state directory coordinate so that one local
   process owns its Telegram sessions during startup, shutdown, and replacement.

## Non-objectives

This project does not claim to:

- contain an attacker who can modify the installed package, Node.js runtime, or
  running service process;
- protect secrets from the service account itself, an administrator/root user,
  a compromised kernel, or a physical attacker who can alter the host;
- turn an MTProto user session into a Telegram-side least-privilege credential;
- prevent semantic prompt injection in message text;
- provide tamper-evident, complete, or non-repudiable audit records;
- detect replay of an older valid policy or session blob, or substitution of one
  valid session envelope for another session filename;
- make Telegram writes transactional or retract effects already accepted by
  Telegram; or
- guarantee availability under host-wide resource exhaustion, Telegram outage,
  or Telegram account restriction.

There is no Bot API adapter in 0.1.x. A future Bot API integration could use
Telegram's platform-enforced bot identity, membership, and permissions as a
stronger remote capability boundary. It would not isolate this local process or
host.

## Assets

| Asset | Consequence of compromise |
| --- | --- |
| MTProto session | Full control available to the Telegram user session, not merely one configured endpoint |
| Telegram `api_id` and `api_hash` | Exposure of application credentials and assistance in session abuse |
| Sealed policy | Unauthorized scope, verb, kill-switch, download-cap, or endpoint-token changes |
| Endpoint token | Access to the peers and verbs of that endpoint while the token remains valid |
| PIN, passphrase file, or recovery key | Offline decryption of every envelope carrying the corresponding slot |
| Machine-bound key source | Decryption in the default posture when combined with the encrypted state |
| Telegram content and downloaded media | Confidential user data exposed to the model, filesystem, or logs |
| Audit records | Operational metadata, including endpoint, verb, peer identifier, and outcome |

The encrypted session is the highest-impact asset: it is a full-account
credential. Endpoint ACLs are enforced by this process; they do not reduce the
authority of the underlying Telegram session.

## Actors and attacker capabilities

### Trusted operator

The person configuring accounts, endpoints, keys, media directories, and MCP
clients is trusted. For HITL-enabled writes, the operator also trusts the MCP
host to display the elicitation accurately and return the operator's decision.

### MCP client and model

Treat the model and MCP client as potentially adversarial. An attacker in this
class may possess one endpoint token, enumerate the static tool menu, submit any
schema-valid tool arguments, retry requests, and attempt to exploit returned
Telegram content. The expected containment boundary is that endpoint's sealed
scope and verbs.

### Hostile Telegram participant

Anyone able to write into an in-scope chat can supply arbitrary message text,
display names, titles, filenames, and media. Such content may contain control
characters, bidi or zero-width characters, misleading Unicode, or semantic
instructions intended for the model.

### State-copy attacker

This attacker obtains the application state directory or a backup but not the
active unlock secret. The PIN posture is intended to resist offline recovery
from that copy, subject to passphrase strength. The machine-bound posture only
separates an application-state-only copy from the machine identity; a full disk
copy may contain both.

### Same-OS-user local process

A process running as the service OS user is inside the default host boundary. It
may be able to reach the local sockets, read endpoint tokens from MCP client
configuration, derive the machine-bound key, inspect process state, or alter
user-writable code and files. In the machine-bound posture, OS account access is
also the effective operator authorization boundary. The PIN posture adds an
operator credential and offline protection, but it does not make a compromised
running service trustworthy.

A process that can only overwrite `config.json`, but cannot reach the operator
plane or compromise the trusted computing base, cannot directly change the live
policy: the draft is not runtime authority.

### Administrator, service-account compromise, and physical attacker

An administrator/root user, code executing as the dedicated service account, a
compromised OS or runtime, and a physical attacker able to modify the host are
out of scope. These capabilities can read secrets, replace the program, tamper
with prompts, or instrument decryption. A dedicated OS account narrows exposure
to compromise of an everyday account; it does not protect against these stronger
attackers.

### Telegram

Telegram is trusted to authenticate its service, maintain account and chat
identity, and enforce its protocol-side permissions. Telegram availability,
rate limits, account bans, and server-side behavior remain external risks.

## Trust boundaries and trusted computing base

The primary enforcement boundary is the OS identity running the local service.
On Unix, MCP and operator sockets are placed in a verified owner-only directory.
On Windows, named pipes are used; Windows pipe ACL behavior is not currently
covered by the Linux CI environment and remains an alpha limitation.

The trusted computing base includes:

- the local service and CLI code, including the scoped GramJS adapter;
- the Node.js runtime and production dependencies;
- the OS kernel, filesystem permission enforcement, process isolation, and
  cryptographic random source;
- the service account, installed package, and state directory;
- the operator and, when HITL is enabled, the MCP host's confirmation UI; and
- Telegram for remote peer identity and protocol enforcement.

The model, Telegram-authored content, MCP request input, editable draft policy,
and model-supplied local media paths are untrusted.

Running the service under a dedicated OS account can keep its installation and
state outside the everyday user's write domain. The launcher or relay must be
narrowly authorized, and the service account, root, and the host still remain
trusted.

## Implemented controls

### Endpoint authentication and policy publication

Setup creates a 256-bit random endpoint token and stores only a salted SHA-256
digest. Verification uses constant-time comparison. The token selects the
endpoint; an optional endpoint name is only an assertion that must match the
token-selected endpoint. A missing, unknown, or ambiguous token is rejected.
Open connections re-check their token against the current sealed hash on every
tool call, so applying a rotated token revokes subsequent calls on the old
connection.

The endpoint token is a bearer credential. Any process that obtains it can
replay it; the protocol does not bind a token to a client identity or channel.

The runtime authorizes from `policy.blob`, not `config.json`. Applying policy
parses and validates the submitted document, commits an authenticated encrypted
envelope, publishes the validated in-memory projection, and evicts old scoped
bindings in the same process turn. Their disposal then drains asynchronously.
The file commit and live publication are ordered but are not one cross-medium
transaction.

Evidence:

- [`src/infrastructure/endpoint-token.ts`](./src/infrastructure/endpoint-token.ts)
- [`src/application/services/policy-application.ts`](./src/application/services/policy-application.ts)
- [`src/application/services/session-gate.ts`](./src/application/services/session-gate.ts)
- [`src/presentation/mcp/daemon.ts`](./src/presentation/mcp/daemon.ts)
- [`tests/security/sealed-policy`](./tests/security/sealed-policy)

### Per-call authorization and scoped Telegram access

The MCP menu is a static discovery surface, not an authorization decision. Each
tool handler obtains the endpoint from the current sealed policy and runs the
shared ACL pipeline. For a peer-addressed operation:

1. the endpoint token must still match;
2. the requested verb must be granted by the peer's override, or otherwise by
   the endpoint default;
3. the daemon-wide denied set — the operator kill switch — is subtracted;
4. the canonical peer identifier must be in the resolved scope; and
5. the operation runs through a `ScopedClient` bound to that same scope.

A chat override replaces, rather than augments, the endpoint's default verbs.
An empty resolved scope is rejected. Forwarding checks read permission on the
source and forward permission on the destination. Media download requires the
separate `read_media` verb. `prepare_media` requires `send` somewhere in the
resolved scope; `send_media` re-authorizes its concrete destination.

Out-of-scope peers are not addressable through the scoped peer-resolution and
binding surface, and the Telegram adapter checks membership again. This is a
software boundary inside the trusted process. The daemon still owns a
full-account Telegram client internally, so compromise of the adapter or process
can bypass it.

There is no model-facing raw MTProto or policy-mutation tool. The registry rejects
reserved names, and the architecture guard allow-lists direct MTProto request
constructors used by the implementation. These static checks reduce accidental
surface expansion; they are not a sandbox against malicious changes to the
trusted source or high-level dependency behavior.

Evidence:

- [`src/domain/services/default-acl-evaluator.ts`](./src/domain/services/default-acl-evaluator.ts)
- [`src/domain/value-objects/resolved-scope.ts`](./src/domain/value-objects/resolved-scope.ts)
- [`src/application/ports/scoped-client.ts`](./src/application/ports/scoped-client.ts)
- [`src/infrastructure/telegram/gramjs-telegram-gateway.ts`](./src/infrastructure/telegram/gramjs-telegram-gateway.ts)
- [`src/presentation/mcp/registry.ts`](./src/presentation/mcp/registry.ts)
- [`scripts/check-architecture.mjs`](./scripts/check-architecture.mjs)
- [`tests/security/denylist.test.ts`](./tests/security/denylist.test.ts)

### Encryption and secret handling

Session and policy envelopes use a random data-encryption key with AES-256-GCM.
Each unlock slot wraps that key with AES-256-GCM under a key derived with scrypt.
Production passphrase and recovery slots use `N=2^17, r=8, p=1`; machine slots
use `N=2^15, r=8, p=1`. KDF parameters are stored with the envelope, slot count
and allocation are bounded, and authentication failure is reported without
distinguishing a wrong secret from tampering.

The hardened posture does not retain a machine slot alongside a PIN or recovery
slot. The default posture derives access from the host machine identity and is
intended for convenience, not protection from active same-user code or a copied
system disk. Recovery export creates a new file without overwriting an existing
path.

Managed config, policy, session, and recovery files are created with owner-only
mode (`0600`) on POSIX. Their replacement or create-new paths use a
same-directory temporary file, file `fsync`, atomic rename or link, and directory
`fsync` on POSIX. Newly created managed directories request `0700`; existing
operator-selected parent directories remain the operator's responsibility.
Audit appends and media downloads have the separate semantics described below.
Sensitive interactive input is masked and is not intentionally logged.
JavaScript and Node.js do not guarantee that every transient secret copy is
erased from managed memory.

Evidence:

- [`src/infrastructure/session/session-envelope.ts`](./src/infrastructure/session/session-envelope.ts)
- [`src/infrastructure/session/EncryptedFileSessionStore.ts`](./src/infrastructure/session/EncryptedFileSessionStore.ts)
- [`src/infrastructure/atomic-write.ts`](./src/infrastructure/atomic-write.ts)
- [`tests/infrastructure/session-envelope.test.ts`](./tests/infrastructure/session-envelope.test.ts)
- [`tests/infrastructure/encrypted-file-session-store.test.ts`](./tests/infrastructure/encrypted-file-session-store.test.ts)

### Untrusted content handling

Model-facing Telegram prose is NFC-normalized, stripped of control and format
code points except newline and tab, length-capped, and emitted under named JSON
fields. Model-facing Telegram usernames are emitted only after identifier
validation. Tool output is also capped in UTF-8 bytes before it reaches the
model.

These controls reduce hidden formatting channels, limit resource consumption,
and preserve the distinction between data fields and application-generated
messages. They do not determine the meaning of text and do not prevent semantic
prompt injection. The MCP host and model workflow must continue to treat every
Telegram-derived field as untrusted data.

Evidence:

- [`src/shared/sanitize.ts`](./src/shared/sanitize.ts)
- [`src/infrastructure/sanitize/unicode-sanitizer.ts`](./src/infrastructure/sanitize/unicode-sanitizer.ts)
- [`src/presentation/mcp/registry.ts`](./src/presentation/mcp/registry.ts)
- [`tests/shared/sanitize.test.ts`](./tests/shared/sanitize.test.ts)

### Write controls, quotas, and audit

Telegram-effecting writes follow this order:

```text
resolve targets -> ACL -> optional HITL -> quota -> Telegram operation -> audit attempt
```

HITL is configured per endpoint and defaults to off. When it is enabled, a client
without MCP elicitation support cannot approve the write and the operation fails
closed. Declined confirmation consumes no quota. `prepare_media` is local staging
and therefore does not elicit or consume Telegram quota; `send_media` passes the
normal write pipeline.

HITL trusts the MCP host to display the request and return the operator's actual
decision. A malicious or compromised host can synthesize acceptance, so this
control does not cryptographically prove human presence and is not a boundary
against the endpoint-token holder.

Per-account token buckets limit messages, forwards, and search fan-out. A circuit
breaker adds a whole-account cooldown after repeated long waits. This reduces
accidental abuse but does not guarantee that Telegram will not rate-limit or ban
the account.

The append-only NDJSON audit sink serializes writes and attempts to record write
outcomes, use-case denials, and successful media egress. Audit failure is reported
out of band but does not replace the operation result; a Telegram effect may
already have occurred. Successful ordinary reads are not audited.

Evidence:

- [`src/application/use-cases/use-case-engine.ts`](./src/application/use-cases/use-case-engine.ts)
- [`src/infrastructure/rate-limit/token-bucket-rate-limiter.ts`](./src/infrastructure/rate-limit/token-bucket-rate-limiter.ts)
- [`src/infrastructure/audit/file-audit-log.ts`](./src/infrastructure/audit/file-audit-log.ts)
- [`src/presentation/mcp/elicitation-confirmer.ts`](./src/presentation/mcp/elicitation-confirmer.ts)

### Filesystem and resource confinement

Uploads use a two-step, single-use media handle. The service resolves the supplied
path, requires a regular file within the configured media root, enforces a size
cap, and repeats path confinement and size checks immediately before upload.
Downloads use service-generated paths under the media root, check declared size,
enforce transfer progress and final size, and remove partial files on failure.
The media root is process-wide, not an endpoint isolation boundary. All endpoints
share `~/.secure-telegram-mcp/media/downloads` by default.

The implementation bounds handshake and protocol frames, queued and in-flight
requests, output bytes, media-handle and idempotency caches, KDF allocation, and
MCP socket count. Operator output observes stream backpressure. Limits reduce the
impact of malformed or non-reading clients but do not constitute host-wide CPU,
memory, network, or disk quotas.

Evidence:

- [`src/infrastructure/telegram/gramjs-telegram-gateway.ts`](./src/infrastructure/telegram/gramjs-telegram-gateway.ts)
- [`src/presentation/mcp/bounded-stream-transport.ts`](./src/presentation/mcp/bounded-stream-transport.ts)
- [`src/presentation/operator/server.ts`](./src/presentation/operator/server.ts)
- [`src/infrastructure/bounded-read.ts`](./src/infrastructure/bounded-read.ts)

### Process and operator-plane ownership

MCP and operator traffic use separate local addresses and closed protocol
decoders. On Unix their parent directory must have the expected owner and no
group or other access. Socket mode `0600` is an additional control; the verified
directory is the primary boundary.

In the hardened posture, sensitive operator requests require prior authentication
on that socket connection with a passphrase or keyfile. Authentication failures
share an exponential cooldown across connections. Credential transitions advance
an authentication generation, invalidate authentication on other operator
connections, and serialize finite mutations.

A process lease combines a PID and random lease identifier. It is retained until
scoped clients and Telegram connections have drained and the socket listeners are
closed. Crash recovery only removes a recorded owner's socket after establishing
that the PID is dead. This coordinates service instances using the same state
directory. It cannot prevent an external client or a copied session in another
directory from using the same Telegram auth key concurrently.

Evidence:

- [`src/presentation/daemon-socket.ts`](./src/presentation/daemon-socket.ts)
- [`src/presentation/operator/server.ts`](./src/presentation/operator/server.ts)
- [`src/presentation/mcp/daemon.ts`](./src/presentation/mcp/daemon.ts)
- [`tests/presentation/daemon-socket.test.ts`](./tests/presentation/daemon-socket.test.ts)
- [`tests/presentation/operator-server.test.ts`](./tests/presentation/operator-server.test.ts)

## Residual risks and design limitations

### Full-account session

The endpoint policy is a software ACL. Theft of the decrypted MTProto session, or
compromise of the process that owns it, grants the Telegram authority of the user
session. Prefer a dedicated Telegram account when the consequences justify it.
Read-tier tools do not intentionally issue Telegram mutations or read receipts,
but maintaining a connected MTProto user session may still expose presence or
other session metadata to Telegram.

### Policy changes do not preempt admitted operations

After policy publication, new tool calls and context acquisition use the new
policy and old scoped bindings begin draining. An operation already admitted
under the previous policy may complete while its binding drains. Publication
does not cancel or roll back a Telegram effect already in progress.

If the policy seals successfully but live publication or old-binding retirement
fails, the new seal is authoritative on the next start even if the operator did
not receive a success response. Retry `apply` or restart and verify the result.

### Prompt injection

Unicode cleanup and structured JSON reduce hidden-text and presentation risks;
they cannot make hostile prose safe. A message can plainly ask a model to reveal
data or call a tool. Endpoint least privilege, write confirmation, and MCP-host
prompt/data separation remain necessary.

### Local media path race

The service re-resolves and re-checks an upload path immediately before passing
it to GramJS, but it does not hold an opened file descriptor through the upload.
A concurrent writer with access to the media tree may replace the path after the
last check and before GramJS opens it. Use a media root that untrusted processes
cannot modify while a send is in progress.

### At-rest posture

The machine-bound posture does not protect against same-OS-user code or a full
system-disk copy containing machine identity. PIN security depends on passphrase
entropy and protects ciphertext at rest, not a compromised unlocked process.
Endpoint tokens normally remain in plaintext MCP client configuration and are
available to principals that can read those files.

The hardened idle timer measures local service activity, not human presence.
Connections, inbound MCP data, and disconnects reset it, so an active client can
keep the service unlocked. The timer is defense in depth, not a replacement for
locking the host or stopping the service.

### State rollback and transitions

AES-GCM authenticates each envelope's contents, but not its freshness or its
filename. An older valid policy or session blob can be replayed independently;
restoring an older policy can therefore restore broader access without restoring
the rest of the state directory. A valid session envelope can also be moved to a
different valid `.session` filename because the encrypted payload does not carry
or authenticate its `SessionRef`. The service then treats that account as the
reference named by the file. No external monotonic anti-rollback anchor or
path-binding AAD is implemented.

Writing managed state is already inside the same-OS-user trust boundary, but
these limitations also matter for backup, synchronization, and manual restore
procedures. Restore a coherent snapshot and verify account-to-endpoint mappings
and the applied policy before reconnecting MCP clients.

PIN changes and removal update each encrypted blob atomically, but the set of
files is not one transaction. Interruption can leave some blobs on the old source
and others on the new source. Retain both credentials until the change and a
subsequent restart are verified. Export a new recovery key after adding or
replacing accounts or changing the PIN; an older export covers only the slots
present when it was created, except that later policy saves preserve an existing
policy recovery slot.

### Audit limitations

The audit log is local, append-only by convention, and best effort. It is not
authenticated, remotely anchored, rotated, or `fsync`-ed per record. A same-user
writer can alter it, a crash can lose recent entries, and failures before context
acquisition or schema acceptance may not be recorded. Do not use it as the sole
source for compliance, billing, or forensic attribution.

### Resource and availability limits

Download limits apply per transfer, not as a global disk budget. Authenticated
clients can run concurrent downloads and other requests within connection-level
limits. Quotas protect Telegram operations, not every local CPU, memory, disk, or
network cost. Telegram outage, `FLOOD_WAIT`, account restrictions, and host-wide
exhaustion remain possible.

Idempotency is an in-memory, best-effort convenience. It resets when the service
restarts and cannot resolve the case where Telegram accepted a request but the
client received an ambiguous error.

### Folder resolution

Explicit folder members resolve when an endpoint binding is built or rebuilt.
Rule-matched selections created during setup are stored as individual chat
snapshots. Membership changes do not automatically rewrite the sealed policy;
rerun setup and apply when the desired scope changes.

### Platform differences

POSIX owner and mode checks do not apply to Windows named pipes, and the code does
not install an explicit named-pipe ACL. The Windows lease and pipe paths are not
exercised by the current Linux-only CI. Windows is therefore not
security-validated or supported for sensitive deployments in 0.1.x; same-user
isolation and operator-plane lifecycle behavior must be tested before that
status changes.

## Operational guidance

Command examples and environment-variable details are maintained in
[Usage and operations](./docs/USAGE.md#session-protection).

1. Use a dedicated Telegram account when full-account session compromise would
   be unacceptable.
2. Use the PIN posture for backups, synced state, or hosts where an application
   state copy may leave the machine. Unlock interactively by default; for
   headless operation, prefer an owner-only passphrase file to an inline variable.
3. Keep the package installation, state directory, MCP client configuration,
   recovery keys, and media directory private. Do not place them in source
   control or broadly shared backups.
4. Give each MCP client a separate endpoint with the smallest practical scope
   and verbs. Rotate and reapply its token after suspected disclosure.
5. Enable `confirmWrites` for endpoints where an operator can reliably review
   writes. It defaults to off.
6. Keep the default hardened idle lock unless the availability tradeoff is
   understood. Setting `TELEGRAM_MCP_IDLE_HOURS=0` disables it.
7. Use an upload directory that other untrusted processes cannot modify while
   files are being prepared or sent. Monitor the download directory and audit
   append failures.
8. Protect and test recovery material. Keep both old and new unlock sources until
   a PIN transition and restart have succeeded. Restore managed state as one
   coherent snapshot, then verify accounts and the applied policy.
9. Pin and review package and runtime updates. Run `npm run ci` after source
   changes; tests and static guards are regression controls, not proof of
   security.
10. For stronger separation from an everyday user account, run the service under
    a dedicated OS account, with an installation and state directory that the
    everyday user cannot modify directly. Keep any `sudo` rule or relay narrow.
    This does not protect against root, the dedicated account itself, or host
    compromise.

## Security verification

The repository includes focused tests for ACL behavior, sealed-policy authority,
endpoint-token verification, session envelopes, locked serving, policy
publication, operator authentication, process leases, quotas, media caps, audit
behavior, content sanitization, and protocol bounds. `npm run ci` runs type
checking, lint rules, the architecture guard, dead-code analysis, and tests.

These checks are intended to prevent known regressions. They do not replace
dependency review, platform testing, fuzzing, external assessment, or production
monitoring.

## Vulnerability reporting

Report vulnerabilities privately through GitHub's private vulnerability
reporting: the repository's **Security tab -> "Report a vulnerability"**. Do
not disclose an unpatched vulnerability in a public issue, discussion, or PR.

- Supported versions: the latest published 0.x release only.
- Acknowledgement target: within 7 days of the report.
- Disclosure: coordinated — a fix or documented mitigation is published before
  details are; reporters are credited unless they ask not to be.

Operational note: the "Private vulnerability reporting" toggle must be enabled
in the repository settings when this repo goes public — publishing without it
reverts this section to a release blocker.

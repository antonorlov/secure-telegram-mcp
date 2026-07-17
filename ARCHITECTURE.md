# Architecture

[Quickstart](./README.md#quickstart) | [Usage and operations](./docs/USAGE.md) |
[Security](./SECURITY.md)

## Status and scope

This document describes the implemented architecture of
`secure-telegram-mcp` 0.1.x. The project is in alpha: interfaces and storage
formats may change before a stable release.

The scope is the current local, single-host deployment. Roadmap items are not
described as existing capabilities. Security assumptions, threat boundaries,
and residual risks are maintained in [SECURITY.md](./SECURITY.md); operator
commands and deployment examples are maintained in
[Usage and operations](./docs/USAGE.md).

This is design documentation, not a formal security proof. Source and tests are
authoritative for executable behavior.

## System context

`secure-telegram-mcp` is a local modular monolith. One long-lived process owns
Telegram sessions and serves all MCP clients. CLI commands and MCP clients use
two separate local IPC addresses.

```text
                                      Telegram
                                         ^
                                         | MTProto via GramJS
                                         |
MCP host -> connect shim -> MCP socket -> local service
                                           ^      |
                                           |      +-> encrypted sessions
Operator -> setup/start/apply -> operator socket  +-> sealed policy
                                                  +-> audit log / media files

Human-edited config.json --validated apply-------> sealed policy
```

`connect` locates or starts the service, verifies the Unix socket boundary where
applicable, sends the endpoint handshake, and then becomes a transparent
byte-pipe. It owns neither Telegram clients nor session material. The operator
socket serves login, policy, account, and key-posture workflows.

Both sockets terminate in one process. Separation reduces protocol exposure; it
does not create a separate process or OS security principal. IPC protection
depends on the OS account.

## Architectural style

The implementation uses a layered modular monolith. Ports define narrow
capabilities where substitution or isolation is useful. Microservices, an event
bus, and separate read/write models are intentionally absent.

### Source modules

| Module | Responsibility | May depend on |
| --- | --- | --- |
| `shared` | Result type, guards, sanitization primitives, size limits | Node standard library where required |
| `domain` | Endpoint policy, value objects, scope, effective verbs, ACL decisions | `shared` |
| `application` | Use-case orchestration, DTOs, and capability ports | `domain`, `shared` |
| `config` | Zod schema, static scope lint, and mapping to domain objects | `domain`, `shared` |
| `infrastructure` | Filesystem, encryption, rate limiting, audit, QR, and GramJS adapters | inner modules and `config` |
| `presentation` | CLI, operator protocol, MCP transport, tool registry, and composition root | all modules needed for composition |

Dependencies generally point toward domain and application policy. The
composition root knows ports and adapters because it assembles the process.

Only `src/infrastructure/telegram` imports GramJS. Other modules use
project-owned value objects and DTOs.

### Automated checks

- ESLint rejects configured outward imports and `telegram` imports outside
  infrastructure in matching source files.
- `scripts/check-architecture.mjs` is a syntactic source guard. It rejects
  selected raw or scope-mutation tool names, checks literal `new Api.*`
  constructors against an allow-list, and detects several known ways to evade
  that literal form.
- `npm run ci` runs type checking, ESLint, the guard, Knip, and tests.

These checks cover only their encoded patterns; they are not a dependency-graph
or semantic verifier.

## Capability boundaries

These are cohesive capability areas, not independently deployed bounded
contexts:

| Capability | Primary implementation | Boundary |
| --- | --- | --- |
| Access policy | `domain/entities`, `domain/services`, `domain/value-objects` | Immutable domain values and `DefaultAclEvaluator` |
| Policy lifecycle | `config`, `PolicyApplicationService`, `SessionGate` | Validated `LoadedConfiguration` and sealed bytes |
| Session ownership | `EncryptedFileSessionStore`, `AccountRuntimes` | Session administration and unlock ports |
| Telegram access | `infrastructure/telegram` | `ScopedClient` roles and application DTOs |
| MCP execution | tool definitions, shared use-case engines, registry | `EndpointExecutionContext` and MCP schemas |
| Operator workflows | CLI setup, operator client/server, login sessions | Versioned local protocol DTOs |

Domain types cover policy invariants: endpoints, scopes, references, permission
verbs, and ACL decisions. Telegram data and command inputs are application DTOs.

## Components

| Component | Responsibility and owned state |
| --- | --- |
| `SessionGate` | Owns locked/enforced state and synchronously publishes validated replacements |
| `PolicyApplicationService` | Validates, seals exact bytes, then publishes their domain projection |
| `EncryptedFileSessionStore` | Owns encrypted envelopes and the active key-source descriptor |
| `AccountRuntimes` | Caches one stack per `SessionRef`; serializes replacement after disposal |
| `PolicyContexts` | Caches and retires endpoint-scoped bindings |
| `GramjsTelegramGateway` | Owns the GramJS client and produces clients bound to a resolved endpoint scope |
| `DialogFilterFolderResolver` | Expands configured folder and chat references into canonical scope membership |
| Read/write engines | Own target resolution, ACL, confirmation/quota, dispatch, and audit ordering |
| `ToolRegistry` | Registers tools, maps results, rechecks enumerations, and caps output |
| Operator server | Authenticates workflows, serializes mutations, and bounds protocol I/O |

`EndpointExecutionContext` exposes the enforced endpoint, scope, overrides,
denied verbs, and scoped client. It exposes no session store, unscoped gateway,
or GramJS object.

## Sources of truth and derived state

| Data | Authority | Notes |
| --- | --- | --- |
| `config.json` | Editable draft | Has no runtime authorization effect until successfully applied |
| `policy.blob` | Runtime policy source after unlock, once present | Encrypted and authenticated; opened through the same schema/lint/domain pipeline used for the draft |
| `*.session` | Telegram session material | Encrypted envelopes owned by the local service |
| `SessionGate` state | In-memory enforced configuration | Normally projects the sealed policy; before the first policy exists it may hold an endpoint-empty bootstrap state after store verification |
| Resolved scopes and scoped clients | Derived cache | Retired when policy is published; rebuilt lazily |
| Account runtimes | Connection cache keyed by `SessionRef` | Reused across policy changes and MCP connections |
| Audit log | Operational evidence | Append-only by convention and best effort; not an authorization source |

Draft saves and sealed-policy loads share the schema, scope-lint, and domain
mapping pipeline. The domain ACL evaluator combines endpoint grants, per-chat
overrides, resolved scope, and the operator kill switch.

## Runtime flows

### Startup and unlock

1. The service derives the storage posture from encrypted envelope slots.
2. In smooth posture, the machine source can open the sealed policy at startup.
   In hardened posture without a supplied secret, the service starts locked.
3. A locked service may expose the static MCP catalogue for an endpoint found in
   the validated draft. This is display and discovery data only; no tool call can
   acquire a Telegram context while the gate is locked.
4. Successful operator authentication changes the store's active source, then
   opens and validates the sealed policy. If no policy exists yet, verification
   of the encrypted store publishes an endpoint-empty bootstrap configuration.
5. Telegram account stacks and endpoint contexts are created lazily on the first
   operation that needs them.

### MCP connection and tool call

```text
handshake token
  -> select matching endpoint (optional endpoint name must agree)
  -> attach static, non-forbidden tool catalogue
  -> receive bounded MCP frames

each tool call
  -> recheck token against the current sealed endpoint
  -> require an unlocked, currently enforced endpoint
  -> get or build its resolved scope and scoped client
  -> execute the tool's use case
  -> shape, re-filter, and size-check the result
```

Discovery is static, so read-only endpoints see write-tool names. Permission is
checked when a call is admitted.

The common execution order is:

- Read: scoped target resolution -> ACL -> optional read quota -> Telegram read.
- Write: scoped target resolution -> ACL -> optional human confirmation ->
  anti-ban quota -> Telegram write -> audit attempt.
- Media download: read-media ACL -> scoped download -> success audit;
  pre-download denials are audited separately.
- Media preparation: endpoint send capability -> bounded local file
  registration -> audit attempt; sending the handle performs the target-specific
  write checks.

The service has one process-wide media root, shared by all endpoints. Its default
download directory is `~/.secure-telegram-mcp/media/downloads`; endpoint ACLs
control access, not filesystem partitioning.

The application ACL makes the permission decision. The scoped adapter limits
what is addressable through peer resolution and binding; the registry rechecks
enumerated peers. Empty resolved scopes are rejected. These are defense-in-depth
checks, not separate policy sources.

Telegram prose is sanitized and returned in structured fields. This reduces
hidden-control-character and framing risks, not semantic prompt injection.

### Policy application

1. Setup or `apply` submits exact JSON over the operator plane; hardened posture
   authenticates first.
2. `PolicyApplicationService` validates it and commits its exact bytes to the
   encrypted policy file.
3. `SessionGate` replaces the configuration and synchronously evicts derived
   contexts.
4. Bindings retire asynchronously; later calls rebuild while account connections
   remain alive.

After publication, new context acquisition uses new policy. Publication neither
rolls back nor necessarily cancels an operation already admitted under old
policy.

### Operator workflows

The operator socket uses a versioned, bounded NDJSON protocol. Hardened posture
requires connection authentication for account data and state changes. PIN
transitions advance an authentication generation, invalidating stale workflows.
Mutations share a serial queue. Interactive login waits outside it, but its
prompts and result remain bound to that generation.

Temporary login clients stay in the service. Setup receives DTOs and prompts,
not clients or serialized sessions. Login disposal precedes account activation.

## Operational ownership and lifecycle

- The local service is the only intended writer of encrypted sessions and the
  sealed policy. Setup writes the draft and submits policy application through
  the operator protocol.
- One process lease covers Telegram and both sockets. Crash recovery removes
  recorded stale sockets only after the prior PID is determined dead.
- Unix sockets are placed under a verified owner-only directory; socket mode is
  an additional control. Windows uses named pipes, but their same-user isolation
  and lifecycle behavior have not been security-validated; Windows is not
  supported for sensitive deployments in 0.1.x.
- Handshakes, frames, connections, queues, and model-facing output are bounded;
  operator and MCP transports apply backpressure.
- Shutdown stops admission, drains owned runtimes and audit writes, closes
  sockets, then releases the lease. A watchdog terminates a hung teardown.
- Hardened posture defaults to an inactivity shutdown. Smooth posture does not
  use that timer because it can reopen from the machine source without operator
  input.

The same OS user can reach the sockets. Endpoint tokens and hardened operator
authentication remain required at their respective protocol boundaries. Lease
and socket controls do not defend against a process that can modify this program
or control that user account.

## Quality attributes and constraints

| Attribute | Implemented approach | Constraint or tradeoff |
| --- | --- | --- |
| Security | Sealed runtime policy, endpoint tokens, per-call ACL, scoped Telegram capability, operator authentication, encrypted storage | A user-session credential still represents the Telegram account; this is software confinement, not Bot API isolation |
| Correctness | Domain value objects, one config validation pipeline, shared use-case ordering, typed DTOs and schemas | Telegram behavior and remote state remain external dependencies |
| Reliability | Bounded protocols, lazy caches with retirement barriers, atomic individual-file writes, explicit shutdown ordering | Multi-file PIN changes are not a filesystem transaction; audit append failure cannot undo a completed Telegram effect |
| Performance | One shared account connection per session reference, cached scope bindings, static tool catalogue, lazy construction | Caches are process-local; policy changes rebuild scoped bindings |
| Efficiency | Connection and queue caps, output/media limits, paginated tools, sequential operator account loads | Limits protect one process, not a distributed deployment |
| Changeability | GramJS isolation, application DTOs and ports, shared tool engines, explicit composition root | The modular monolith has source-level modules with linted dependency rules, not separately compiled or versioned services |
| Auditability | Structured records for write attempts, relevant denials, and media egress | The audit sink is best effort and is not a tamper-proof external ledger |

Smooth posture uses a machine-bound slot. Hardened posture excludes machine
slots and requires non-machine material: a typed passphrase, a passphrase
keyfile, or a recovery keyfile. Envelopes provide confidentiality and tamper
detection, but do not bind a session envelope to its filename or detect replay
of an older valid blob.

Media preparation checks that a regular file resolves beneath the configured
media root before issuing a handle. A concurrent writer to that tree can still
replace the pathname between validation and the later Telegram open (TOCTOU), so
the media root's write ownership is part of the deployment boundary.

## Key decisions and tradeoffs

| Decision | Reason | Consequence |
| --- | --- | --- |
| One Telegram-owning process per state directory | Coordinate local service instances and share connections | Requires local IPC, a lease, and explicit lifecycle management; copied sessions and external clients are outside the lease |
| Static tool catalogue, dynamic authorization | Policy changes take effect without reconnecting MCP clients | Tool visibility must not be interpreted as permission |
| Sealed policy separate from draft | A hand edit cannot directly widen live authorization | Applying a draft is an explicit operational step |
| Application ACL plus scoped adapter | Keep policy evaluation testable while limiting the Telegram capability below it | Some scope checks are intentionally repeated |
| GramJS user session | Supports the required user-account feature set | Compromise of decrypted session material has account-wide impact |

## Extension constraints

Changes must preserve the following architectural properties:

1. Model-facing tools must not expose raw MTProto invocation or policy/scope
   mutation.
2. Tool operations must enter through an application-layer authorization use
   case and receive only a scoped Telegram capability.
3. GramJS types and clients must remain inside infrastructure and the composition
   root must not pass unscoped clients into MCP tool handlers.
4. Authorization for any executable endpoint must come from a validated sealed
   policy. The editable draft may influence locked discovery only.
5. New protocol inputs, outputs, queues, and file operations require explicit
   bounds and lifecycle ownership.
6. Any multi-process or multi-host design must replace the current single-owner
   assumptions for Telegram auth keys, quotas, caches, policy publication, and
   audit ordering.

New tools require an application spec, presentation schema/definition, catalogue
wiring, behavioral tests, and review of any new MTProto constructor. New
permissions require a domain verb and tier classification.

Bot API would provide a different platform-enforced identity and capability
boundary; it would not isolate this local process or host. Add its adapter or
common abstraction only with the feature. Realtime updates, proxy support, and
durable shared caches are future work, not current stubs.

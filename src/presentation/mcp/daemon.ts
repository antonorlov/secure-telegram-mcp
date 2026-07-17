/**
 * daemon — the one long-lived process that owns the Telegram connection and serves
 * every MCP client through the local socket (`daemonAddress`). Telegram's auth key
 * must have exactly one owner-process (two concurrent connections on one key =
 * AUTH_KEY_DUPLICATED = revoked session), so the daemon holds the single GramJS
 * stack per sessionRef and every client is just a pipe into it.
 *
 * LOCKED BUT SERVING: the MCP listener still exposes its static tool menu while a
 * hardened store is locked, but every tool call fails closed before Telegram. The
 * physically separate operator listener is the only place that accepts an unlock
 * credential or an administrative operation.
 *
 * Per-connection protocol (the `connect` shim's contract):
 *   1. first line: JSON handshake
 *      `{ v: 1, token?, endpoint? }` + `\n` (closed schema);
 *   2. newline-delimited MCP JSON-RPC over the same stream;
 *   3. on failure: one JSON error line, then the socket closes (secret-free).
 *
 * AUTHORIZATION: the endpoint API key (hash in config) is the door key — a client
 * resolves to exactly the endpoint its token matches. A token-less / name-only
 * handshake is always refused (fail-closed). While locked the display menu is read
 * from an unverified plain parse of config.json (tool names only); execution always
 * binds to the enforced, sealed policy re-opened at unlock, so the sealed policy
 * still governs authz.
 *
 * POLICY APPLY: the authenticated operator plane validates and durably seals a
 * policy, then atomically publishes its live projection. Only scope-derived
 * bindings are retired; the per-account Telegram connection remains the same
 * owner for its entire daemon lifetime.
 *
 * Lifecycle: a process lease is held until Telegram teardown and socket close both
 * finish. A replacement may unlink a crashed daemon's socket only after recovering
 * that lease from a proven-dead PID.
 */
import { createServer, connect as netConnect, type Socket, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  appError,
  AppErrorCode,
  PolicyApplicationService,
  SessionGate,
} from '../../application/index.js';
import type {
  AppError,
  ConfigRepository,
  ConfigDocumentParser,
  EndpointExecutionContext,
  KillSwitch,
  LoadedConfiguration,
  SealedPolicyStore,
  SessionMaterial,
  SessionKeySource,
} from '../../application/index.js';
import { SessionRef, type Endpoint, type SessionRefValue } from '../../domain/index.js';
import {
  EncryptedFileSessionStore,
  ENDPOINT_TOKEN_ENV,
  createEndpointTokenVerifier,
  endpointTokenMatches,
  FileAuditLog,
  GramjsAccountLoginClient,
  SystemClock,
  TokenBucketRateLimiter,
  UnicodeSanitizer,
  daemonAddress,
  operatorAddress,
  isSocketFile,
  socketDirRefusal,
} from '../../infrastructure/index.js';
import { err, isErr, ok, type Result } from '../../shared/index.js';
import {
  createConnectionServer,
  createSessionStack,
  resolveApiCreds,
  resolveEndpointRuntime,
  type EndpointRuntime,
  type SessionStack,
} from './endpoint-stack.js';
import { AccountRuntimes } from './account-runtimes.js';
import { PolicyContexts } from './policy-contexts.js';
import { BoundedStreamServerTransport } from './bounded-stream-transport.js';
import { createOperatorServer } from '../operator/server.js';
import { OperatorLoginSessions } from '../operator/login-sessions.js';
import {
  acquireDaemonProcessLease,
  recoverStaleDaemonSocket,
} from '../daemon-socket.js';

/** The shim's first line. The decoder is closed so operator fields cannot cross planes. */
export interface DaemonHandshake {
  readonly v: 1;
  readonly token?: string;
  readonly endpoint?: string;
}

/** Maximum UTF-8 bytes before the handshake newline. */
export const MAX_HANDSHAKE_BYTES = 4096;

export const parseHandshake = (line: string): DaemonHandshake | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const r = parsed as Record<string, unknown>;
    if (r['v'] !== 1) return undefined;
    if (!Object.keys(r).every((key) => ['v', 'token', 'endpoint'].includes(key))) {
      return undefined;
    }
    if (r['token'] !== undefined && typeof r['token'] !== 'string') return undefined;
    if (r['endpoint'] !== undefined && typeof r['endpoint'] !== 'string') return undefined;
    return r as unknown as DaemonHandshake;
  } catch {
    return undefined;
  }
};

/**
 * Resolve which endpoint a handshake may use — pure + fail-closed:
 *  - a token resolves to the endpoint whose hash it matches (and must agree with
 *    `endpoint` when both are present);
 *  - a bare name (no token) can never open an endpoint — a name-only handshake is
 *    always refused;
 *  - anything else is refused with a secret-free reason.
 */
export const resolveHandshakeEndpoint = (
  endpoints: readonly Endpoint[],
  handshake: DaemonHandshake,
): { endpoint: Endpoint } | { error: string } => {
  const token = handshake.token;
  if (token !== undefined && token.length > 0) {
    let matched: Endpoint | undefined;
    for (const endpoint of endpoints) {
      if (!endpointTokenMatches(token, endpoint.tokenHash)) continue;
      if (matched !== undefined) {
        return { error: 'unknown endpoint API key' };
      }
      matched = endpoint;
    }
    if (matched === undefined) {
      return { error: 'unknown endpoint API key' };
    }
    if (
      handshake.endpoint !== undefined &&
      handshake.endpoint !== String(matched.name)
    ) {
      return { error: 'endpoint API key does not match the requested endpoint' };
    }
    return { endpoint: matched };
  }
  return {
    error: `this endpoint requires its API key (${ENDPOINT_TOKEN_ENV})`,
  };
};

/**
 * Read the handshake line from a socket, UNSHIFTING any bytes that followed it
 * in the same chunk back onto the stream (they are the start of the MCP
 * conversation and belong to the transport).
 *
 * CONTRACT: resolves with the stream PAUSED. Listening for 'data' put the
 * socket into flowing mode; if we left it flowing, every byte arriving between
 * this resolve and the transport attaching its own 'data' listener (an async
 * gap: endpoint context/scope resolution) would be emitted to nobody and
 * silently lost — the client's `initialize` died exactly there. Paused, those
 * bytes buffer in order. The caller MUST socket.resume() after attaching the
 * consumer: Node does not re-enter flowing mode on listener-attach once a
 * stream was explicitly paused, and StdioServerTransport.start() never calls
 * resume() itself.
 */
export const readHandshakeLine = (
  socket: Socket,
  timeoutMs: number,
): Promise<string | undefined> =>
  new Promise((resolvePromise) => {
    let buffered: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise(undefined);
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      const nl = chunk.indexOf(0x0a);
      if (nl === -1) {
        if (buffered.length + chunk.length > MAX_HANDSHAKE_BYTES) {
          cleanup();
          resolvePromise(undefined); // oversized pre-handshake garbage
          return;
        }
        buffered =
          buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
        return;
      }
      if (buffered.length + nl > MAX_HANDSHAKE_BYTES) {
        cleanup();
        resolvePromise(undefined);
        return;
      }
      const line =
        buffered.length === 0
          ? chunk.subarray(0, nl).toString('utf8')
          : Buffer.concat([buffered, chunk.subarray(0, nl)]).toString('utf8');
      const rest = chunk.subarray(nl + 1);
      cleanup();
      // Pause BEFORE unshifting: flowing-mode re-emission is scheduled on
      // nextTick, which would fire (listener-less) before any caller code runs.
      socket.pause();
      if (rest.length > 0) socket.unshift(rest);
      resolvePromise(line);
    };
    const onEnd = (): void => {
      cleanup();
      resolvePromise(undefined);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onEnd);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onEnd);
  });

/** Pre-handshake window: long enough for a local shim, short enough to bound fd use. */
const HANDSHAKE_TIMEOUT_MS = 3_000;

/** Cap on simultaneously-open sockets (local shims only) — bounds fd exhaustion. */
const MAX_CONNECTIONS = 64;

/** The user-facing read-out for a PIN-locked store (shim preflight, daemon, docs). */
export const SESSION_LOCKED_MESSAGE =
  "Telegram MCP is locked. Run 'npx secure-telegram-mcp start' in a terminal, then retry.";

/**
 * Per-call authorization failure: the connection's presented endpoint API key no
 * longer matches this endpoint's enforced `tokenHash` (rotated or revoked by a live
 * policy apply). Re-checked on every call, not just at handshake, so a leaked/rotated key
 * stops working on an already-open connection, not only on reconnect. Secret-free.
 */
export const ENDPOINT_KEY_REVOKED_MESSAGE =
  'endpoint API key is no longer valid (rotated or revoked) — reconnect with the current key';

/**
 * Pure lock policy: a HARDENED store cannot be served by a daemon that has no
 * PIN channel (headless auto-start would silently fail per-connection instead).
 */
export const isLockedWithoutPin = (
  posture: 'none' | 'smooth' | 'hardened',
  keySourceKind: string,
): boolean => posture === 'hardened' && keySourceKind === 'machine';

/** Default idle window before an unlocked daemon auto-locks (hours). */
const DEFAULT_DAEMON_IDLE_HOURS = 12;

/**
 * The idle auto-lock window in ms: how long the daemon may sit with no client
 * activity before it locks (shuts down, zeroizing the session, so the next connect
 * must re-enter the PIN). Only meaningful under HARDENED — a SMOOTH (machine-key)
 * daemon would just silently machine-unlock again, so this returns 0 (disabled)
 * there. Tunable via TELEGRAM_MCP_IDLE_HOURS: 0/negative/invalid disables;
 * empty/unset means the 12-hour default.
 */
export const resolveDaemonIdleMs = (
  env: Readonly<Record<string, string | undefined>>,
  keySourceKind: string,
): number => {
  if (keySourceKind === 'machine') return 0;
  const raw = env['TELEGRAM_MCP_IDLE_HOURS'];
  const hours =
    raw === undefined || raw.trim() === ''
      ? DEFAULT_DAEMON_IDLE_HOURS
      : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.round(hours * 60 * 60 * 1000);
};

/**
 * The per-tool-call fail-closed context decision — the daemon's one lock
 * chokepoint, kept pure so it is exercised by the real daemon and unit-testable. It
 * yields the enforced context only when (a) the gate is unlocked and (b) the
 * enforced (sealed-policy) menu still carries this endpoint + kill-switch; otherwise
 * a secret-free `SessionLocked` error, without ever invoking `acquireContext` — so
 * the scoped client / gateway is never touched while locked, and a locked-window
 * (plain, possibly-widened) endpoint absent from the enforced menu can never govern
 * execution. A gateway-build failure maps to `GatewayUnavailable`.
 *
 * SECURITY ORDERING (do not reorder): the `isUnlocked()` and enforced-menu checks
 * run BEFORE `acquireContext`; moving acquisition earlier would touch the gateway on
 * a locked call.
 */
export const lockedContextProvider =
  (
    gate: Pick<
      SessionGate,
      'isUnlocked' | 'enforcedEndpoint' | 'enforcedKillSwitch'
    >,
    acquireContext: (
      endpoint: Endpoint,
      killSwitch: KillSwitch,
    ) => Promise<EndpointExecutionContext>,
    endpointName: string,
    /**
     * Re-authorize this connection's presented API key against the endpoint's
     * current enforced `tokenHash`. Run every call so a key rotated/revoked by a live
     * policy apply stops working on the already-open connection, not only on reconnect.
     */
    authorizeToken: (endpoint: Endpoint) => boolean,
  ) =>
  async (): Promise<Result<EndpointExecutionContext, AppError>> => {
    if (!gate.isUnlocked()) {
      return err(appError(AppErrorCode.SessionLocked, SESSION_LOCKED_MESSAGE));
    }
    const enforcedEndpoint = gate.enforcedEndpoint(endpointName);
    const enforcedKillSwitch = gate.enforcedKillSwitch();
    if (enforcedEndpoint === undefined || enforcedKillSwitch === undefined) {
      // Unlocked, but this endpoint is absent from the enforced config -> the
      // locked-window plain menu listed it but authz denies it. Fail closed.
      return err(appError(AppErrorCode.SessionLocked, SESSION_LOCKED_MESSAGE));
    }
    if (!authorizeToken(enforcedEndpoint)) {
      // Unlocked and the endpoint still exists, but the key presented at handshake no
      // longer matches its enforced tokenHash (rotated/revoked by policy apply). Fail
      // closed on the existing connection.
      return err(appError(AppErrorCode.AclDenied, ENDPOINT_KEY_REVOKED_MESSAGE));
    }
    try {
      return ok(await acquireContext(enforcedEndpoint, enforcedKillSwitch));
    } catch (e) {
      return err(
        appError(
          AppErrorCode.GatewayUnavailable,
          e instanceof Error ? e.message : 'endpoint start failed',
        ),
      );
    }
  };

/**
 * Composition options for the sole Telegram-owning runtime. The daemon binds and serves even while
 * PIN-locked, so it needs both bound to its one shared, re-keyable store:
 *  - `makeConfigRepository`: builds the enforced (sealed-policy) repo whose
 *    sealed-policy store IS the shared session store, so a runtime unlock's
 *    `setActiveSource` re-keys the policy open too. Loaded lazily at unlock; drives execution.
 *  - `plainConfigRepository`: a keyless parser used only while locked to render the
 *    tool-name menu from the config.json draft (unverified, display-only — never
 *    governs authorization; execution binds to the sealed policy).
 */
export interface DaemonOptions {
  readonly apiId?: number;
  readonly apiHash?: string;
  readonly sessionDir: string;
  readonly sessionKey: SessionKeySource;
  readonly auditLogPath: string;
  readonly mediaRootDir: string;
  readonly logger?: (message: string) => void;
  readonly exit?: (code: number) => void;
  /** Test/deployment seam for idle policy; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly makeConfigRepository: (
    store: SealedPolicyStore,
  ) => ConfigRepository;
  readonly plainConfigRepository: ConfigRepository;
  readonly configParser: ConfigDocumentParser;
}

const DEFAULT_QUOTA = {
  messagesPerMin: 20,
  forwardsPerMin: 10,
  searchesPerMin: 60,
} as const;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

export const daemon = async (options: DaemonOptions): Promise<void> => {
  const log =
    options.logger ??
    ((message: string): void => {
      process.stderr.write(`[secure-telegram-mcp][service] ${message}\n`);
    });
  const exit = options.exit ?? ((code: number): void => process.exit(code));

  const clock = new SystemClock();
  // Concrete store on purpose: this daemon is the sole encrypted-state owner, so
  // operator commands and runtime reads share one active key source.
  const sessions = new EncryptedFileSessionStore({
    directory: options.sessionDir,
    keySource: options.sessionKey,
  });

  // LOCKED BUT SERVING: a hardened store with no PIN channel comes up locked, yet
  // still binds and serves. Endpoint resolution + the tool menu are PIN-free; only
  // per-call gateway acquisition is gated (fail-closed) until a one-time unlock.
  const initialPosture = await sessions.appPosture();
  const locked = isLockedWithoutPin(initialPosture, options.sessionKey.kind);
  let operatorPosture = initialPosture;
  let activeSourceKind = options.sessionKey.kind;

  // The ENFORCED (sealed-policy) config repo — its sealed-policy store IS the
  // shared session store, so a runtime `setActiveSource` re-keys the policy open.
  const authRepo = options.makeConfigRepository(sessions);
  const plainRepo = options.plainConfigRepository;

  // The locked-window display menu (endpoint resolution + tool names): read from the
  // keyless plain parser (unverified — display only, execution never uses it). Once
  // the gate is unlocked, endpoint resolution derives from its enforced menu instead.
  let plainEndpoints: readonly Endpoint[] = [];
  let initialEnforced: LoadedConfiguration | undefined;
  if (locked) {
    // Locked mode cannot decrypt a hardened blob under the machine source; this
    // probe only distinguishes a missing first-run policy from a present seal.
    // Unlocked mode skips it and opens the policy exactly once below.
    const policyProbe = await sessions.loadPolicy();
    const policyMissing = policyProbe.ok && policyProbe.value === undefined;
    if (policyProbe.ok && policyProbe.value !== undefined) {
      policyProbe.value.fill(0);
    }
    if (!policyMissing) {
      const plain = await plainRepo.load();
      if (isErr(plain)) {
        // The draft is display-only while locked. Refusing the operator socket
        // here would make a hand-edit typo block recovery of the valid seal.
        // Expose no MCP endpoint until authentication publishes that seal.
        log(
          `config draft unavailable while locked (${plain.error.message}); ` +
            'MCP endpoints remain unavailable until operator authentication',
        );
      } else {
        plainEndpoints = plain.value.endpoints;
      }
    }
  } else {
    // Unlocked at boot: load the enforced config. A genuinely empty store starts
    // operator-only so first-run login/configuration can be daemon-owned.
    const enforcedRes = await authRepo.load();
    if (isErr(enforcedRes)) {
      if (enforcedRes.error.code !== AppErrorCode.NotFound) {
        throw new Error(`failed to load config: ${enforcedRes.error.message}`);
      }
      initialEnforced = {
        endpoints: [],
        killSwitch: { disabledVerbs: new Set() },
      };
    } else {
      initialEnforced = enforcedRes.value;
    }
  }

  // The one shared lock-state gate + atomic one-time transition.
  const gate = new SessionGate(
    sessions,
    authRepo,
    initialEnforced,
  );
  const policyApplication = new PolicyApplicationService(
    options.configParser,
    sessions,
    gate,
  );

  // Shared, lazily-built runtime caches: one session stack per sessionRef; one
  // resolved context per endpoint. The audit log + rate limiter are process-wide
  // (limits are anti-ban, per account activity — shared across connections by design).
  const auditLog = new FileAuditLog({
    filePath: options.auditLogPath,
    // A broken audit sink must be LOUD (a write may have executed with no record).
    onAppendFailure: (reason): void => {
      log(`AUDIT WRITE FAILED (${reason}) — the append-only audit trail has a gap`);
    },
  });
  const rateLimiter = new TokenBucketRateLimiter(clock, DEFAULT_QUOTA);
  // Account connections outlive policy revisions. Scope-derived clients are
  // separate, disposable bindings, so an ACL edit never redials Telegram.
  const accounts = new AccountRuntimes<SessionStack>((stack) =>
    stack.gateway.dispose(),
  );
  const contexts = new PolicyContexts<EndpointRuntime>(
    (context) => context.dispose(),
    (reason): void => {
      log(`TEARDOWN FAILED while retiring a scoped binding (${reason})`);
    },
  );
  const mutateAccountRuntime = <T>(
    sessionRef: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const endpointNames = new Set(
      gate
        .enforcedEndpoints()
        .filter((endpoint) => String(endpoint.sessionRef) === sessionRef)
        .map((endpoint) => String(endpoint.name)),
    );
    contexts.retire(endpointNames);
    const contextBarrier = contexts.barrier();
    return accounts.withRetired(sessionRef, work, () => contextBarrier);
  };
  const loginSessions = new OperatorLoginSessions(
    sessions,
    ({ apiId, apiHash }) =>
      new GramjsAccountLoginClient({
        apiId,
        apiHash,
        sanitizer: new UnicodeSanitizer(),
        logger: log,
      }),
    mutateAccountRuntime,
  );

  const stackForRef = (
    sessionRef: SessionRefValue,
    label: string,
  ): Promise<SessionStack> => {
    if (shuttingDown) {
      return Promise.reject(new Error('Telegram MCP is stopping'));
    }
    const ref = String(sessionRef);
    return accounts.get(ref, async (): Promise<SessionStack> => {
      const materialRes = await sessions.load(sessionRef);
      if (isErr(materialRes)) {
        throw new Error(
          `cannot unlock Telegram session '${ref}' for ${label}: ${materialRes.error.message}`,
        );
      }
      const material: SessionMaterial = materialRes.value;
      const creds = resolveApiCreds(material, options, label);
      return createSessionStack({
        apiId: creds.apiId,
        apiHash: creds.apiHash,
        sessionSecret: material.secret,
        mediaRootDir: options.mediaRootDir,
        clock,
        log,
      });
    });
  };

  const stackFor = (endpoint: Endpoint): Promise<SessionStack> =>
    stackForRef(endpoint.sessionRef, `endpoint '${String(endpoint.name)}'`);

  // Bound to the enforced (endpoint, killSwitch) — the provider always feeds this the
  // target re-resolved from the gate's enforced menu, so a locked-window (plain,
  // possibly-widened) endpoint can never govern execution.
  const contextFor = (
    endpoint: Endpoint,
    endpointKillSwitch: KillSwitch,
  ): Promise<EndpointExecutionContext> =>
    contexts
      .get(String(endpoint.name), async (): Promise<EndpointRuntime> => {
        const stack = await stackFor(endpoint);
        const maxDownloadBytes = gate.enforcedMaxDownloadBytes();
        return resolveEndpointRuntime({
          endpoint,
          killSwitch: endpointKillSwitch,
          stack,
          log,
          ...(maxDownloadBytes !== undefined ? { maxDownloadBytes } : {}),
        });
      })
      .then((runtime) => runtime.context);

  // The lazy, per-tool-call context provider (the fail-closed chokepoint):
  // {@link lockedContextProvider} bound to this daemon's shared gate + gateway
  // acquisition. No gateway is touched while locked.
  const providerFor = (
    endpointName: string,
    presentedToken: string | undefined,
  ): (() => Promise<Result<EndpointExecutionContext, AppError>>) => {
    const verifyToken =
      presentedToken === undefined
        ? (): boolean => false
        : createEndpointTokenVerifier(presentedToken);
    return lockedContextProvider(
      gate,
      contextFor,
      endpointName,
      (ep: Endpoint): boolean => verifyToken(ep.tokenHash),
    );
  };

  const refuse = (socket: Socket, reason: string): void => {
    log(`connection refused: ${reason}`);
    socket.end(`${JSON.stringify({ error: reason })}\n`);
  };

  // Reset by every connection / request / disconnect. The real impl is wired after
  // the server + `shutdown` exist (idle auto-lock, below); a noop until then and
  // whenever the idle lock is disabled. `idleMs` is a `let`: 0 (no timer) while
  // locked, recomputed to the passphrase window at unlock.
  const environment = options.env ?? process.env;
  let idleMs = resolveDaemonIdleMs(environment, options.sessionKey.kind);
  let bumpIdle: () => void = () => undefined;

  // Flipped SYNCHRONOUSLY at shutdown, BEFORE the retirement drain: while the
  // daemon still holds its lifetime lease but is releasing Telegram ownership,
  // no new connection and no new stack build may re-acquire it.
  let shuttingDown = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const setIdleSourceKind = (kind: string): void => {
    idleMs = resolveDaemonIdleMs(environment, kind);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    bumpIdle();
  };

  // Same-uid is only a transport boundary. Hardened operator authentication is
  // still brute-force throttled across connections; the first typo is free and
  // subsequent failures earn an exponential cooldown.
  const AUTH_BACKOFF_BASE_MS = 1_000;
  const AUTH_BACKOFF_MAX_MS = 30_000;
  let authenticationFailures = 0;
  let authenticationBackoffUntilMs = 0;
  const authenticationCoolingDown = (): boolean =>
    clock.nowMs() < authenticationBackoffUntilMs;
  const recordAuthenticationFailure = (): void => {
    authenticationFailures += 1;
    if (authenticationFailures >= 2) {
      const delay = Math.min(
        AUTH_BACKOFF_MAX_MS,
        AUTH_BACKOFF_BASE_MS * 2 ** (authenticationFailures - 2),
      );
      authenticationBackoffUntilMs = clock.nowMs() + delay;
    }
  };
  const recordAuthenticationSuccess = (): void => {
    authenticationFailures = 0;
    authenticationBackoffUntilMs = 0;
  };

  /**
   * The ONE synchronous publish hook, shared by every enforced-menu swap (first
   * unlock or policy apply). SessionGate invokes it in the SAME frame it
   * republishes the enforced menu, so the previous policy bindings are retired
   * with no await in between. A concurrent call cannot bind a stale scope/cap;
   * account stacks deliberately remain connected. Everything menu-shaped
   * (endpoints, kill-switch, download cap) is read from the gate directly.
   */
  const publishEnforced = (): void => {
    contexts.retire();
  };

  const operatorServer = createOperatorServer({
    onActivity: (): void => { bumpIdle(); },
    handlers: {
      // Never derive authorization posture from mutable files after boot. A
      // corrupted blob must fail closed, not masquerade as an empty store and
      // disable operator authentication while this process still holds the key.
      requiresAuthentication: () =>
        Promise.resolve(operatorPosture === 'hardened'),
      status: async () => {
        const refs = await sessions.listRefs();
        if (isErr(refs)) throw new Error(refs.error.message);
        return {
          posture: operatorPosture,
          locked: !gate.isUnlocked(),
          hasAccounts: refs.value.length > 0,
        };
      },
      listAccounts: async () => {
        const refs = await sessions.listRefs();
        if (isErr(refs)) return refs;
        // Hardened loads run a memory-hard KDF. This operator-only cold path is
        // deliberately sequential so four accounts cannot create a ~512 MiB
        // scrypt burst merely to render the account menu.
        const accounts: { sessionRef: string; label?: string }[] = [];
        for (const sessionRef of refs.value) {
          const material = await sessions.load(sessionRef);
          accounts.push({
            sessionRef: String(sessionRef),
            ...(!isErr(material) && material.value.label !== undefined
              ? { label: material.value.label }
              : {}),
          });
        }
        return ok({ accounts });
      },
      authenticate: async (
        source: Exclude<SessionKeySource, { readonly kind: 'machine' }>,
      ) => {
        if (shuttingDown) {
          return err(
            appError(AppErrorCode.GatewayUnavailable, 'Telegram MCP is unavailable'),
          );
        }
        if (authenticationCoolingDown()) {
          return err(
            appError(
              AppErrorCode.QuotaExceeded,
              'operator authentication is cooling down',
            ),
          );
        }
        const wasLocked = !gate.isUnlocked();
        const authenticated = await gate.authenticateOperator(
          source,
          publishEnforced,
        );
        if (isErr(authenticated)) {
          recordAuthenticationFailure();
          return authenticated;
        }
        try {
          await contexts.barrier();
          recordAuthenticationSuccess();
          if (wasLocked) activeSourceKind = source.kind;
          setIdleSourceKind(
            operatorPosture === 'smooth' ? 'machine' : activeSourceKind,
          );
          return ok(undefined);
        } catch {
          return err(
            appError(
              AppErrorCode.GatewayUnavailable,
              'could not retire the previous scoped policy bindings',
            ),
          );
        }
      },
      applyPolicy: async (raw: string) => {
        if (shuttingDown) {
          return err(
            appError(AppErrorCode.GatewayUnavailable, 'Telegram MCP is unavailable'),
          );
        }
        const bytes = Buffer.from(raw, 'utf8');
        try {
          const digest = createHash('sha256').update(bytes).digest('hex');
          const applied = await policyApplication.apply(bytes, publishEnforced);
          if (isErr(applied)) return applied;
          if (operatorPosture === 'none') {
            operatorPosture =
              activeSourceKind === 'machine' ? 'smooth' : 'hardened';
          }
          try {
            await contexts.barrier();
            return ok({ digest });
          } catch {
            return err(
              appError(
                AppErrorCode.GatewayUnavailable,
                'policy was sealed but old scoped bindings did not retire cleanly',
              ),
            );
          }
        } finally {
          bytes.fill(0);
        }
      },
      snapshotAccount: async (rawRef: string) => {
        const parsed = SessionRef.create(rawRef);
        if (isErr(parsed)) {
          return err(
            appError(AppErrorCode.Validation, 'invalid Telegram session reference'),
          );
        }
        try {
          const stack = await stackForRef(
            parsed.value,
            `operator account '${rawRef}'`,
          );
          return await stack.gateway.snapshotAccount(parsed.value);
        } catch (error) {
          return err(
            appError(
              AppErrorCode.GatewayUnavailable,
              error instanceof Error ? error.message : 'account unavailable',
            ),
          );
        }
      },
      beginLogin: (ownerId, flowId, input, interaction) =>
        loginSessions.begin(ownerId, flowId, input, interaction),
      commitLogin: async (ownerId, flowId, rawRef, source) => {
        const parsed = SessionRef.create(rawRef);
        if (isErr(parsed)) {
          return err(
            appError(
              AppErrorCode.Validation,
              'invalid Telegram session reference',
            ),
          );
        }
        const committed = await loginSessions.commit(
          ownerId,
          flowId,
          parsed.value,
          source,
        );
        if (!isErr(committed) && operatorPosture === 'none') {
          activeSourceKind = source.kind;
          operatorPosture =
            source.kind === 'machine' ? 'smooth' : 'hardened';
          setIdleSourceKind(source.kind);
        }
        return committed;
      },
      cancelLogin: (ownerId, flowId) => loginSessions.cancel(ownerId, flowId),
      disconnect: (ownerId) => loginSessions.cancelOwner(ownerId),
      removeAccount: async (rawRef) => {
        const parsed = SessionRef.create(rawRef);
        if (isErr(parsed)) {
          return err(
            appError(AppErrorCode.Validation, 'invalid Telegram session reference'),
          );
        }
        try {
          const removed = await mutateAccountRuntime(
            String(parsed.value),
            () => sessions.remove(parsed.value),
          );
          if (isErr(removed)) return removed;
          rateLimiter.forgetSession(String(parsed.value));
          return ok({ changed: true as const });
        } catch {
          return err(
            appError(
              AppErrorCode.GatewayUnavailable,
              'could not release the account runtime',
            ),
          );
        }
      },
      setPin: async (current, pin) => {
        const changed = await sessions.addKek({ current, pin });
        if (isErr(changed)) return changed;
        sessions.setActiveSource(pin);
        activeSourceKind = pin.kind;
        operatorPosture = 'hardened';
        setIdleSourceKind(pin.kind);
        return ok({ changed: true as const });
      },
      changePin: async (current, replacement) => {
        const changed = await sessions.rewrapKek({ current, replacement });
        if (isErr(changed)) return changed;
        sessions.setActiveSource(replacement);
        activeSourceKind = replacement.kind;
        operatorPosture = 'hardened';
        setIdleSourceKind(replacement.kind);
        return ok({ changed: true as const });
      },
      removePin: async (current) => {
        const changed = await sessions.removeKek({ current });
        if (isErr(changed)) return changed;
        sessions.setActiveSource({ kind: 'machine' });
        activeSourceKind = 'machine';
        operatorPosture = 'smooth';
        setIdleSourceKind('machine');
        return ok({ changed: true as const });
      },
      exportRecovery: async (current, outputPath) => {
        const emitted = await sessions.emitRecoveryKeyfile({ current, outputPath });
        return isErr(emitted) ? emitted : ok({ changed: true as const });
      },
    },
  });

  const onConnection = async (socket: Socket): Promise<void> => {
    socket.on('error', () => socket.destroy());
    if (shuttingDown) {
      refuse(socket, 'Telegram MCP is stopping. Retry shortly.');
      return;
    }
    bumpIdle(); // a fresh connection counts as activity
    const line = await readHandshakeLine(socket, HANDSHAKE_TIMEOUT_MS);
    if (line === undefined) {
      refuse(socket, 'missing or malformed handshake');
      return;
    }
    const handshake = parseHandshake(line);
    if (handshake === undefined) {
      refuse(socket, 'missing or malformed handshake');
      return;
    }
    // Display menu resolution: the ENFORCED endpoints once unlocked; the unverified
    // plain parse only during the locked window (execution never binds to it).
    const resolved = resolveHandshakeEndpoint(
      gate.isUnlocked() ? gate.enforcedEndpoints() : plainEndpoints,
      handshake,
    );
    if ('error' in resolved) {
      refuse(socket, resolved.error);
      return;
    }
    const endpointName = String(resolved.endpoint.name);
    try {
      // Build the server immediately from the resolved endpoint (PIN-free menu) — no
      // eager context resolution. The gateway is acquired lazily per call via the
      // provider, which fails closed while locked.
      const { server, toolNames } = createConnectionServer({
        // Re-authorize this connection's presented key on every call: a key
        // rotated/revoked by policy apply stops working here, not only on reconnect.
        contextProvider: providerFor(endpointName, handshake.token),
        auditLog,
        rateLimiter,
        clock,
      });
      log(
        `client connected: endpoint '${endpointName}' (${String(toolNames.length)} tool(s))`,
      );
      socket.once('close', () => {
        log(`client disconnected: endpoint '${endpointName}'`);
        bumpIdle(); // re-arm the idle countdown from the disconnect
        void server.close().catch(() => undefined);
      });
      await server.connect(new BoundedStreamServerTransport(socket, socket));
      // readHandshakeLine returned the stream paused (lossless across the
      // context-resolution gap above); the transport's 'data' listener is
      // attached now, so release the buffered MCP conversation in order.
      socket.resume();
      // Each inbound chunk (an MCP request) is activity for the idle auto-lock.
      socket.on('data', () => { bumpIdle(); });
      log(`transport attached: endpoint '${endpointName}' — stream resumed`);
    } catch (e) {
      refuse(socket, e instanceof Error ? e.message : 'endpoint start failed');
    }
  };

  const address = daemonAddress(options.sessionDir);
  const operatorSocketAddress = operatorAddress(options.sessionDir);
  if (isSocketFile(address)) {
    // The socket's PARENT dir perms ARE its access boundary — ensure it exists
    // 0700 before binding (covers both the in-session-dir socket and the
    // dedicated tmpdir-fallback subdir; never a bare 1777 tmpdir).
    await mkdir(dirname(address), { recursive: true, mode: 0o700 });
    // mkdir is a NO-OP on a pre-existing dir, so verify ownership/mode BEFORE
    // binding — refuse to serve into a dir another user could have squatted.
    const refusal = await socketDirRefusal(address);
    if (refusal !== null) {
      throw new Error(`refusing to bind local socket: ${refusal}`);
    }
  }
  const processLeaseResult = await acquireDaemonProcessLease(address);
  if (isErr(processLeaseResult)) {
    throw new Error(processLeaseResult.error);
  }
  const processLease = processLeaseResult.value;
  if (!processLease.acquired) {
    log('another Telegram MCP process owns the process lease; exiting');
    return;
  }
  if (processLease.recoveredDeadOwner && isSocketFile(address)) {
    for (const staleAddress of [address, operatorSocketAddress]) {
      const recovered = await recoverStaleDaemonSocket(
        staleAddress,
        processLease,
      );
      if (isErr(recovered)) {
        await processLease.release();
        throw new Error(recovered.error);
      }
      if (recovered.value) {
        log(`recovered ${staleAddress} from a crashed Telegram MCP process`);
      }
    }
  }
  const clientSockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    clientSockets.add(socket);
    socket.once('close', () => { clientSockets.delete(socket); });
    void onConnection(socket);
  });
  // Bound fd use: local shims are the only legitimate clients, so a small cap
  // (with the shortened pre-handshake window) keeps a connect-flood from
  // exhausting descriptors. Excess connections queue in the kernel backlog.
  server.maxConnections = MAX_CONNECTIONS;

  // Initialize shutdown before listen(): the server can accept immediately once
  // bound, including while chmod is pending.
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return; // a signal raced the idle timeout — one teardown only
    }
    // ORDER MATTERS. The process lease outlives Telegram ownership and the bound
    // socket. A replacement can recover a socket only after the lease owner PID
    // is dead, so it cannot connect this auth key while this drain is in flight.
    // `shuttingDown` also blocks in-process reacquisition synchronously.
    shuttingDown = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    operatorServer.close();
    operatorServer.closeConnections();
    log(`received ${signal}, shutting down`);
    contexts.retire();
    let exited = false;
    const finish = (code: number): void => {
      if (exited) return;
      exited = true;
      clearTimeout(watchdog);
      exit(code);
    };
    const watchdog = setTimeout(() => {
      log('TEARDOWN TIMED OUT — forcing process exit with ownership still locked');
      // Production process exit releases Telegram and both sockets together. Do
      // not release the lifetime lease first: that could admit a replacement
      // while an uncertain old connection still owns the auth key.
      finish(1);
    }, DEFAULT_SHUTDOWN_TIMEOUT_MS);
    watchdog.unref();
    void (async (): Promise<void> => {
      // Finish the mutation already admitted before draining Telegram ownership.
      // Queued operator work was refused synchronously by closeConnections().
      try {
        await operatorServer.drain();
        // Drain every Telegram teardown (contexts settle, then scoped clients,
        // then the shared client) — including earlier publication disposal.
        await contexts.barrier();
        await loginSessions.disposeAll();
        await accounts.retireAll();
        await auditLog.drain();
      } catch (error) {
        log(
          `TEARDOWN FAILED (${error instanceof Error ? error.message : 'unknown error'})`,
        );
        // Do not release the lifetime lease first. process.exit closes the uncertain
        // Telegram connection and listening socket as one OS-owned operation.
        finish(1);
        return;
      }
      try {
        for (const socket of clientSockets) socket.destroy();
        await new Promise<void>((resolvePromise) => {
          server.close(() => { resolvePromise(); });
        });
        await processLease.release();
      } catch (error) {
        log(
          `TEARDOWN FAILED (${error instanceof Error ? error.message : 'unknown error'})`,
        );
        finish(1);
        return;
      }
      finish(0);
    })();
  };

  let ownsSocket: boolean;
  try {
    ownsSocket = await new Promise<boolean>((resolvePromise, rejectPromise) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code !== 'EADDRINUSE') {
          rejectPromise(e);
          return;
        }
        const probe = netConnect(address);
        probe.once('connect', () => {
          probe.destroy();
          log('Telegram MCP is already running; exiting');
          resolvePromise(false);
        });
        probe.once('error', () => {
          rejectPromise(
            new Error(
              isSocketFile(address)
                ? `stale local socket at ${address}; verify Telegram MCP is not running, remove that socket, and retry`
                : 'local socket address is occupied but not accepting connections',
            ),
          );
        });
      });
      server.listen(address, () => {
        resolvePromise(true);
      });
    });
  } catch (error) {
    await processLease.release();
    throw error;
  }
  if (!ownsSocket) {
    await processLease.release();
    return;
  }
  if (isSocketFile(address)) {
    // Second permission layer INDEPENDENT of the process umask: the verified
    // 0700 parent dir is the primary boundary; 0600 on the socket inode itself
    // keeps a mis-permissioned dir from widening access. Failure is logged
    // loudly but non-fatal (the dir check above already gated binding).
    await chmod(address, 0o600).catch(() => {
      log('warning: could not chmod the local socket to 0600');
    });
  }
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => { rejectPromise(error); };
      operatorServer.once('error', onError);
      operatorServer.listen(operatorSocketAddress, () => {
        operatorServer.off('error', onError);
        resolvePromise();
      });
    });
  } catch (error) {
    shuttingDown = true;
    contexts.retire();
    await contexts.barrier().catch(() => undefined);
    await loginSessions.disposeAll();
    await accounts.retireAll().catch(() => undefined);
    operatorServer.closeConnections();
    if (operatorServer.listening) operatorServer.close();
    await new Promise<void>((resolvePromise) => {
      server.close(() => { resolvePromise(); });
    });
    await processLease.release();
    throw new Error(
      `could not bind operator socket: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  if (isSocketFile(operatorSocketAddress)) {
    await chmod(operatorSocketAddress, 0o600).catch(() => {
      log('warning: could not chmod the operator socket to 0600');
    });
  }
  operatorServer.on('error', (error) => {
    log(`operator socket error: ${error.message}`);
  });
  log(`listening on ${address}`);
  log(`operator control listening on ${operatorSocketAddress}`);

  // Idle auto-lock: after `idleMs` with no client activity, the daemon shuts down
  // (zeroizing the session), so the next connect respawns a locked-serving daemon.
  bumpIdle = (): void => {
    if (idleMs <= 0) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    const idleHours = Math.round((idleMs / 3_600_000) * 10) / 10;
    idleTimer = setTimeout(() => {
      log(
        `no client activity for ${String(idleHours)}h — auto-locking; ` +
          "run 'npx secure-telegram-mcp start' to unlock",
      );
      shutdown('idle-timeout');
    }, idleMs);
    idleTimer.unref();
  };

  process.once('SIGINT', () => { shutdown('SIGINT'); });
  process.once('SIGTERM', () => { shutdown('SIGTERM'); });
  bumpIdle(); // arm the idle countdown from boot
};

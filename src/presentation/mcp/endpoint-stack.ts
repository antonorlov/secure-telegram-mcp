/**
 * Endpoint stack builders — the daemon's one composition of an endpoint runtime:
 * one process owns all endpoints, with one GramJS session stack per sessionRef
 * shared across MCP connections. Telegram's auth key therefore has exactly one
 * owner process and connection.
 *
 * Layering: per-session pieces (gateway + folder resolver — the expensive, connection-
 * owning parts) vs per-endpoint pieces (resolved scope + scoped client) vs per-connection
 * pieces (MCP Server + HITL confirmer + use-cases). The daemon caches the first two and
 * mints the third per client connection.
 *
 * Fail-closed + secret-free errors throughout; GramJS never leaks above the
 * infrastructure adapters.
 */
import type {
  AppError,
  AuditLog,
  Clock,
  EndpointExecutionContext,
  KillSwitch,
  RateLimiter,
  ScopedClient,
  SessionMaterial,
} from '../../application/index.js';
import type { Result } from '../../shared/index.js';
import {
  DefaultAclEvaluator,
  type Endpoint,
  type PermissionVerb,
} from '../../domain/index.js';
import {
  DialogFilterFolderResolver,
  GramjsTelegramGateway,
  UnicodeSanitizer,
} from '../../infrastructure/index.js';
import { isErr } from '../../shared/index.js';
import { buildEndpointServer } from './server.js';
import { buildToolDefinitions } from './tools/index.js';
import { ElicitationConfirmer } from './elicitation-confirmer.js';

/** The api creds an endpoint runs with: sealed-in-session values + env override. */
export const resolveApiCreds = (
  material: SessionMaterial,
  overrides: { readonly apiId?: number; readonly apiHash?: string },
  endpointName: string,
): { readonly apiId: number; readonly apiHash: string } => {
  const apiId = overrides.apiId ?? material.apiId;
  const apiHash = overrides.apiHash ?? material.apiHash;
  if (!Number.isInteger(apiId) || apiId <= 0 || apiHash.length === 0) {
    throw new Error(
      `Telegram api credentials unavailable for endpoint '${endpointName}': ` +
        'the session carries none; set TELEGRAM_API_ID and TELEGRAM_API_HASH to override',
    );
  }
  return { apiId, apiHash };
};

/**
 * The per-session stack: the pieces that own the Telegram connection. Exactly one per
 * sessionRef must exist in a process (the daemon caches these).
 */
export interface SessionStack {
  readonly gateway: GramjsTelegramGateway;
  readonly folderResolver: DialogFilterFolderResolver;
}

/** A policy-derived scoped binding with explicit ownership. */
export interface EndpointRuntime {
  readonly context: EndpointExecutionContext;
  dispose(): Promise<void>;
}

export const createSessionStack = (input: {
  readonly apiId: number;
  readonly apiHash: string;
  readonly sessionSecret: string;
  readonly mediaRootDir: string;
  readonly clock: Clock;
  readonly log: (message: string) => void;
}): SessionStack => {
  const sanitizer = new UnicodeSanitizer();
  const gateway = new GramjsTelegramGateway({
    apiId: input.apiId,
    apiHash: input.apiHash,
    sessionSecret: input.sessionSecret,
    sanitizer,
    clock: input.clock,
    mediaRootDir: input.mediaRootDir,
    logger: input.log,
  });
  return {
    gateway,
    folderResolver: new DialogFilterFolderResolver(gateway),
  };
};

/**
 * The daemon-denied set every ACL evaluate() subtracts — the operator's runtime
 * kill-switch. (A build-time default-off verb list existed here while empty; it
 * returns the day a verb family actually ships fail-closed.)
 */
export const daemonDeniedVerbs = (
  killSwitch: KillSwitch,
): ReadonlySet<PermissionVerb> => new Set<PermissionVerb>(killSwitch.disabledVerbs);

/**
 * The per-endpoint context: declared scope resolved to the enforcement allow-list
 * (fail-closed) + the one guarded, scoped client.
 */
export const resolveEndpointRuntime = async (input: {
  readonly endpoint: Endpoint;
  readonly killSwitch: KillSwitch;
  readonly stack: SessionStack;
  readonly maxDownloadBytes?: number;
  readonly log: (message: string) => void;
}): Promise<EndpointRuntime> => {
  const accessRes = await input.stack.folderResolver.resolve({
    sessionRef: input.endpoint.sessionRef,
    scope: input.endpoint.scope,
    overrides: input.endpoint.overrides(),
  });
  if (isErr(accessRes)) {
    throw new Error(`failed to resolve scope: ${accessRes.error.message}`);
  }
  const { scope: resolvedScope, overrides } = accessRes.value;
  input.log(
    `resolved scope: ${String(resolvedScope.size)} peer(s), ` +
      `${String(overrides.size)} override(s)`,
  );

  // Bind the physically scope-bound client straight from the gateway. No application-layer
  // decorator wraps it: the per-chat verb+scope+kill ACL is the use-case engine's
  // resolve->ACL->audit path, and out-of-scope peers are physically unfetchable one layer
  // down. The registry's enumerator re-filter is the remaining defense-in-depth.
  const clientRes = await input.stack.gateway.bindScopedClient({
    endpoint: input.endpoint,
    resolvedScope,
    overrides,
    ...(input.maxDownloadBytes !== undefined
      ? { maxDownloadBytes: input.maxDownloadBytes }
      : {}),
  });
  if (isErr(clientRes)) {
    throw new Error(`failed to bind scoped client: ${clientRes.error.message}`);
  }
  const client: ScopedClient = clientRes.value;
  // The daemon-denied set (the operator kill switch) that every ACL
  // evaluate() subtracts, composed once here for the EndpointExecutionContext.
  const deniedVerbs = daemonDeniedVerbs(input.killSwitch);
  return {
    context: {
      endpoint: input.endpoint,
      resolvedScope,
      overrides,
      deniedVerbs,
      client,
    },
    dispose: (): Promise<void> => input.stack.gateway.releaseScopedClient(client),
  };
};

/**
 * The per-connection MCP server: use-cases + the static full tool surface + a fresh HITL
 * confirmer attached before the transport goes live (fail-closed). Cheap by design — the
 * daemon mints one per client connection.
 *
 * Static vs dynamic split: the tool menu is the full non-forbidden set for every endpoint
 * (PIN-free, verb/kill-switch-independent — this is why a locked daemon can still list
 * tools and why a live policy apply never needs a reconnect), while the dynamic execution
 * context (the shared gateway + per-chat effective verbs + denied set) is acquired lazily
 * per call via `contextProvider`, which fails closed with `SessionLocked` while locked. The
 * menu grants nothing: execution is the sole per-chat verb+scope+kill ACL.
 */
export const createConnectionServer = (input: {
  /** Lazy, per-call context (yields `err(SessionLocked)` while locked). */
  readonly contextProvider: () => Promise<
    Result<EndpointExecutionContext, AppError>
  >;
  readonly auditLog: AuditLog;
  readonly rateLimiter: RateLimiter;
  readonly clock: Clock;
}): { server: ReturnType<typeof buildEndpointServer>['server']; toolNames: readonly string[] } => {
  const aclEvaluator = new DefaultAclEvaluator();
  const confirmer = new ElicitationConfirmer();
  // One engine deps bundle; per-tool dep policy (search's read-side quota,
  // prepare_media skipping HITL/quota) lives in the application spec tables.
  const { server, toolNames } = buildEndpointServer({
    definitions: buildToolDefinitions({
      aclEvaluator,
      rateLimiter: input.rateLimiter,
      confirmer,
      auditLog: input.auditLog,
      clock: input.clock,
    }),
    contextProvider: input.contextProvider,
  });
  // HITL channel bound BEFORE the transport is live so no write can slip
  // through with an unattached confirmer (fail-closed).
  confirmer.attach(server);
  return { server, toolNames };
};

/**
 * The daemon's one composition of an endpoint runtime: a single process owns all endpoints,
 * with one GramJS session stack per sessionRef shared across MCP connections, so Telegram's
 * auth key has exactly one owner process.
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

// The pieces that own the Telegram connection. Exactly one per sessionRef may exist in a
// process, and the daemon caches them.
export interface SessionStack {
  readonly gateway: GramjsTelegramGateway;
  readonly folderResolver: DialogFilterFolderResolver;
}

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

// The daemon-denied set every ACL evaluate() subtracts — the operator's runtime kill-switch.
export const daemonDeniedVerbs = (
  killSwitch: KillSwitch,
): ReadonlySet<PermissionVerb> => new Set<PermissionVerb>(killSwitch.disabledVerbs);

// The declared scope resolved to the enforcement allow-list (fail-closed), plus the one
// guarded, scoped client.
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

  /**
   * Bind the physically scope-bound client straight from the gateway. No application-layer
   * decorator wraps it: the per-chat verb, scope and kill-switch ACL is the engine's resolve ->
   * ACL -> audit path, and out-of-scope peers are physically unfetchable one layer down.
   */
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
 * The per-connection MCP server: use-cases, the static full tool surface and a fresh HITL
 * confirmer attached before the transport goes live. Cheap by design — the daemon mints one per
 * client connection.
 */
export const createConnectionServer = (input: {
  // Lazy, per-call context (yields `err(SessionLocked)` while locked).
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

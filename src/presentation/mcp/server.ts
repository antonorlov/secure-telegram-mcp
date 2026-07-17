/**
 * MCP server spine — wires the @modelcontextprotocol/sdk stdio server for one endpoint. Each
 * endpoint is its own MCP surface, and the tools it lists are the static full non-forbidden
 * set (identical for every endpoint): the menu is discovery, not the ACL. Execution — the
 * per-chat verb+scope+kill check in the use-cases — is the sole gate.
 *
 * Pure composition: it owns no Telegram, session, or use-case knowledge. The composition
 * root (the daemon) supplies the resolved endpoint, the kill-switch (plumbing only — it is
 * enforced at execution, not filtered into the menu), the concrete tool definitions, and a
 * `contextProvider` that yields the per-invocation `EndpointExecutionContext` (endpoint +
 * resolved scope + denied set + scoped client). A raw `invoke` / scope-mutation tool can
 * never be exposed: only `ToolDefinition`s flow through the registry, which denylist-guards
 * forbidden names. Enumerator results are re-filtered through the resolved scope by the
 * registry (defense in depth).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  AppError,
  EndpointExecutionContext,
} from '../../application/index.js';
import type { Result } from '../../shared/index.js';
import { ToolRegistry, type AnyToolDefinition } from './registry.js';

export interface BuildEndpointServerInput {
  /** The concrete tool definitions (the static full non-forbidden menu). */
  readonly definitions: readonly AnyToolDefinition[];
  /**
   * Per-invocation execution context (scoped client + resolved scope), acquired lazily.
   * Async + Result: yields `err(SessionLocked)` while the shared session is locked so
   * registration stays PIN-free but every call fails closed.
   */
  readonly contextProvider: () => Promise<
    Result<EndpointExecutionContext, AppError>
  >;
}

export interface BuiltEndpointServer {
  readonly server: McpServer;
  /** The tool names exposed for this endpoint (the static full non-forbidden set). */
  readonly toolNames: readonly string[];
}

/**
 * Build (but do not connect) the MCP server for one endpoint, registering the static full
 * non-forbidden tool menu (execution is the sole ACL). Useful for tests and for callers that
 * own transport lifecycle.
 */
export const buildEndpointServer = (
  input: BuildEndpointServerInput,
): BuiltEndpointServer => {
  const server = new McpServer(
    { name: 'secure-telegram-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  const registry = new ToolRegistry();
  const toolNames = registry.registerFor({
    server,
    definitions: input.definitions,
    contextProvider: input.contextProvider,
  });
  return { server, toolNames };
};

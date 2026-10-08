/**
 * Wires the SDK stdio server for one endpoint. Each endpoint is its own MCP surface, and the
 * tools it lists are the static full non-forbidden set, identical for every endpoint: the menu
 * is discovery, not the ACL.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  AppError,
  EndpointExecutionContext,
} from '../../application/index.js';
import type { Result } from '../../shared/index.js';
import { ToolRegistry, type AnyToolDefinition } from './registry.js';

export interface BuildEndpointServerInput {
  readonly definitions: readonly AnyToolDefinition[];
  // Acquired lazily and Result-typed: it yields `err(SessionLocked)` while the shared session
  // is locked, so registration stays PIN-free but every call fails closed.
  readonly contextProvider: () => Promise<
    Result<EndpointExecutionContext, AppError>
  >;
}

export interface BuiltEndpointServer {
  readonly server: McpServer;
  readonly toolNames: readonly string[];
}

// Builds, but does not connect, the MCP server for one endpoint. Useful for tests and for
// callers that own the transport lifecycle.
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

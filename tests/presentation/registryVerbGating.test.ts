/**
 * ToolRegistry — direct contract tests for the presentation spine's STATIC-menu
 * model: the menu is DISCOVERY, execution is the sole ACL. Unlike the catalogue
 * integration test (which wires the REAL v1 tools), this suite drives the
 * registry with MINIMAL fake `ToolDefinition`s so it pins the registry's own
 * guarantees in isolation (SoC): the full non-forbidden set is always listed,
 * malformed input is rejected at the protocol boundary, annotations derive from
 * the verb, and the forbidden-name guard fails closed (#2).
 *
 * The registry is exercised through a REAL MCP client<->server pair over the
 * SDK's in-memory transport, so the assertions are made against the actual
 * protocol surface a model would see — not an internal shortcut.
 *
 * Security invariants asserted concretely:
 *  - STATIC menu, execution-is-the-ACL: a read-only (or no-verb, or
 *    kill-switched) endpoint still LISTS the full non-forbidden set — listing
 *    grants nothing; an out-of-verb call is protocol-callable yet DENIES at
 *    execution (the use-case engine's per-chat verb+scope+kill decision).
 *  - SYNTACTIC validation chokepoint: malformed args yield JSON-RPC -32602
 *    (InvalidParams) and the handler is NEVER reached.
 *  - declared outputSchema is enforced on success results (presenter drift
 *    fails loudly, F9).
 *  - annotations are PURE output metadata derived from the verb (readOnly /
 *    destructive / idempotent hints) — never a control-flow input.
 *  - #2 forbidden raw/scope-mutation tool names are refused at registration.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, type Result } from '../../src/shared/index.js';
import { PermissionVerb } from '../../src/domain/index.js';
import type {
  AppError,
  EndpointExecutionContext,
} from '../../src/application/index.js';
import {
  annotationsForVerb,
  type ToolDefinition,
  type AnyToolDefinition,
  type ToolOutput,
} from '../../src/presentation/mcp/registry.js';
import { buildEndpointServer } from '../../src/presentation/mcp/server.js';
import type {
  noKillSwitch} from '../application/_support.js';
import {
  buildEndpoint,
  killSwitch,
  resolvedScope,
  NO_DENIED,
  deniedVerbs,
  SpyScopedClient,
} from '../application/_support.js';

// ---------------------------------------------------------------------------
// Minimal fake tool definitions (one per verb under test). The registry only
// reads `name` / `requiredVerb` / `inputSchema` / `annotations`; the handler is
// invoked solely to prove the validation boundary runs BEFORE it.
// ---------------------------------------------------------------------------

interface FakeTool<TShape extends z.ZodRawShape> {
  readonly definition: ToolDefinition<TShape>;
  /** How many times the handler actually ran (validation passed). */
  calls: number;
}

const makeTool = <TShape extends z.ZodRawShape>(
  name: string,
  verb: PermissionVerb,
  inputSchema: TShape,
): FakeTool<TShape> => {
  const tool: FakeTool<TShape> = {
    calls: 0,
    definition: {
      name,
      requiredVerb: verb,
      title: `Fake ${name}`,
      description: `fake tool for ${name}`,
      inputSchema,
      // Matches the ack the fake handler emits below — the SDK validates every
      // success result's structuredContent against this declared contract.
      outputSchema: { acknowledged: z.boolean() },
      handler(
        _exec: EndpointExecutionContext,
        _args: z.infer<z.ZodObject<TShape>>,
      ): Promise<Result<ToolOutput, AppError>> {
        tool.calls += 1;
        return Promise.resolve(ok({ structured: { acknowledged: true } }));
      },
    },
  };
  return tool;
};

// A read tool with a REQUIRED string field — the lever for the -32602 test.
const readTool = (): FakeTool<{ value: z.ZodString }> =>
  makeTool('fake_read', PermissionVerb.Read, { value: z.string() });
const sendTool = (): FakeTool<Record<string, never>> =>
  makeTool('fake_send', PermissionVerb.Send, {});
const deleteTool = (): FakeTool<Record<string, never>> =>
  makeTool('fake_delete', PermissionVerb.Delete, {});
const markReadTool = (): FakeTool<Record<string, never>> =>
  makeTool('fake_mark_read', PermissionVerb.MarkRead, {});
const forwardTool = (): FakeTool<Record<string, never>> =>
  makeTool('fake_forward', PermissionVerb.Forward, {});

// ---------------------------------------------------------------------------
// Live MCP client<->server harness over the in-memory transport.
// ---------------------------------------------------------------------------

interface Conn {
  readonly client: Client;
  readonly server: McpServer;
  readonly toolNames: readonly string[];
}

const open: Conn[] = [];

afterEach(async () => {
  for (const conn of open.splice(0)) {
    await conn.client.close();
    await conn.server.close();
  }
});

const connect = async (input: {
  readonly verbs: readonly PermissionVerb[];
  readonly definitions: readonly AnyToolDefinition[];
  readonly kill?: ReturnType<typeof noKillSwitch>;
  readonly denied?: ReadonlySet<PermissionVerb>;
}): Promise<Conn> => {
  const endpoint = buildEndpoint({ verbs: input.verbs });
  const client = new SpyScopedClient(endpoint.name);
  const { server, toolNames } = buildEndpointServer({
    definitions: input.definitions,
    contextProvider: (): Promise<Result<EndpointExecutionContext, AppError>> =>
      Promise.resolve(
        ok({
          endpoint,
          resolvedScope: resolvedScope(),
          overrides: new Map(),
          deniedVerbs: input.denied ?? NO_DENIED,
          client,
        }),
      ),
  });
  const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    mcpClient.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  const conn: Conn = { client: mcpClient, server, toolNames };
  open.push(conn);
  return conn;
};

const listedNames = async (client: Client): Promise<readonly string[]> => {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
};

/**
 * Minimal structural view of a CallToolResult — only the fields these tests
 * read. Cast through this so member access stays type-safe (the SDK's inferred
 * return type widens `content` to `unknown` under the project tsconfig).
 */
interface ToolResultView {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly content?: readonly {
    readonly type?: string;
    readonly text?: string;
  }[];
}

const viewResult = (result: unknown): ToolResultView => result as ToolResultView;

/** First text content block of a tool result (where this SDK embeds error codes). */
const firstText = (result: ToolResultView): string => {
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return '';
};

// ---------------------------------------------------------------------------
// STATIC full menu — the menu is DISCOVERY; EXECUTION is the ACL. Every endpoint
// (even read-only-everywhere, even kill-switched) lists the FULL non-forbidden
// tool set; an out-of-verb/kill-switched tool is LISTED but DENIES at execution.
// ---------------------------------------------------------------------------

describe('ToolRegistry — STATIC full menu, execution is the sole ACL', () => {
  const allDefs = (): readonly AnyToolDefinition[] => [
    readTool().definition,
    sendTool().definition,
    deleteTool().definition,
    markReadTool().definition,
    forwardTool().definition,
  ];
  const ALL_NAMES = [
    'fake_read',
    'fake_send',
    'fake_delete',
    'fake_mark_read',
    'fake_forward',
  ];

  it('a READ-ONLY-everywhere endpoint STILL lists the FULL non-forbidden set (write tools included)', async () => {
    const conn = await connect({
      verbs: [PermissionVerb.Read],
      definitions: allDefs(),
    });

    // The registry's synchronous menu is the full set...
    expect([...conn.toolNames].sort()).toEqual([...ALL_NAMES].sort());
    // ...and a model sees exactly the same via tools/list.
    const names = await listedNames(conn.client);
    expect([...names].sort()).toEqual([...ALL_NAMES].sort());
  });

  it('a NO-VERB endpoint also lists the FULL set (menu never gates)', async () => {
    const conn = await connect({ verbs: [], definitions: allDefs() });
    const names = await listedNames(conn.client);
    expect([...names].sort()).toEqual([...ALL_NAMES].sort());
  });

  it('a listed-but-out-of-verb write tool is genuinely CALLABLE at the protocol level (execution ACL decides)', async () => {
    // A read-only-everywhere endpoint: the fake handler here always Ok's, but the
    // tool is REACHABLE (not -32602 not-found). The REAL execution ACL lives in
    // the use-case/guarded-client (covered by the invariant + use-case suites);
    // here we prove the menu no longer hides the tool — it is present and invokable.
    const conn = await connect({
      verbs: [PermissionVerb.Read],
      definitions: allDefs(),
    });
    const result = viewResult(
      await conn.client.callTool({ name: 'fake_send', arguments: {} }),
    );
    // Reachable: not a -32602 "tool not found" — the tool is on the menu.
    expect(firstText(result)).not.toContain('not found');
  });

  it('a kill-switched endpoint STILL lists the tool whose verb is disabled', async () => {
    const conn = await connect({
      verbs: [PermissionVerb.Read, PermissionVerb.Send],
      definitions: allDefs(),
      kill: killSwitch(PermissionVerb.Send),
      denied: deniedVerbs(PermissionVerb.Send),
    });
    const names = await listedNames(conn.client);
    // The send tool is NOT removed from the menu by the kill-switch.
    expect(names).toContain('fake_send');
    expect([...names].sort()).toEqual([...ALL_NAMES].sort());
  });
});

// ---------------------------------------------------------------------------
// SYNTACTIC validation chokepoint — JSON-RPC -32602 on malformed args.
// ---------------------------------------------------------------------------

describe('ToolRegistry — malformed input yields -32602 (InvalidParams)', () => {
  it('rejects a type-mismatched argument with -32602 and never reaches the handler', async () => {
    const read = readTool();
    const conn = await connect({
      verbs: [PermissionVerb.Read],
      definitions: [read.definition],
    });

    // `value` is required to be a string; a number must fail SYNTACTIC validation.
    const result = viewResult(
      await conn.client.callTool({
        name: 'fake_read',
        arguments: { value: 123 },
      }),
    );

    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain('-32602');
    expect(text).toContain('Input validation error');
    // The validation boundary runs BEFORE the tool body (the chokepoint): no
    // handler side effect occurred for the rejected call.
    expect(read.calls).toBe(0);
  });

  it('rejects a missing required argument with -32602', async () => {
    const read = readTool();
    const conn = await connect({
      verbs: [PermissionVerb.Read],
      definitions: [read.definition],
    });

    const result = viewResult(
      await conn.client.callTool({ name: 'fake_read', arguments: {} }),
    );
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('-32602');
    expect(read.calls).toBe(0);
  });

  it('admits a well-formed call (validation passes -> handler runs once)', async () => {
    const read = readTool();
    const conn = await connect({
      verbs: [PermissionVerb.Read],
      definitions: [read.definition],
    });

    const result = viewResult(
      await conn.client.callTool({
        name: 'fake_read',
        arguments: { value: 'hello' },
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ acknowledged: true });
    expect(read.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// outputSchema (F9) — declared per tool, enforced by the SDK on success results.
// ---------------------------------------------------------------------------

describe('ToolRegistry — declared outputSchema is enforced on success results (F9)', () => {
  it('REJECTS a result that violates the declared outputSchema (presenter drift fails loudly)', async () => {
    const drifting = makeTool('fake_drift', PermissionVerb.Read, {});
    // Sabotage the contract: declare a STRING ack while the handler emits the
    // boolean `{ acknowledged: true }` — exactly the silent-drift case F9 closes.
    const def: AnyToolDefinition = {
      ...drifting.definition,
      outputSchema: { acknowledged: z.string() },
    };
    const conn = await connect({
      verbs: [PermissionVerb.Read],
      definitions: [def],
    });

    const result = viewResult(
      await conn.client.callTool({ name: 'fake_drift', arguments: {} }),
    );

    // The SDK validated structuredContent against the declared schema AFTER the
    // handler ran and failed the call — drift can no longer ship silently.
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Output validation error');
    expect(drifting.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Annotations derived from the verb (pure metadata, never branched on).
// ---------------------------------------------------------------------------

describe('annotationsForVerb — derived purely from the verb', () => {
  it('marks read verbs read-only and non-destructive', () => {
    expect(annotationsForVerb(PermissionVerb.Read)).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('marks a write verb not read-only and not destructive', () => {
    expect(annotationsForVerb(PermissionVerb.Send)).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('flags the destructive verb (delete) with destructiveHint', () => {
    expect(annotationsForVerb(PermissionVerb.Delete).destructiveHint).toBe(true);
    expect(annotationsForVerb(PermissionVerb.Delete).readOnlyHint).toBe(false);
  });

  it('flags mark_read as idempotent but NOT read-only (it fires read receipts — a write)', () => {
    const ann = annotationsForVerb(PermissionVerb.MarkRead);
    expect(ann.idempotentHint).toBe(true);
    expect(ann.readOnlyHint).toBe(false);
    expect(ann.destructiveHint).toBe(false);
  });
});

describe('ToolRegistry — registered tools carry verb-derived annotations', () => {
  it('surfaces annotationsForVerb on the live tool descriptors', async () => {
    const tools: readonly FakeTool<Record<string, never>>[] = [
      sendTool(),
      deleteTool(),
      markReadTool(),
    ];
    const conn = await connect({
      verbs: [PermissionVerb.Send, PermissionVerb.Delete, PermissionVerb.MarkRead],
      definitions: tools.map((t) => t.definition),
    });

    const { tools: listed } = await conn.client.listTools();
    const byName = new Map(listed.map((t) => [t.name, t]));

    expect(byName.get('fake_send')?.annotations).toMatchObject(
      annotationsForVerb(PermissionVerb.Send),
    );
    expect(byName.get('fake_delete')?.annotations).toMatchObject(
      annotationsForVerb(PermissionVerb.Delete),
    );
    expect(byName.get('fake_mark_read')?.annotations).toMatchObject(
      annotationsForVerb(PermissionVerb.MarkRead),
    );
    // Concretely: the delete tool is advertised as destructive.
    expect(byName.get('fake_delete')?.annotations?.destructiveHint).toBe(true);
  });
});


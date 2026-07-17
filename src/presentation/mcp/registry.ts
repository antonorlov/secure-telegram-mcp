/**
 * Static full-menu tool registry — the menu is discovery; execution is the ACL.
 *
 * The registry registers every non-forbidden `ToolDefinition` on the endpoint's MCP
 * server, regardless of the endpoint's verbs or the kill-switch: the menu is static
 * and identical for every endpoint. This is deliberate — an endpoint's verbs/scope
 * can change on the fly via live policy application, so a static menu means any change
 * (widen or narrow, per-chat) takes effect at the next tool call with no reconnect.
 * The per-chat verb+scope+kill check inside every use-case is the sole, fail-closed
 * ACL; exposing a tool grants nothing — every call re-checks the target chat's
 * effective verbs (override > group ∩ ¬kill) + scope.
 *
 * The one thing the menu still enforces: forbidden raw/scope-mutation tool names are
 * never registered (`assertSafeName`).
 *
 * Generic-to-all-tools concerns owned here:
 *  - syntactic input validation -> JSON-RPC -32602 (delegated to the SDK, which
 *    validates the `inputSchema`);
 *  - declaring each `outputSchema` to the SDK, which advertises it over tools/list
 *    and validates every success result's `structuredContent` against it. `isError`
 *    results are exempt from that validation by the SDK, so the error envelope stays
 *    contract-valid without being part of any tool's declared output;
 *  - mapping a handler `Result<ToolOutput, AppError>` to a `CallToolResult`;
 *  - enumerator scope re-filter: any enumerated peer outside the resolved scope fails
 *    the call closed (defense in depth over the scoped client);
 *  - output size caps before content can enter model context;
 *  - a runtime denylist refusing forbidden tool names, matching the CI guard.
 *
 * Tool-specific behaviour (calling the ScopedClient, running the use-case, wrapping
 * untrusted text under named keys) lives in each definition's `handler`, not here.
 *
 * MCP tool annotations (readOnly/destructive hints) are computed purely from the verb
 * and are output metadata only: no control-flow branches on them.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ToolAnnotations,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import {
  PermissionVerb,
  isReadVerb,
  type ChatId,
} from '../../domain/index.js';
import {
  appError,
  AppErrorCode,
  type AppError,
  type EndpointExecutionContext,
} from '../../application/index.js';
import {
  type Result,
  isOk,
  checkByteCap,
  DEFAULT_MAX_OUTPUT_BYTES,
} from '../../shared/index.js';

// ToolDefinition contract (the surface tool modules implement against)

/** Structured tool result body: untrusted text already wrapped under named keys. */
export type ToolStructuredContent = Readonly<Record<string, unknown>>;

/**
 * A handler's success payload. `structured` is emitted as the MCP structuredContent.
 * `enumeratedPeers` is supplied by enumerator tools only (list_dialogs, search): the
 * canonical peers referenced by the result, so the registry can re-verify every one
 * is in scope.
 */
export interface ToolOutput {
  readonly structured: ToolStructuredContent;
  readonly enumeratedPeers?: readonly ChatId[];
}

/**
 * The EXACT contract for a single MCP tool.
 *
 * @typeParam TShape - the per-field Zod input shape (passed verbatim to the SDK,
 *   which validates it and yields JSON-RPC -32602 on malformed args).
 */
export interface ToolDefinition<TShape extends z.ZodRawShape> {
  /** Stable tool name (must not be a forbidden raw/scope-mutation name). */
  readonly name: string;
  /** The single verb this tool requires. */
  readonly requiredVerb: PermissionVerb;
  /** Human-facing title (annotation metadata). */
  readonly title: string;
  /** Human-facing description. */
  readonly description: string;
  /** Per-field Zod shape; compose from `./schemas/primitives.js`. */
  readonly inputSchema: TShape;
  /**
   * Per-field Zod shape of the success `structuredContent`; compose from
   * `./schemas/outputs.js`. Advertised to clients and validated by the SDK against
   * every non-error result, so it must be exactly faithful to what the presenter
   * emits (never stricter than reality). The AppError / byte-cap `isError` envelope
   * is deliberately not part of this shape — the SDK skips output validation for
   * error results.
   */
  readonly outputSchema: z.ZodRawShape;
  /**
   * The tool body: receives the full per-invocation `EndpointExecutionContext` (the
   * scoped client is `exec.client`) and the already-validated args. Returns a
   * `Result` — expected failures (ACL/quota/flood/not-found/...) travel as
   * `AppError`, never thrown.
   *
   * Declared in method syntax — not as a function-typed property — on purpose:
   * TypeScript compares method parameters bivariantly (function-property parameters
   * are contravariant under `strictFunctionTypes`). Bivariance is what lets a
   * precisely-typed `ToolDefinition<SomeShape>` be assigned into a
   * `readonly AnyToolDefinition[]` without an unsafe cast. Sound because the registry
   * validates `args` against `inputSchema` before the handler is ever invoked.
   */
  handler(
    exec: EndpointExecutionContext,
    args: z.infer<z.ZodObject<TShape>>,
  ): Promise<Result<ToolOutput, AppError>>;
}

/** Existential form for heterogeneous collections held by the registry. */
export type AnyToolDefinition = ToolDefinition<z.ZodRawShape>;

// Annotations derived from the verb (output metadata only — never branched on)

/** Verbs whose effect is irreversible/destructive (delete, ban). */
const isDestructiveVerb = (verb: PermissionVerb): boolean =>
  verb === PermissionVerb.Delete;

/** Compute MCP tool annotations from the verb. Pure; advisory metadata, never used for authorization. */
export const annotationsForVerb = (verb: PermissionVerb): ToolAnnotations => {
  const readOnly = isReadVerb(verb);
  return {
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : isDestructiveVerb(verb),
    idempotentHint: verb === PermissionVerb.MarkRead,
    openWorldHint: true,
  };
};

// Registry

/**
 * Degrade an over-cap page result to a partial page instead of failing the whole
 * call: a page of max-length messages at the default limit can exceed the byte cap on
 * every attempt, making that chat permanently unreadable. Finds the single top-level
 * array (every paged presenter emits exactly one), drops trailing items until the
 * serialization fits, marks `truncated: true`, and removes `next_cursor` — the full
 * page's cursor would silently skip the dropped tail, so the caller re-queries with a
 * smaller limit. Returns undefined when the shape is not a page or even an empty page
 * cannot fit — the caller then fails closed with the original cap error.
 */
export const degradeToPartialPage = (
  structured: ToolStructuredContent,
  maxBytes: number,
): { readonly structured: ToolStructuredContent; readonly json: string } | undefined => {
  const arrayFields = Object.entries(structured).filter(
    (entry): entry is [string, readonly unknown[]] => Array.isArray(entry[1]),
  );
  const page = arrayFields.length === 1 ? arrayFields[0] : undefined;
  if (page === undefined || page[1].length === 0) {
    return undefined;
  }
  const [field, items] = page;
  const rest: Record<string, unknown> = { ...structured };
  // Every paged tool emits its cursor as snake_case `next_cursor` (schemas/outputs.ts).
  delete rest['next_cursor'];
  const candidateFor = (keep: number): {
    readonly structured: Record<string, unknown>;
    readonly json: string;
  } => {
    const candidate: Record<string, unknown> = {
      ...rest,
      [field]: items.slice(0, keep),
      truncated: true,
    };
    if (typeof rest['count'] === 'number') {
      // Keep a page-size counter honest (search_messages declares one).
      candidate['count'] = keep;
    }
    const json = JSON.stringify(candidate);
    return { structured: candidate, json };
  };

  let low = 0;
  let high = items.length - 1;
  let best: ReturnType<typeof candidateFor> | undefined;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = candidateFor(keep);
    if (checkByteCap(candidate.json, maxBytes).withinCap) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return best;
};

/**
 * Names a model-facing tool may never carry: no raw MTProto passthrough, no
 * scope-mutation. Mirrors the CI architecture guard so a mistake fails closed at
 * registration time, not just in CI.
 */
const FORBIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'invoke',
  'raw',
  'set_scope',
  'grant',
  'revoke',
  'add_chat',
  'remove_chat',
  'set_permissions',
]);

export interface RegisterInput {
  readonly server: McpServer;
  readonly definitions: readonly AnyToolDefinition[];
  /**
   * Supplies the per-invocation execution context bound to this endpoint — async +
   * Result so the gateway can be acquired lazily and, when the shared session is
   * locked, fail closed with `AppErrorCode.SessionLocked` before the handler (hence
   * the gateway) is ever reached. A locked call returns an isError result and never
   * touches Telegram.
   */
  readonly contextProvider: () => Promise<
    Result<EndpointExecutionContext, AppError>
  >;
}

/**
 * Registers the static full menu on an endpoint's MCP server. It does not verb-gate
 * the menu (every non-forbidden tool is listed for every endpoint — execution is the
 * sole ACL); it owns the generic concerns: forbidden-name refusal, the enumerator
 * scope re-filter, and the output byte cap.
 */
export class ToolRegistry {
  /**
   * Register the static full menu: every non-forbidden definition, regardless of the
   * endpoint's verbs or the kill-switch (execution is the sole ACL). The one
   * fail-closed guard here is `assertSafeName` — a forbidden raw/scope-mutation name
   * is never wired.
   */
  public registerFor(input: RegisterInput): readonly string[] {
    const registered: string[] = [];
    for (const def of input.definitions) {
      this.assertSafeName(def.name);
      this.wire(input, def);
      registered.push(def.name);
    }
    return Object.freeze(registered);
  }

  /** Fail-closed on any forbidden tool name, regardless of verb. */
  private assertSafeName(name: string): void {
    if (FORBIDDEN_TOOL_NAMES.has(name)) {
      throw new Error(
        `refusing to register forbidden tool name '${name}' (raw/scope-mutation tools are never model-reachable)`,
      );
    }
  }

  private wire(input: RegisterInput, def: AnyToolDefinition): void {
    input.server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        outputSchema: def.outputSchema,
        annotations: annotationsForVerb(def.requiredVerb),
      },
      // The SDK has already validated `args` against `inputSchema` (a failure
      // here would have produced JSON-RPC -32602 before we are called).
      (args): Promise<CallToolResult> =>
        this.invoke(input, def, args as z.infer<z.ZodObject<z.ZodRawShape>>),
    );
  }

  private async invoke(
    input: RegisterInput,
    def: AnyToolDefinition,
    args: z.infer<z.ZodObject<z.ZodRawShape>>,
  ): Promise<CallToolResult> {
    // Acquire the context lazily. Fail-closed chokepoint: when the shared session is
    // locked (or the enforced endpoint is absent / the gateway cannot be bound) this
    // returns an error before `def.handler` runs — so no sessions.load, no gateway
    // round-trip, no enumerator re-filter, no byte cap, and no data reach the model.
    const provided = await input.contextProvider();
    if (!isOk(provided)) {
      return this.errorResult(provided.error);
    }
    const exec = provided.value;
    const result = await def.handler(exec, args);
    if (!isOk(result)) {
      return this.errorResult(result.error);
    }
    const output = result.value;

    // Defense in depth: an enumerator must not leak an out-of-scope peer.
    if (output.enumeratedPeers !== undefined) {
      const leaked = output.enumeratedPeers.some(
        (peer) => !exec.resolvedScope.contains(peer),
      );
      if (leaked) {
        return this.errorResult(
          appError(
            AppErrorCode.AclDenied,
            'enumerated result contained a peer outside the resolved scope',
          ),
        );
      }
    }

    // Output size cap: bound what can enter the model context. Measured in UTF-8
    // bytes (not UTF-16 code units). A page-shaped result over the cap degrades to a
    // partial page (truncated: true, no next_cursor) instead of failing — otherwise a
    // chat of max-length messages would be unreadable at the default limit.
    const json = JSON.stringify(output.structured);
    const cap = checkByteCap(json, DEFAULT_MAX_OUTPUT_BYTES);
    if (!cap.withinCap) {
      const partial = degradeToPartialPage(output.structured, DEFAULT_MAX_OUTPUT_BYTES);
      if (partial === undefined) {
        return this.errorResult(
          appError(
            AppErrorCode.SizeCapExceeded,
            `tool output ${String(cap.byteLength)} bytes exceeded the ${String(DEFAULT_MAX_OUTPUT_BYTES)}-byte cap`,
          ),
        );
      }
      return {
        content: [{ type: 'text', text: partial.json }],
        structuredContent: partial.structured,
        isError: false,
      };
    }

    return {
      content: [{ type: 'text', text: json }],
      structuredContent: output.structured,
      isError: false,
    };
  }

  /** Map an AppError to an isError tool result (NOT a protocol error). */
  private errorResult(error: AppError): CallToolResult {
    const payload = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
    };
  }
}

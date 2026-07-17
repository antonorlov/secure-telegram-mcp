/**
 * `defineTool` — the one place the per-tool ceremony lives. A tool module declares only its
 * unique content as a spec; this helper wraps it into the `ToolDefinition` the registry
 * consumes, hosting the shared handler pipeline:
 *
 *   optional cross-field `validate` -> `useCase.execute(exec, args)`
 *   -> error passthrough -> `present(dto)`.
 *
 * Handlers receive the full `EndpointExecutionContext` (the scoped client is `exec.client`).
 * Expected failures travel as `AppError` (never thrown); the registry maps them to an
 * `isError` result.
 */
import type { z } from 'zod';
import { err, isErr, ok, type Result } from '../../../shared/index.js';
import { ChatId } from '../../../domain/index.js';
import {
  appError,
  AppErrorCode,
  type AppError,
  type EndpointExecutionContext,
  type UseCase,
} from '../../../application/index.js';
import type { ToolDefinition, ToolOutput } from '../registry.js';

/**
 * Shape a use-case result DTO into the tool's structured output. Receives the DTO plus the
 * invocation `exec`/`args` so an enumerator can compute its `enumeratedPeers` (and a tool
 * like list_topics can resolve its parent peer). Returns a `Result` — a presenter may fail
 * closed (e.g. an unparseable id).
 */
export type ToolPresenter<TArgs, TDto> = (
  dto: TDto,
  ctx: { readonly exec: EndpointExecutionContext; readonly args: TArgs },
) => Result<ToolOutput, AppError> | Promise<Result<ToolOutput, AppError>>;

/** The unique content of one tool; everything generic is the shared pipeline. */
export interface ToolSpec<TShape extends z.ZodRawShape, TDto> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputShape: TShape;
  readonly outputShape: z.ZodRawShape;
  /**
   * The injected use-case abstraction — the only path to Telegram. `execute` is
   * declared in method syntax (bivariant params), so a use-case typed against its
   * own command DTO — structurally identical to the validated args — assigns here
   * without a cast.
   */
  readonly useCase: UseCase<z.infer<z.ZodObject<TShape>>, TDto>;
  /** Shape the success DTO into structured output (+ any enumerated peers). */
  readonly present: ToolPresenter<z.infer<z.ZodObject<TShape>>, TDto>;
  /**
   * Optional cross-field precondition the Zod raw shape cannot express (e.g. "topicId
   * requires peer"). Returns an `AppError` to fail fast before the use-case runs, or
   * `undefined` to proceed.
   */
  readonly validate?: (args: z.infer<z.ZodObject<TShape>>) => AppError | undefined;
}

export const defineTool = <TShape extends z.ZodRawShape, TDto>(
  spec: ToolSpec<TShape, TDto>,
): ToolDefinition<TShape> => ({
  name: spec.name,
  // The verb lives on the use-case (the registry gate key) — declared ONCE there,
  // never repeated on the tool spec, so the two can't drift.
  requiredVerb: spec.useCase.verb,
  title: spec.title,
  description: spec.description,
  inputSchema: spec.inputShape,
  outputSchema: spec.outputShape,
  // Method syntax (bivariant params) so a precise `ToolDefinition<TShape>` widens into
  // `AnyToolDefinition[]` without a cast; the registry validates args against `inputSchema`
  // (JSON-RPC -32602) before this ever runs.
  async handler(exec, args): Promise<Result<ToolOutput, AppError>> {
    const invalid = spec.validate?.(args);
    if (invalid !== undefined) {
      return err(invalid);
    }
    const result = await spec.useCase.execute(exec, args);
    if (isErr(result)) {
      return result;
    }
    return spec.present(result.value, { exec, args });
  },
});

/**
 * Collect the distinct canonical peers a multi-peer result references so the registry can
 * re-verify each is in scope (defense in depth). Fails closed if any id from the data layer
 * cannot be parsed into a `ChatId`: an un-checkable peer must never reach the model.
 */
export const collectEnumeratedPeers = <T>(
  items: readonly T[],
  chatIdOf: (item: T) => string,
): Result<readonly ChatId[], AppError> => {
  const seen = new Map<string, ChatId>();
  for (const item of items) {
    const key = chatIdOf(item);
    if (seen.has(key)) {
      continue;
    }
    const parsed = ChatId.fromString(key);
    if (isErr(parsed)) {
      return err(
        appError(
          AppErrorCode.GatewayUnavailable,
          'result carried an unparseable chat id; failing closed',
          { cause: parsed.error },
        ),
      );
    }
    seen.set(key, parsed.value);
  }
  return ok(Object.freeze([...seen.values()]));
};

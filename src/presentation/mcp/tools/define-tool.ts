/**
 * The one place the per-tool ceremony lives: a tool module declares only its unique content as
 * a spec, and this helper wraps it into the `ToolDefinition` the registry consumes, hosting the
 * shared handler pipeline.
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

// Receives the DTO plus the invocation context and args, so an enumerator can compute its
// `enumeratedPeers` and a tool like list_topics can resolve its parent peer.
export type ToolPresenter<TArgs, TDto> = (
  dto: TDto,
  ctx: { readonly exec: EndpointExecutionContext; readonly args: TArgs },
) => Result<ToolOutput, AppError> | Promise<Result<ToolOutput, AppError>>;

export interface ToolSpec<TShape extends z.ZodRawShape, TDto> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputShape: TShape;
  readonly outputShape: z.ZodRawShape;
  /**
   * The only path to Telegram. `execute` is declared in method syntax (bivariant params), so a
   * use-case typed against its own command DTO — structurally identical to the validated args —
   * assigns here without a cast.
   */
  readonly useCase: UseCase<z.infer<z.ZodObject<TShape>>, TDto>;
  readonly present: ToolPresenter<z.infer<z.ZodObject<TShape>>, TDto>;
  // A cross-field precondition the Zod shape cannot express, such as "topicId requires peer".
  // Return an `AppError` to fail fast before the use-case runs.
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
  /**
   * Method syntax (bivariant params) so a precise `ToolDefinition<TShape>` widens into
   * `AnyToolDefinition[]` without a cast. The registry validates args against `inputSchema`
   * before this ever runs.
   */
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
 * Collects the distinct canonical peers a multi-peer result references, so the registry can
 * re-verify each is in scope. Fails closed when an id from the data layer cannot be parsed into
 * a `ChatId`: an un-checkable peer must never reach the model.
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

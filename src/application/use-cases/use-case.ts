/**
 * UseCase — the common application contract. Every use-case is a single
 * `execute(ctx, input)` returning `Result<Output, AppError>`. The verb a
 * use-case exercises is fixed and exposed as `verb` — the single source the tool
 * spec derives its required verb from, and the key execution checks per call.
 */
import type { Result } from '../../shared/index.js';
import type { PermissionVerb } from '../../domain/index.js';
import type { AppError } from '../errors.js';
import type { EndpointExecutionContext } from './context.js';

export interface UseCase<TInput, TOutput> {
  /** The single verb this use-case requires (checked per call at execution). */
  readonly verb: PermissionVerb;
  execute(
    ctx: EndpointExecutionContext,
    input: TInput,
  ): Promise<Result<TOutput, AppError>>;
}

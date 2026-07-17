/**
 * Confirmer — Human-In-The-Loop confirmation port. Write use-cases consult it
 * when the endpoint requires confirmation for the verb (`confirmWrites`). The
 * description is STRUCTURED (never raw untrusted prose) so a confirmation prompt
 * can't be hijacked by injected content.
 */
import type { Result } from '../../shared/index.js';
import type {
  EndpointNameValue,
  PermissionVerb,
} from '../../domain/index.js';
import type { AppError } from '../errors.js';

export interface ConfirmationRequest {
  readonly endpointName: EndpointNameValue;
  readonly verb: PermissionVerb;
  readonly targetChatId?: string;
  /** Short, operator-facing description of the side effect. No untrusted prose. */
  readonly description: string;
}

export interface Confirmer {
  /** Ok(true) => approved; Ok(false) => declined; Err => could not ask. */
  requestConfirmation(
    request: ConfirmationRequest,
  ): Promise<Result<boolean, AppError>>;
}

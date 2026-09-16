// Human-in-the-loop confirmation. The description is structured, never raw untrusted prose, so
// a prompt cannot be hijacked by injected content.
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
  readonly description: string;
}

export interface Confirmer {
  // Ok(true) approved; Ok(false) declined; Err could not ask.
  requestConfirmation(
    request: ConfirmationRequest,
  ): Promise<Result<boolean, AppError>>;
}

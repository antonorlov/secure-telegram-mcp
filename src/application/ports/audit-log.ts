// Append-only record of write attempts, in-engine denials and successful media egress. Records
// must never carry secrets or raw untrusted prose.
import type { Result } from '../../shared/index.js';
import type {
  EndpointNameValue,
  PermissionVerb,
} from '../../domain/index.js';
import type { AppError } from '../errors.js';

export interface AuditRecord {
  readonly timestampIso: string;
  readonly endpointName: EndpointNameValue;
  readonly verb: PermissionVerb;
  readonly targetChatId?: string;
  readonly outcome: 'allow' | 'deny';
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

export interface AuditLog {
  append(record: AuditRecord): Promise<Result<void, AppError>>;
}

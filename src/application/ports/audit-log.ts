/**
 * AuditLog — append-only record of write-tier attempts, in-engine read
 * resolve/ACL/quota denials, and successful media egress. Records are structured
 * and MUST NOT contain secrets or raw untrusted prose.
 */
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
  /** Canonical target peer id (string), when the action addressed a peer. */
  readonly targetChatId?: string;
  /** 'allow' for executed actions; 'deny' with a reason for refused ones. */
  readonly outcome: 'allow' | 'deny';
  readonly reason?: string;
  /** Idempotency key of a write, for correlation. */
  readonly idempotencyKey?: string;
}

export interface AuditLog {
  append(record: AuditRecord): Promise<Result<void, AppError>>;
}

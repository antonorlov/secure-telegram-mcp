/**
 * FileAuditLog — append-only audit sink for write-tier attempts, in-engine read
 * resolve/ACL/quota denials, and successful media egress.
 * Infrastructure adapter for the application `AuditLog` port.
 *
 *  - APPEND-ONLY: every record is one NDJSON entry written with the `'a'` open
 *    flag. This adapter never truncates history; owner-level tampering remains
 *    outside its threat boundary.
 *  - WHO / WHAT / WHEN / RESULT: each line carries endpointName (who), verb +
 *    optional target/idempotencyKey (what), timestampIso (when) and outcome +
 *    optional reason (result) — the `AuditRecord` contract.
 *  - NO SECRETS, NO RAW UNTRUSTED PROSE: the `AuditRecord` DTO is structured
 *    metadata only — no message bodies, session material or credentials. The
 *    free-text `reason` field is length-capped before serialization as
 *    defense-in-depth against accidental content dumping / log flooding.
 *  - 0600 AT REST: on POSIX the log is created or tightened to owner-read/write.
 *    Newly created parent directories request 0700; permissions on an existing
 *    operator-selected parent remain the operator's responsibility.
 *  - ENCAPSULATION: `node:fs` stays inside this file; only immutable plain values
 *    cross the port boundary. Error details surfaced to callers are limited to OS
 *    errno codes so record content can never leak through an error path.
 *
 * A FAILED append is NOT silent: an errno-only, secret-free alarm is raised
 * through the injected `onAppendFailure` hook (the root points it at the process
 * logger) so a broken audit sink — under which a write may have executed with no
 * record — is loud. It never writes to stdout/stderr directly.
 */
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hasErrnoCode } from '../bounded-read.js';
import { SECRET_MODES } from '../fs-permissions.js';
import { type Result, ok, err } from '../../shared/index.js';
import type {
  AuditLog,
  AuditRecord,
  AppError,
} from '../../application/index.js';
import { appError, AppErrorCode } from '../../application/index.js';

export interface FileAuditLogOptions {
  /** Path to the append-only audit log (NDJSON). Created/forced 0600 on POSIX. */
  readonly filePath: string;
  /**
   * Out-of-band alarm invoked with an errno-only, SECRET-FREE reason (e.g.
   * 'ENOSPC', 'EACCES') the FIRST time an append fails and again after it recovers,
   * so a broken audit sink is never silent. Never receives record content. The
   * composition root wires it to the process logger; default is a no-op.
   */
  readonly onAppendFailure?: (reason: string) => void;
}

/** Schema version stamped on every line so this append-only log stays forward-readable. */
const AUDIT_SCHEMA_VERSION = 1;
/** Cap for the free-text `reason` field (defense against content dumping / flooding). */
const MAX_REASON_LENGTH = 2048;

/**
 * Persistence/wire model — DISTINCT from the application `AuditRecord` DTO:
 * carries a schema version, uses plain (unbranded) strings and omits absent
 * optionals. Internal to this adapter.
 */
interface AuditLogEntry {
  readonly v: number;
  readonly timestampIso: string;
  readonly endpointName: string;
  readonly verb: string;
  readonly outcome: 'allow' | 'deny';
  readonly targetChatId?: string;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

const capReason = (reason: string): string =>
  reason.length <= MAX_REASON_LENGTH
    ? reason
    : `${reason.slice(0, MAX_REASON_LENGTH)} [truncated]`;

/**
 * Surface ONLY the OS errno code (e.g. 'EACCES', 'ENOSPC') — never a raw error
 * message — so that record content can never leak into an `AppError`.
 */
const describeError = (cause: unknown): string => {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code: unknown = cause.code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return 'I/O error';
};

export class FileAuditLog implements AuditLog {
  private readonly filePath: string;
  private readonly onAppendFailure: (reason: string) => void;
  /** Lazily-set once the parent directory has been ensured. */
  private ready = false;
  /** True while the sink is in a failure streak — so the alarm fires once, not per lost record. */
  private alarmed = false;
  /** Serializes appends so concurrent records never interleave (append-only integrity). */
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(options: FileAuditLogOptions) {
    this.filePath = options.filePath;
    this.onAppendFailure = options.onAppendFailure ?? ((): void => undefined);
  }

  public append(record: AuditRecord): Promise<Result<void, AppError>> {
    const written = this.writeChain.then(
      (): Promise<Result<void, AppError>> => this.writeRecord(record),
    );
    const settle = (): void => {
      /* keep the append chain alive regardless of this record's outcome */
    };
    this.writeChain = written.then(settle, settle);
    return written;
  }

  /** Clean-shutdown barrier: every append already admitted has reached the OS. */
  public drain(): Promise<void> {
    return this.writeChain;
  }

  private async writeRecord(
    record: AuditRecord,
  ): Promise<Result<void, AppError>> {
    try {
      await this.ensureReady();
      await appendFile(this.filePath, this.serialize(record), {
        encoding: 'utf8',
        mode: SECRET_MODES.file,
        flag: 'a',
      });
      if (this.alarmed) {
        this.alarmed = false;
        this.onAppendFailure('recovered — audit appends are succeeding again');
      }
      return ok(undefined);
    } catch (cause) {
      const reason = describeError(cause);
      // LOUD, not silent: a failed append means a record was lost (a write may have
      // already executed). Signal ONCE per failure streak (errno-only, no content)
      // so a broken sink is visible without flooding the log with every lost record.
      if (!this.alarmed) {
        this.alarmed = true;
        this.onAppendFailure(reason);
      }
      return err(
        appError(AppErrorCode.GatewayUnavailable, `Audit append failed: ${reason}`),
      );
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) {
      return;
    }
    await mkdir(dirname(this.filePath), { recursive: true, mode: SECRET_MODES.dir });
    if (process.platform !== 'win32') {
      try {
        await chmod(this.filePath, SECRET_MODES.file);
      } catch (cause) {
        if (!hasErrnoCode(cause, 'ENOENT')) {
          throw cause;
        }
      }
    }
    this.ready = true;
  }

  private serialize(record: AuditRecord): string {
    const entry: AuditLogEntry = {
      v: AUDIT_SCHEMA_VERSION,
      timestampIso: record.timestampIso,
      endpointName: record.endpointName,
      verb: record.verb,
      outcome: record.outcome,
      ...(record.targetChatId !== undefined
        ? { targetChatId: record.targetChatId }
        : {}),
      ...(record.reason !== undefined ? { reason: capReason(record.reason) } : {}),
      ...(record.idempotencyKey !== undefined
        ? { idempotencyKey: record.idempotencyKey }
        : {}),
    };
    return `${JSON.stringify(entry)}\n`;
  }
}

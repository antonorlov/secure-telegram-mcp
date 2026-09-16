/**
 * Append-only NDJSON sink for write attempts, in-engine denials and successful media egress.
 * Every record is one line written with the `'a'` flag: this adapter never truncates history,
 * and owner-level tampering stays outside its threat boundary. Records are structured metadata
 * only — endpoint, verb, target, timestamp, outcome — never message bodies, secrets or raw
 * untrusted prose.
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
  // NDJSON; created and forced 0600 on POSIX.
  readonly filePath: string;
  // Fires with an errno-only, secret-free reason the first time an append fails and again once
  // it recovers, so a broken audit sink is never silent. Never receives record content.
  readonly onAppendFailure?: (reason: string) => void;
}

// Schema version stamped on every line so this append-only log stays forward-readable.
const AUDIT_SCHEMA_VERSION = 1;
// Cap for the free-text `reason` field (defense against content dumping / flooding).
const MAX_REASON_LENGTH = 2048;

// Wire model, distinct from the application DTO: carries a schema version, plain unbranded
// strings, and omits absent optionals.
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

// Surface only the OS errno, never a raw error message, so record content can never leak into
// an `AppError`.
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
  private ready = false;
  // True while the sink is in a failure streak — so the alarm fires once, not per lost record.
  private alarmed = false;
  // Serializes appends so concurrent records never interleave (append-only integrity).
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
      // keep the append chain alive regardless of this record's outcome
    };
    this.writeChain = written.then(settle, settle);
    return written;
  }

  // Clean-shutdown barrier: every append already admitted has reached the OS.
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
      /**
       * LOUD, not silent: a failed append means a record was lost, possibly after the write
       * already executed. Signal once per failure streak, errno only, so a broken sink is
       * visible without flooding.
       */
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

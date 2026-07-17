import { AppErrorCode, appError } from '../errors.js';
import type { AppError } from '../errors.js';
import type { ConfigDocumentParser } from '../ports/config-document-parser.js';
import type { SealedPolicyStore } from '../ports/sealed-policy-store.js';
import type { SessionGate } from './session-gate.js';
import { err, isErr, ok, type Result } from '../../shared/index.js';

/** Validate, durably seal, and publish one exact policy document. */
export class PolicyApplicationService {
  public constructor(
    private readonly parser: ConfigDocumentParser,
    private readonly store: SealedPolicyStore,
    private readonly gate: SessionGate,
  ) {}

  public async apply(
    raw: Buffer,
    onPublished?: () => void,
  ): Promise<Result<void, AppError>> {
    if (!this.gate.isUnlocked()) {
      return err(
        appError(AppErrorCode.SessionLocked, 'cannot apply policy while locked'),
      );
    }
    let document: unknown;
    try {
      document = JSON.parse(raw.toString('utf8'));
    } catch {
      return err(appError(AppErrorCode.Validation, 'Config is not valid JSON'));
    }
    const loaded = this.parser.loadFromParsed(document);
    if (isErr(loaded)) return loaded;

    const sealed = await this.store.savePolicy(raw);
    if (isErr(sealed)) return sealed;

    this.gate.publishValidated(loaded.value, onPublished);
    return ok(undefined);
  }
}

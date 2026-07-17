/**
 * SealedPolicyRepository — the runtime's SOLE source of ACL truth after unlock.
 * Implements the `ConfigRepository` PORT over the encrypted policy blob (the
 * {@link SealedPolicyStore}): `load()` opens the sealed copy under the store's
 * active source and validates it through the SAME schema/lint/map pipeline the
 * plain repo uses, so the daemon binds endpoints/scopes to the sealed policy —
 * NEVER to `config.json`, which is now only an editable DRAFT.
 *
 * Threat closed: a same-uid attacker who edits `config.json` — widening a scope,
 * adding write verbs, or swapping an endpoint API-key hash — changes NOTHING at
 * runtime, because the runtime trusts only the sealed blob, and the blob is
 * AES-256-GCM sealed under the operator slot set so it can neither be forged nor
 * silently edited without the unlock secret. A tampered blob fails closed (GCM
 * tag mismatch => Validation). Anti-rollback is NOT attempted (a same-uid writer
 * can restore an older sealed blob, but only to a policy the operator once sealed).
 *
 * The daemon's policy-application use case is the ONLY path that promotes the
 * draft: it validates the exact document, durably seals it, then atomically
 * publishes the live projection.
 * This read-side repository NEVER writes, so an absent policy blob fails closed
 * (a same-uid deletion of `policy.blob`
 * cannot launder the current draft into the enforced policy on the next
 * startup/unlock). A draft diverging from the sealed policy is surfaced as
 * a one-line notice, never blocked.
 *
 * Composes the sealed-policy store (open/seal) + the parser port (validation).
 * No crypto/envelope type crosses the port — callers see only `LoadedConfiguration`.
 */
import {
  AppErrorCode,
  appError,
  validationError,
} from '../../application/index.js';
import type {
  AppError,
  ConfigDocumentParser,
  ConfigRepository,
  LoadedConfiguration,
  SealedPolicyStore,
} from '../../application/index.js';
import { err, isErr } from '../../shared/index.js';
import type { Result } from '../../shared/index.js';
import { readUtf8Bounded } from '../bounded-read.js';

export interface SealedPolicyRepositoryOptions {
  /** Path to the human-editable policy DRAFT (config.json). */
  readonly configPath: string;
  /** The encrypted policy blob (opened/sealed under the operator slot set). */
  readonly store: SealedPolicyStore;
  /** The SHARED schema/lint/map pipeline, fed the sealed / draft object. */
  readonly parser: ConfigDocumentParser;
  /** NON-SECRET diagnostic sink (defaults to stderr). */
  readonly log?: (message: string) => void;
}

export class SealedPolicyRepository implements ConfigRepository {
  private readonly log: (message: string) => void;

  public constructor(
    private readonly options: SealedPolicyRepositoryOptions,
  ) {
    this.log =
      options.log ??
      ((message: string): void => {
        process.stderr.write(`[policy] ${message}\n`);
      });
  }

  /**
   * VERIFY-BEFORE-USE load (the ConfigRepository port). Opens the sealed policy
   * under the store's active source and validates it. READ-ONLY and fail-closed:
   * a wrong secret / tampered blob / invalid policy aborts before any adapter
   * wires, and an ABSENT blob is an error, never a cue to promote the draft —
   * otherwise deleting `policy.blob` would make whatever sits in `config.json`
   * the enforced policy at the next startup/unlock (bypassing the seal).
   */
  public async load(): Promise<Result<LoadedConfiguration, AppError>> {
    const policyRes = await this.options.store.loadPolicy();
    if (isErr(policyRes)) {
      // Wrong PIN / tampered policy blob => secret-free Validation, fail-closed.
      return policyRes;
    }
    if (policyRes.value === undefined) {
      return err(
        appError(
          AppErrorCode.NotFound,
          "no sealed policy exists — run 'npx secure-telegram-mcp setup' (or 'npx secure-telegram-mcp apply') to apply config.json",
        ),
      );
    }
    const bytes = policyRes.value;
    try {
      const raw = bytes.toString('utf8');
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return err(validationError('Sealed policy is not valid JSON'));
      }
      const loaded = this.options.parser.loadFromParsed(json);
      if (isErr(loaded)) {
        return loaded;
      }
      await this.warnOnDraftDivergence(raw);
      return loaded;
    } finally {
      bytes.fill(0);
    }
  }

  /** Best-effort, non-blocking: note when the on-disk draft diverges from the seal. */
  private async warnOnDraftDivergence(sealed: string): Promise<void> {
    let raw: string;
    try {
      raw = await readUtf8Bounded(this.options.configPath);
    } catch {
      return;
    }
    if (raw !== sealed) {
      this.log(
        'config.json draft differs from the sealed policy — run setup (or `apply`) to apply; the sealed policy governs',
      );
    }
  }
}

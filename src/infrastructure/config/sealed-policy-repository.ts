/**
 * The runtime's sole source of ACL truth after unlock: `load()` opens the sealed policy under
 * the store's active source and validates it through the same pipeline the plain repo uses, so
 * the daemon binds to the sealed policy and never to `config.json`, which is only an editable
 * draft.
 * Threat closed: a same-uid attacker who edits the draft — widening a scope, adding write
 * verbs, swapping an endpoint API-key hash — changes nothing at runtime.
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
  readonly configPath: string;
  readonly store: SealedPolicyStore;
  readonly parser: ConfigDocumentParser;
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
   * VERIFY-BEFORE-USE: a wrong secret, tampered blob or invalid policy aborts before any
   * adapter wires. An ABSENT blob is an error, never a cue to promote the draft — otherwise
   * deleting `policy.blob` would make whatever sits in `config.json` the enforced policy at the
   * next unlock.
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

  // Best-effort, non-blocking: note when the on-disk draft diverges from the seal.
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

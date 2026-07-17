/**
 * EncryptedFileSessionStore — encrypted session and policy persistence adapter.
 * Implements daemon-only `SessionAdmin`, `SealedPolicyStore`, and runtime unlock
 * (the encrypted policy blob). At rest: the Telegram session string + sealed api
 * creds, and the sealed policy, are AES-256-GCM encrypted, files are 0600, writes
 * are atomic, key material and plaintext are zeroized after use, and SECRETS ARE
 * NEVER LOGGED.
 *
 * Every blob (each session + the ONE global policy blob) is sealed DIRECTLY under
 * one or more operator channels via the DEK-over-slots {@link SessionEnvelopeCodec}: a
 * passphrase seals a `passphrase` slot, the host machine id a `machine` slot, an
 * exported recovery keyfile a `recovery` slot. A posture / PIN change
 * decrypts-and-re-encrypts every blob under the new slot set, each written
 * atomically — a crash mid-change may leave an unwritten blob needing re-login.
 * Anti-rollback is out of scope (a same-uid writer can restore an older blob);
 * confidentiality + tamper-evidence come from AES-256-GCM.
 *
 * Posture is DERIVED from the slots on a representative blob, never a stored flag:
 *   HARDENED = a passphrase/recovery slot and NO machine slot.
 *   SMOOTH   = a machine slot.
 *   none     = nothing sealed yet.
 *
 * Unlock precedence (fail-closed, no fallthrough): the composition root resolves
 * env-channel precedence and hands the single winning source here. A PIN channel
 * (passphrase/keyfile) is tried against passphrase/recovery slots ONLY —
 * a wrong PIN NEVER falls through to the machine slot. Only a machine source uses
 * the machine slot.
 *
 * Encapsulation: only the immutable `SessionMaterial` DTO and raw policy bytes
 * cross the port boundary. No GramJS.
 */
import { randomBytes } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import type {
  SessionAdmin,
  SessionMaterial,
  SessionKeySource,
  AddKekInput,
  RewrapKekInput,
  RemoveKekInput,
  EmitRecoveryKeyfileInput,
  SealedPolicyStore,
  RuntimeUnlockableStore,
  AppError,
} from '../../application/index.js';
import { atomicCreate, atomicWrite } from '../atomic-write.js';
import {
  FileTooLargeError,
  MAX_ENCRYPTED_BLOB_BYTES,
  MAX_POLICY_PLAINTEXT_BYTES,
  MAX_KEY_FILE_BYTES,
  hasErrnoCode,
  readRegularFileBounded,
  readUtf8Bounded,
} from '../bounded-read.js';
import {
  appError,
  AppErrorCode,
  validationError,
} from '../../application/index.js';
import { SessionRef, type SessionRefValue } from '../../domain/index.js';
import {
  type Result,
  ok,
  err,
  isErr,
  isOk,
  assertNever,
} from '../../shared/index.js';
import {
  SessionEnvelopeCodec,
  isSessionEnvelopeV2,
  isSessionPayload,
  type KdfParams,
  type SlotKind,
  type SlotSecret,
  type SessionEnvelopeV2,
  type SessionPayload,
} from './session-envelope.js';
import { SystemMachineIdReader, type MachineIdReader } from './machine-id.js';

/** Posture-correct scrypt cost. Persisted per-slot so old files stay readable. */
export interface SessionKdfProfile {
  /** Passphrase/recovery slots — OWASP-grade (default N=2^17). */
  readonly pin: KdfParams;
  /** Machine slot — lighter (default N=2^15); the machine id is high-entropy-ish. */
  readonly machine: KdfParams;
}

export interface EncryptedFileSessionStoreOptions {
  /** Directory holding encrypted `<ref>.session` files + `policy.blob` (created 0700). */
  readonly directory: string;
  /**
   * The single out-of-band key source this store seals AND unlocks with. The
   * composition root resolves env-channel precedence eagerly and hands the one
   * winning source here. For SMOOTH this is `{ kind: 'machine' }`; for HARDENED a
   * `passphrase` or `keyfile` (a recovery keyfile unlocks via `keyfile`).
   */
  readonly keySource: SessionKeySource;
  /** Host machine-id reader for the SMOOTH machine slot (injectable for tests). */
  readonly machineIdReader?: MachineIdReader;
  /** Override scrypt cost (tests use a cheap profile; production uses the defaults). */
  readonly kdf?: SessionKdfProfile;
}

const SALT_BYTES = 16;
const SESSION_FILE_SUFFIX = '.session';
/** The ONE global sealed policy blob, beside the session blobs (excluded from listRefs). */
const POLICY_FILE = 'policy.blob';
/** A freshly minted recovery keyfile holds this many random bytes (raw, 0600). */
const RECOVERY_SECRET_BYTES = 32;

/** Production scrypt cost: passphrase/recovery N=2^17 (OWASP), machine N=2^15. */
const DEFAULT_KDF: SessionKdfProfile = {
  pin: { N: 1 << 17, r: 8, p: 1 },
  machine: { N: 1 << 15, r: 8, p: 1 },
};

// Secret-free, slot-aware diagnoses (the daemon maps these to operator guidance).
const DIAG_NO_CHANNEL =
  'No unlock channel available for this session (no PIN secret and no machine slot)';
const DIAG_MACHINE_MISMATCH =
  'Machine-bound session could not be unlocked on this host (machine mismatch)';
const DIAG_WRONG_SECRET =
  'Session unlock failed (wrong passphrase/keyfile or tampered blob)';
const DIAG_MACHINE_UNAVAILABLE =
  'Host machine binding is unavailable (no stable machine id on this host)';
const DIAG_HARDENED_INVARIANT =
  'Refusing to write a hardened session that also carries a machine slot';

const unavailable = (message: string): AppError =>
  appError(AppErrorCode.GatewayUnavailable, message);

/**
 * The HARD hardened invariant: a PIN/recovery slot must NEVER coexist with a
 * machine slot (a machine slot beside a PIN would silently downgrade unlock to
 * the machine key). Enforced before every seal — and, for the recovery export,
 * BEFORE the 0600 keyfile is written so a rejected seal leaves no dangling file.
 */
const ensureNoMachineWithPin = (
  kinds: readonly SlotKind[],
): Result<void, AppError> => {
  const hasPin = kinds.some((k) => k === 'passphrase' || k === 'recovery');
  const hasMachine = kinds.includes('machine');
  return hasPin && hasMachine
    ? err(validationError(DIAG_HARDENED_INVARIANT))
    : ok(undefined);
};

/** The slot kind a source seals/unlocks (keyfile bytes are a passphrase candidate). */
const slotKindForSource = (source: SessionKeySource): SlotKind => {
  switch (source.kind) {
    case 'passphrase':
    case 'keyfile':
      return 'passphrase';
    case 'machine':
      return 'machine';
    default:
      return assertNever(source, 'SessionKeySource');
  }
};

/** Which slot kinds an unlock source may legitimately open (precedence at unlock). */
const candidateSlotKinds = (source: SessionKeySource): readonly SlotKind[] => {
  switch (source.kind) {
    case 'passphrase':
      return ['passphrase'];
    // A keyfile's raw bytes are a passphrase candidate against either slot kind
    // (this is how an exported recovery keyfile unlocks — no separate source).
    case 'keyfile':
      return ['passphrase', 'recovery'];
    case 'machine':
      return ['machine'];
    default:
      return assertNever(source, 'SessionKeySource');
  }
};

/**
 * A resolved slot template: the secret + KDF cost + kind, resolved ONCE. Each
 * blob a sweep re-seals gets a FRESH per-blob salt built from this template, so
 * one held secret seals every blob without re-reading it per file. The caller
 * owns (and zeroizes) `secret`.
 */
interface PreparedSlot {
  readonly kind: SlotKind;
  readonly secret: Buffer;
  readonly kdfParams: KdfParams;
}

export class EncryptedFileSessionStore
  implements SessionAdmin, SealedPolicyStore, RuntimeUnlockableStore
{
  private readonly directory: string;
  // NOT readonly: operator authentication and PIN changes swap this
  // via setActiveSource. Every read path reads it FRESH and no unlocked plaintext
  // is cached, so no invalidation is needed.
  private keySource: SessionKeySource;
  private readonly machineIdReader: MachineIdReader;
  private readonly kdf: SessionKdfProfile;
  private readonly codec = new SessionEnvelopeCodec();

  public constructor(options: EncryptedFileSessionStoreOptions) {
    this.directory = options.directory;
    this.keySource = options.keySource;
    this.machineIdReader =
      options.machineIdReader ?? new SystemMachineIdReader();
    this.kdf = options.kdf ?? DEFAULT_KDF;
  }

  /**
   * List refs with an encrypted session file on disk. Setup-only. The policy blob
   * (`policy.blob`) does not end in `.session`, so it is never listed as a ref.
   */
  public async listRefs(): Promise<Result<readonly SessionRefValue[], AppError>> {
    try {
      const entries = await readdir(this.directory);
      const refs: SessionRefValue[] = [];
      for (const name of entries) {
        if (!name.endsWith(SESSION_FILE_SUFFIX)) {
          continue;
        }
        const ref = SessionRef.create(
          name.slice(0, name.length - SESSION_FILE_SUFFIX.length),
        );
        // Only accept names that are valid refs (SessionRef is the gate).
        if (isOk(ref)) {
          refs.push(ref.value);
        }
      }
      return ok(refs);
    } catch (error) {
      return hasErrnoCode(error, 'ENOENT')
        ? ok([])
        : err(unavailable('Session directory not readable'));
    }
  }

  /** The app-wide at-rest posture, derived from a representative blob's slots. Setup-only. */
  public async appPosture(): Promise<'none' | 'smooth' | 'hardened'> {
    const envelope = await this.representativeEnvelope();
    if (isErr(envelope)) {
      throw new Error(`Could not determine session posture: ${envelope.error.message}`);
    }
    if (envelope.value === undefined) {
      return 'none';
    }
    return envelope.value.slots.some((s) => s.kind === 'machine')
      ? 'smooth'
      : 'hardened';
  }

  /**
   * Verify `source` (default: the construction-time source) unlocks the store
   * WITHOUT loading a session, by opening a representative blob and discarding
   * its plaintext (the daemon's interactive unlock rejects a wrong PIN before
   * detaching). Nothing sealed yet verifies trivially.
   */
  public async verifyUnlock(
    source?: SessionKeySource,
  ): Promise<Result<void, AppError>> {
    const envelope = await this.representativeEnvelope();
    if (isErr(envelope)) return envelope;
    if (envelope.value === undefined) return ok(undefined);
    const opened = await this.openBytesVia(
      envelope.value,
      source ?? this.keySource,
    );
    if (isErr(opened)) return opened;
    opened.value.fill(0);
    return ok(undefined);
  }

  /**
   * {@link RuntimeUnlockableStore}: swap the active unlock source at runtime. Only
   * the descriptor is replaced — no key buffer is retained, and every read path
   * re-reads `this.keySource` fresh, so the next load uses the new source.
   */
  public setActiveSource(source: SessionKeySource): void {
    this.keySource = source;
  }

  // -- session query (daemon read side) -----------------------------------

  public async load(
    ref: SessionRefValue,
  ): Promise<Result<SessionMaterial, AppError>> {
    const parsed = await this.readEnvelope(ref);
    if (isErr(parsed)) {
      return parsed;
    }
    const bytesRes = await this.openBytesVia(parsed.value, this.keySource);
    if (isErr(bytesRes)) {
      return bytesRes;
    }
    const bytes = bytesRes.value;
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(bytes.toString('utf8'));
      } catch {
        return err(validationError('Encrypted session is corrupt (not valid JSON)'));
      }
      if (!isSessionPayload(payload)) {
        return err(validationError('Encrypted session payload is malformed'));
      }
      return ok(this.toMaterial(ref, payload));
    } finally {
      bytes.fill(0);
    }
  }

  // -- SealedPolicyStore (the encrypted ACL policy, one global blob) -------

  /**
   * Open the sealed policy blob under the active source and return its raw
   * plaintext (validated config JSON), or `undefined` when no policy blob exists
   * yet. A wrong secret / tampered blob fails closed (Validation). The CALLER
   * owns the returned buffer.
   */
  public async loadPolicy(): Promise<Result<Buffer | undefined, AppError>> {
    const envelope = await this.readPolicyEnvelope();
    if (isErr(envelope)) {
      return envelope;
    }
    if (envelope.value === undefined) {
      return ok(undefined);
    }
    return this.openBytesVia(envelope.value, this.keySource);
  }

  /**
   * Seal `bytes` (validated config JSON) into the policy blob atomically (0600).
   * A first write uses the active source. Later writes authenticate through that
   * source and preserve the existing slot set, so exported recovery access stays
   * valid without retaining the recovery secret.
   */
  public async savePolicy(bytes: Buffer): Promise<Result<void, AppError>> {
    if (bytes.length > MAX_POLICY_PLAINTEXT_BYTES) {
      return err(validationError('Policy plaintext exceeds the size ceiling'));
    }
    const existing = await this.readPolicyEnvelope();
    if (isErr(existing)) {
      return existing;
    }
    if (existing.value !== undefined) {
      const envelope = existing.value;
      const invariant = ensureNoMachineWithPin(
        envelope.slots.map((slot) => slot.kind),
      );
      if (isErr(invariant)) {
        return invariant;
      }
      const replaced = await this.useSourceSlot(
        envelope,
        this.keySource,
        (slot, secret) =>
          this.codec.replaceBytes(envelope, slot, secret, bytes),
      );
      return isErr(replaced)
        ? replaced
        : this.persistEnvelope(this.policyPath(), replaced.value);
    }
    const prepared = await this.prepareSlot(this.keySource);
    if (isErr(prepared)) {
      return prepared;
    }
    try {
      return await this.sealBlob(this.policyPath(), bytes, [
        this.toSlotSecret(prepared.value),
      ]);
    } finally {
      prepared.value.secret.fill(0);
    }
  }

  // -- SessionAdmin (daemon operator plane only) --------------------------

  /**
   * Persist a session directly under the active source's slot (where the chosen
   * posture lands on first write).
   */
  public async save(
    material: SessionMaterial,
  ): Promise<Result<void, AppError>> {
    const prepared = await this.prepareSlot(this.keySource);
    if (isErr(prepared)) {
      return prepared;
    }
    const payloadBytes = Buffer.from(
      JSON.stringify(this.toPayload(material)),
      'utf8',
    );
    try {
      return await this.sealBlob(this.filePathFor(material.sessionRef), payloadBytes, [
        this.toSlotSecret(prepared.value),
      ]);
    } finally {
      payloadBytes.fill(0);
      prepared.value.secret.fill(0);
    }
  }

  /** Set the app PIN (SMOOTH -> HARDENED): re-seal every blob under the PIN slot. */
  public async addKek(input: AddKekInput): Promise<Result<void, AppError>> {
    return this.reseal(input.current, input.pin);
  }

  /** Change the app PIN (HARDENED -> HARDENED): re-seal every blob under the new PIN. */
  public async rewrapKek(
    input: RewrapKekInput,
  ): Promise<Result<void, AppError>> {
    return this.reseal(input.current, input.replacement);
  }

  /** Remove the app PIN (HARDENED -> SMOOTH): re-seal every blob under a machine slot. */
  public async removeKek(
    input: RemoveKekInput,
  ): Promise<Result<void, AppError>> {
    return this.reseal(input.current, { kind: 'machine' });
  }

  /**
   * Export one recovery snapshot (stays HARDENED). Mints a fresh
   * random recovery secret, writes it 0600 (raw bytes, so the file IS the
   * secret), and re-seals EVERY blob (each session + the policy) under the
   * current PIN slot + the new recovery slot — so the recovery keyfile can later
   * unlock everything currently on disk.
   */
  public async emitRecoveryKeyfile(
    input: EmitRecoveryKeyfileInput,
  ): Promise<Result<void, AppError>> {
    if (this.isManagedStatePath(input.outputPath)) {
      return err(
        validationError('Recovery keyfile path collides with managed session state'),
      );
    }
    const currentSlot = await this.prepareSlot(input.current);
    if (isErr(currentSlot)) {
      return currentSlot;
    }
    const recoverySecret = randomBytes(RECOVERY_SECRET_BYTES);
    try {
      const recoverySlot: PreparedSlot = {
        kind: 'recovery',
        secret: recoverySecret,
        kdfParams: this.kdf.pin,
      };
      const prepared = [currentSlot.value, recoverySlot];

      // Enforce the hardened invariant BEFORE writing the 0600 recovery keyfile,
      // so an invariant-rejected seal (e.g. an unsupported machine-bound
      // `current`) leaves no dangling keyfile. A LATER seal/write failure is
      // handled below by removing the orphan keyfile.
      const invariant = ensureNoMachineWithPin(prepared.map((p) => p.kind));
      if (isErr(invariant)) {
        return invariant;
      }

      const wroteKeyfile = await atomicCreate(input.outputPath, recoverySecret);
      if (isErr(wroteKeyfile)) {
        return err(unavailable('Failed to write recovery keyfile'));
      }

      const swept = await this.resealAll(input.current, prepared);
      if (isErr(swept)) {
        // The re-seal failed, so the recovery slot was not committed and the
        // keyfile we just wrote is an inert orphan. Remove it so a failed export
        // leaves no dangling 0600 keyfile behind (best-effort).
        await rm(input.outputPath, { force: true }).catch(() => undefined);
        return swept;
      }
      return ok(undefined);
    } finally {
      recoverySecret.fill(0);
      currentSlot.value.secret.fill(0);
    }
  }

  /**
   * Delete the encrypted session file for a ref (daemon operator plane only).
   * Backs the home-menu "Log out". Idempotent: a missing file is success.
   */
  public async remove(ref: SessionRefValue): Promise<Result<void, AppError>> {
    try {
      await rm(this.filePathFor(ref), { force: true });
      return ok(undefined);
    } catch {
      return err(
        appError(AppErrorCode.GatewayUnavailable, 'Failed to remove session'),
      );
    }
  }

  // -- posture / PIN change: re-seal every blob ---------------------------

  /**
   * Re-key the APP (all accounts + the policy at once). Prepares the ONE new
   * slot (secret resolved once), then decrypts-and-re-encrypts every blob under
   * it. Best-effort per blob: each is written atomically, so a failure or crash
   * leaves that blob on its OLD slot set (needing re-login) while others migrate;
   * the first error is returned. (The multi-slot path — recovery export — builds
   * its own PreparedSlot set and calls resealAll directly.)
   */
  private async reseal(
    current: SessionKeySource,
    newSource: SessionKeySource,
  ): Promise<Result<void, AppError>> {
    const slot = await this.prepareSlot(newSource);
    if (isErr(slot)) {
      return slot;
    }
    try {
      return await this.resealAll(current, [slot.value]);
    } finally {
      slot.value.secret.fill(0);
    }
  }

  /** Re-seal every blob (each session + the policy) under `prepared`, opening via `current`. */
  private async resealAll(
    current: SessionKeySource,
    prepared: readonly PreparedSlot[],
  ): Promise<Result<void, AppError>> {
    const invariant = ensureNoMachineWithPin(prepared.map((p) => p.kind));
    if (isErr(invariant)) {
      return invariant;
    }
    let firstError: AppError | undefined;

    const refs = await this.listRefs();
    if (isErr(refs)) return refs;
    for (const ref of refs.value) {
      const envelope = await this.readEnvelope(ref);
      if (isErr(envelope)) {
        firstError ??= envelope.error;
        continue;
      }
      const resealed = await this.resealEnvelope(
        this.filePathFor(ref),
        envelope.value,
        current,
        prepared,
      );
      if (isErr(resealed)) {
        firstError ??= resealed.error;
      }
    }

    const policy = await this.readPolicyEnvelope();
    if (isErr(policy)) {
      firstError ??= policy.error;
    } else if (policy.value !== undefined) {
      const resealed = await this.resealEnvelope(
        this.policyPath(),
        policy.value,
        current,
        prepared,
      );
      if (isErr(resealed)) {
        firstError ??= resealed.error;
      }
    }

    return firstError === undefined ? ok(undefined) : err(firstError);
  }

  /** Open ONE blob under `current`, re-seal its bytes under fresh slots from `prepared`, atomic write. */
  private async resealEnvelope(
    path: string,
    envelope: SessionEnvelopeV2,
    current: SessionKeySource,
    prepared: readonly PreparedSlot[],
  ): Promise<Result<void, AppError>> {
    const bytesRes = await this.openBytesVia(envelope, current);
    if (isErr(bytesRes)) {
      return bytesRes;
    }
    const bytes = bytesRes.value;
    try {
      return await this.sealBlob(
        path,
        bytes,
        prepared.map((p) => this.toSlotSecret(p)),
      );
    } finally {
      bytes.fill(0);
    }
  }

  // -- internals ----------------------------------------------------------

  /** Enforce the hardened invariant, seal the bytes under the codec, atomically write. */
  private async sealBlob(
    path: string,
    plaintext: Buffer,
    slots: readonly SlotSecret[],
  ): Promise<Result<void, AppError>> {
    // The >=1-slot check lives in codec.sealBytes — the single fail-closed gate.
    const invariant = ensureNoMachineWithPin(slots.map((s) => s.kind));
    if (isErr(invariant)) {
      return invariant;
    }
    const sealed = await this.codec.sealBytes(plaintext, slots);
    if (isErr(sealed)) {
      return sealed;
    }
    return this.persistEnvelope(path, sealed.value);
  }

  private async persistEnvelope(
    path: string,
    envelope: SessionEnvelopeV2,
  ): Promise<Result<void, AppError>> {
    const written = await atomicWrite(path, JSON.stringify(envelope));
    return isErr(written)
      ? err(unavailable('Failed to persist encrypted blob'))
      : ok(undefined);
  }

  /**
   * Open a v2 envelope through the slots `source` may unlock and return the raw
   * plaintext. The secret is minted here and zeroized in `finally`. Fail-closed +
   * slot-aware: a PIN source never falls through to the machine slot, and the
   * machine branch surfaces the mismatch/unavailable diagnosis.
   */
  private async openBytesVia(
    envelope: SessionEnvelopeV2,
    source: SessionKeySource,
  ): Promise<Result<Buffer, AppError>> {
    return this.useSourceSlot(envelope, source, (slot, secret) =>
      this.codec.openBytes(envelope, slot, secret),
    );
  }

  private async useSourceSlot<T>(
    envelope: SessionEnvelopeV2,
    source: SessionKeySource,
    operation: (
      slot: SessionEnvelopeV2['slots'][number],
      secret: Buffer,
    ) => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> {
    const resolved = await this.resolveSecret(source);
    if (isErr(resolved)) {
      return resolved;
    }
    const secret = resolved.value;
    try {
      const kinds = candidateSlotKinds(source);
      const candidates = envelope.slots.filter((s) => kinds.includes(s.kind));
      if (candidates.length === 0) {
        return err(
          validationError(
            source.kind === 'machine' ? DIAG_NO_CHANNEL : DIAG_WRONG_SECRET,
          ),
        );
      }
      let lastError: AppError = validationError(DIAG_WRONG_SECRET);
      for (const slot of candidates) {
        const attempted = await operation(slot, secret);
        if (isOk(attempted)) {
          return attempted;
        }
        if (attempted.error.code !== AppErrorCode.Validation) {
          return attempted;
        }
        lastError = attempted.error;
      }
      return err(
        source.kind === 'machine'
          ? validationError(DIAG_MACHINE_MISMATCH)
          : lastError,
      );
    } finally {
      secret.fill(0);
    }
  }

  /** Resolve a source into a slot template (secret + posture-correct cost). */
  private async prepareSlot(
    source: SessionKeySource,
  ): Promise<Result<PreparedSlot, AppError>> {
    const resolved = await this.resolveSecret(source);
    if (isErr(resolved)) {
      return resolved;
    }
    const kind = slotKindForSource(source);
    const kdfParams = kind === 'machine' ? this.kdf.machine : this.kdf.pin;
    return ok({
      kind,
      secret: resolved.value,
      kdfParams,
    });
  }

  /** Build a per-blob slot secret (fresh salt) from a resolved template. */
  private toSlotSecret(prepared: PreparedSlot): SlotSecret {
    return {
      kind: prepared.kind,
      // Borrow (never zeroize here): the caller owns the template's secret.
      secret: prepared.secret,
      kdfParams: prepared.kdfParams,
      salt: randomBytes(SALT_BYTES),
    };
  }

  /**
   * Turn a {@link SessionKeySource} into the raw secret bytes the KEK derives
   * from: NFC-normalised passphrase bytes, raw keyfile/recovery file bytes, or
   * the host machine-id bytes. Caller owns zeroization of the returned buffer.
   */
  private async resolveSecret(
    source: SessionKeySource,
  ): Promise<Result<Buffer, AppError>> {
    switch (source.kind) {
      case 'passphrase':
        return ok(Buffer.from(source.passphrase.normalize('NFC'), 'utf8'));
      case 'keyfile':
        try {
          return ok(
            await readRegularFileBounded(source.keyfilePath, MAX_KEY_FILE_BYTES),
          );
        } catch {
          return err(unavailable('Session keyfile not readable'));
        }
      case 'machine': {
        const id = await this.machineIdReader.read();
        if (id === undefined || id.length === 0) {
          return err(unavailable(DIAG_MACHINE_UNAVAILABLE));
        }
        return ok(Buffer.from(id, 'utf8'));
      }
      default:
        return assertNever(source, 'SessionKeySource');
    }
  }

  /** Read + parse a session blob envelope; NotFound when the file is absent. */
  private async readEnvelope(
    ref: SessionRefValue,
  ): Promise<Result<SessionEnvelopeV2, AppError>> {
    const read = await this.readEnvelopeFile(this.filePathFor(ref), 'Encrypted session');
    if (isErr(read)) return read;
    return read.value === undefined
      ? err(appError(AppErrorCode.NotFound, 'No encrypted session stored for ref'))
      : ok(read.value);
  }

  /** Read + parse the policy blob envelope; `undefined` when the file is absent. */
  private readPolicyEnvelope(): Promise<
    Result<SessionEnvelopeV2 | undefined, AppError>
  > {
    return this.readEnvelopeFile(this.policyPath(), 'Policy blob');
  }

  /** Shared bounded read + parse; `undefined` when the file is absent. */
  private async readEnvelopeFile(
    path: string,
    label: string,
  ): Promise<Result<SessionEnvelopeV2 | undefined, AppError>> {
    let raw: string;
    try {
      // Bounded read: refuse to slurp an absurdly large file before JSON.parse.
      raw = await readUtf8Bounded(path, MAX_ENCRYPTED_BLOB_BYTES);
    } catch (e) {
      if (hasErrnoCode(e, 'ENOENT')) {
        return ok(undefined);
      }
      if (e instanceof FileTooLargeError) {
        return err(validationError(`${label} exceeds the size ceiling`));
      }
      return err(unavailable(`${label} not readable`));
    }
    const parsed = this.parseEnvelope(raw, label);
    return isErr(parsed) ? parsed : ok(parsed.value);
  }

  private parseEnvelope(
    raw: string,
    label: string,
  ): Result<SessionEnvelopeV2, AppError> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return err(validationError(`${label} is corrupt (not valid JSON)`));
    }
    return isSessionEnvelopeV2(parsed)
      ? ok(parsed)
      : err(validationError(`${label} envelope is malformed`));
  }

  /** The representative blob whose slots define the posture: policy, else any session. */
  private async representativeEnvelope(): Promise<
    Result<SessionEnvelopeV2 | undefined, AppError>
  > {
    const policy = await this.readPolicyEnvelope();
    if (isErr(policy)) {
      return policy;
    }
    if (policy.value !== undefined) {
      return ok(policy.value);
    }
    const refs = await this.listRefs();
    if (isErr(refs)) return refs;
    for (const ref of refs.value) {
      const envelope = await this.readEnvelope(ref);
      if (isErr(envelope)) return envelope;
      return ok(envelope.value);
    }
    return ok(undefined);
  }

  /** Recovery material must never alias a managed blob or masquerade as a session. */
  private isManagedStatePath(outputPath: string): boolean {
    const fromState = relative(resolve(this.directory), resolve(outputPath));
    return (
      fromState === '' ||
      fromState === POLICY_FILE ||
      (!fromState.includes(sep) && fromState.endsWith(SESSION_FILE_SUFFIX))
    );
  }

  private toMaterial(
    ref: SessionRefValue,
    payload: SessionPayload,
  ): SessionMaterial {
    return Object.freeze<SessionMaterial>({
      sessionRef: ref,
      secret: payload.session,
      apiId: payload.apiId,
      apiHash: payload.apiHash,
      ...(payload.label !== undefined ? { label: payload.label } : {}),
    });
  }

  private toPayload(material: SessionMaterial): SessionPayload {
    return {
      session: material.secret,
      apiId: material.apiId,
      apiHash: material.apiHash,
      ...(material.label !== undefined ? { label: material.label } : {}),
    };
  }

  private policyPath(): string {
    return join(this.directory, POLICY_FILE);
  }

  private filePathFor(ref: SessionRefValue): string {
    // `ref` is validated by SessionRef.create (^[a-z0-9][a-z0-9_-]{0,63}$) so it
    // is always a safe single path segment — no traversal possible.
    return join(this.directory, `${ref}${SESSION_FILE_SUFFIX}`);
  }
}

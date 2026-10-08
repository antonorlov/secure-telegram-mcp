/**
 * Encrypted session and policy persistence: daemon-only `SessionAdmin`, `SealedPolicyStore` and
 * runtime unlock.
 * At rest everything is AES-256-GCM, files are 0600, writes are atomic, key material and
 * plaintext are zeroized after use, and secrets are NEVER logged.
 * Every blob — each session plus the ONE global policy blob — is sealed directly under one or
 * more operator channels through the DEK-over-slots codec: a passphrase seals a `passphrase`
 * slot, the host machine id a `machine` slot, an exported recovery keyfile a `recovery` slot.
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

// Persisted per slot, so old files stay readable after a cost change.
export interface SessionKdfProfile {
  readonly pin: KdfParams;
  readonly machine: KdfParams;
}

export interface EncryptedFileSessionStoreOptions {
  readonly directory: string;
  // The single out-of-band source this store seals AND unlocks with; the composition root
  // resolves env-channel precedence and hands over the one winner.
  readonly keySource: SessionKeySource;
  readonly machineIdReader?: MachineIdReader;
  readonly kdf?: SessionKdfProfile;
}

const SALT_BYTES = 16;
const SESSION_FILE_SUFFIX = '.session';
// The one global policy blob, beside the session blobs; excluded from listRefs.
const POLICY_FILE = 'policy.blob';
const RECOVERY_SECRET_BYTES = 32;

// Passphrase and recovery cost is OWASP-grade; the machine slot is lighter because the id is
// high-entropy-ish.
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
 * HARD hardened invariant: a PIN or recovery slot must NEVER coexist with a machine slot, which
 * would silently downgrade unlock to the machine key. Enforced before every seal — and, for the
 * recovery export, before the 0600 keyfile is written, so a rejected seal leaves no dangling
 * file.
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

// Keyfile bytes count as a passphrase candidate.
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

const candidateSlotKinds = (source: SessionKeySource): readonly SlotKind[] => {
  switch (source.kind) {
    case 'passphrase':
      return ['passphrase'];
    // A keyfile's raw bytes are a passphrase candidate against either slot kind — this is how
    // an exported recovery keyfile unlocks, with no separate source.
    case 'keyfile':
      return ['passphrase', 'recovery'];
    case 'machine':
      return ['machine'];
    default:
      return assertNever(source, 'SessionKeySource');
  }
};

// Resolved once per sweep: every blob gets a fresh per-blob salt built from this template, so
// one held secret seals them all. The caller owns and zeroizes `secret`.
interface PreparedSlot {
  readonly kind: SlotKind;
  readonly secret: Buffer;
  readonly kdfParams: KdfParams;
}

export class EncryptedFileSessionStore
  implements SessionAdmin, SealedPolicyStore, RuntimeUnlockableStore
{
  private readonly directory: string;
  /**
   * Not readonly: operator authentication and PIN changes swap it via setActiveSource. Every
   * read path re-reads it fresh and no unlocked plaintext is cached, so nothing needs
   * invalidating.
   */
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

  // Setup-only. `policy.blob` does not end in `.session`, so it is never listed as a ref.
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

  // Derived from a representative blob's slots; setup-only.
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

  // Opens a representative blob and discards its plaintext, so a wrong PIN is rejected before
  // detaching. Nothing sealed yet verifies trivially.
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

  // Only the descriptor is replaced — no key buffer is retained, so the next load derives from
  // the new source.
  public setActiveSource(source: SessionKeySource): void {
    this.keySource = source;
  }

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

  // `undefined` when no policy blob exists yet; a wrong secret or tampered blob fails closed.
  // The caller owns the returned buffer.
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

  // Later writes authenticate through the active source and preserve the existing slot set, so
  // exported recovery access stays valid without retaining the recovery secret.
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

  // The first write is where the chosen posture lands.
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

  public async addKek(input: AddKekInput): Promise<Result<void, AppError>> {
    return this.reseal(input.current, input.pin);
  }

  public async rewrapKek(
    input: RewrapKekInput,
  ): Promise<Result<void, AppError>> {
    return this.reseal(input.current, input.replacement);
  }

  public async removeKek(
    input: RemoveKekInput,
  ): Promise<Result<void, AppError>> {
    return this.reseal(input.current, { kind: 'machine' });
  }

  /**
   * Mints a fresh random recovery secret, writes it 0600 — the file IS the secret — and
   * re-seals every blob under the current PIN slot plus the new recovery slot, so the keyfile
   * can later unlock everything on disk.
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

      // Enforce the hardened invariant BEFORE writing the 0600 keyfile, so a rejected seal
      // leaves no dangling file behind.
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
        // The re-seal failed, so the recovery slot was never committed and the keyfile is an
        // inert orphan — remove it (best-effort).
        await rm(input.outputPath, { force: true }).catch(() => undefined);
        return swept;
      }
      return ok(undefined);
    } finally {
      recoverySecret.fill(0);
      currentSlot.value.secret.fill(0);
    }
  }

  // Idempotent: a missing file is success.
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

  /**
   * Re-keys the whole app at once: the new slot's secret is resolved once, then every blob is
   * decrypted and re-encrypted under it. Best-effort per blob — a failure or crash leaves that
   * blob on its old slot set, needing re-login, while the others migrate.
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

  // Fail-closed and slot-aware: a PIN source never falls through to the machine slot. The
  // secret is minted here and zeroized in `finally`.
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

  private toSlotSecret(prepared: PreparedSlot): SlotSecret {
    return {
      kind: prepared.kind,
      // Borrow, never zeroize here: the caller owns the template's secret.
      secret: prepared.secret,
      kdfParams: prepared.kdfParams,
      salt: randomBytes(SALT_BYTES),
    };
  }

  // NFC-normalised passphrase bytes, raw keyfile bytes, or host machine-id bytes. The caller
  // owns zeroization of the result.
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

  private async readEnvelope(
    ref: SessionRefValue,
  ): Promise<Result<SessionEnvelopeV2, AppError>> {
    const read = await this.readEnvelopeFile(this.filePathFor(ref), 'Encrypted session');
    if (isErr(read)) return read;
    return read.value === undefined
      ? err(appError(AppErrorCode.NotFound, 'No encrypted session stored for ref'))
      : ok(read.value);
  }

  private readPolicyEnvelope(): Promise<
    Result<SessionEnvelopeV2 | undefined, AppError>
  > {
    return this.readEnvelopeFile(this.policyPath(), 'Policy blob');
  }

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

  // Recovery material must never alias a managed blob or masquerade as a session.
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
    // `ref` is validated by SessionRef.create, so it is always a safe single path segment — no
    // traversal possible.
    return join(this.directory, `${ref}${SESSION_FILE_SUFFIX}`);
  }
}

/**
 * On-disk, self-describing encrypted-at-rest form of a sealed blob (a session, or the sealed
 * policy). An infrastructure detail: these types never leak across a port boundary, and all
 * binary fields are base64.
 * v2: a random DEK encrypts the payload and is GCM-wrapped under one or more per-slot KEKs,
 * each derived from an operator channel via scrypt. A wrong secret fails on the slot's GCM tag,
 * a tampered payload on the payload's own tag — there is no separate commit MAC.
 */
import {
  randomBytes,
  scrypt,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';

import {
  AppErrorCode,
  appError,
  validationError,
  type AppError,
} from '../../application/index.js';
import { type Result, ok, err, isErr } from '../../shared/index.js';

// AES-256-GCM is the only authenticated cipher used at rest.
export const SESSION_ALGORITHM = 'aes-256-gcm' as const;
export type SessionAlgorithm = typeof SESSION_ALGORITHM;

// scrypt cost, persisted in the envelope so old files stay readable after a change.
export interface KdfParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

// The sealed crown jewels — api creds travel WITH the session, atomically.
export interface SessionPayload {
  readonly session: string;
  readonly apiId: number;
  readonly apiHash: string;
  // Sealed so the setup menu can show "Log out (<name>)" without a network call and without
  // leaking the name in plaintext beside the ciphertext. Absent on older blobs.
  readonly label?: string;
}

// Every blob is sealed directly under the operator channels present: a passphrase (HARDENED),
// the host machine id (SMOOTH), and/or an exported recovery keyfile.
export type SlotKind = 'passphrase' | 'machine' | 'recovery';

// A GCM-wrap of the shared DEK under this slot's scrypt KEK. A wrong secret is a tag mismatch,
// so no separate verifier is needed.
export interface Slot {
  readonly kind: SlotKind;
  readonly kdf: 'scrypt';
  readonly kdfParams: KdfParams;
  readonly salt: string;
  readonly iv: string;
  readonly authTag: string;
  readonly wrappedDek: string;
}

export interface SessionEnvelopeV2 {
  readonly v: 2;
  readonly alg: SessionAlgorithm;
  readonly payload: {
    readonly iv: string;
    readonly authTag: string;
    readonly ciphertext: string;
  };
  readonly slots: readonly Slot[];
}

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === 'object' && u !== null;

export const isKdfParams = (u: unknown): u is KdfParams =>
  isRecord(u) &&
  typeof u['N'] === 'number' &&
  typeof u['r'] === 'number' &&
  typeof u['p'] === 'number';

export const isSessionPayload = (u: unknown): u is SessionPayload =>
  isRecord(u) &&
  typeof u['session'] === 'string' &&
  typeof u['apiId'] === 'number' &&
  typeof u['apiHash'] === 'string' &&
  (u['label'] === undefined || typeof u['label'] === 'string');

const isSlotKind = (u: unknown): u is SlotKind =>
  u === 'passphrase' || u === 'machine' || u === 'recovery';

export const isSlot = (u: unknown): u is Slot =>
  isRecord(u) &&
  isSlotKind(u['kind']) &&
  u['kdf'] === 'scrypt' &&
  isKdfParams(u['kdfParams']) &&
  typeof u['salt'] === 'string' &&
  typeof u['iv'] === 'string' &&
  typeof u['authTag'] === 'string' &&
  typeof u['wrappedDek'] === 'string';

/**
 * Defence-in-depth cap on slot count: a legitimate blob needs a handful, and an absurd count
 * can only come from a tampered 0600 file trying to force a per-slot scrypt DoS at load. Fails
 * closed above this — rejected as malformed, never KDF-iterated.
 */
const MAX_SESSION_SLOTS = 8;

const isPayloadEnvelope = (
  u: unknown,
): u is SessionEnvelopeV2['payload'] =>
  isRecord(u) &&
  typeof u['iv'] === 'string' &&
  typeof u['authTag'] === 'string' &&
  typeof u['ciphertext'] === 'string';

export const isSessionEnvelopeV2 = (u: unknown): u is SessionEnvelopeV2 =>
  isRecord(u) &&
  u['v'] === 2 &&
  u['alg'] === SESSION_ALGORITHM &&
  isPayloadEnvelope(u['payload']) &&
  Array.isArray(u['slots']) &&
  u['slots'].length >= 1 &&
  u['slots'].length <= MAX_SESSION_SLOTS &&
  u['slots'].every(isSlot);

// GCM standard 96-bit nonce; a fresh random IV per wrap and encrypt.
const IV_BYTES = 12;
const KEY_BYTES = 32;
/**
 * Node's default `maxmem` (32 MiB) is too low for the OWASP-grade PIN profile, where N=2^17
 * needs 128 MiB, so the ceiling fits production profiles with headroom. A tampered envelope
 * with an absurd `N` makes scrypt refuse to allocate and error out as a generic Validation
 * failure — no crash, no secret echoed.
 */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export interface SlotSecret {
  readonly kind: SlotKind;
  // Raw secret bytes the KEK derives from. The codec NEVER zeroizes the caller's secret —
  // ownership stays with the store.
  readonly secret: Buffer;
  readonly kdfParams: KdfParams;
  // 16-byte fresh random per-slot salt.
  readonly salt: Buffer;
}

/**
 * Owns the v2 envelope crypto and serialization end to end: no file I/O, no long-lived state,
 * and every key buffer it mints is zeroized before the method returns.
 * Failure model is secret-free and fail-closed — a wrong secret, a tampered slot or a corrupt
 * payload all collapse to one `Validation` error, while a seal-time crypto failure is
 * `GatewayUnavailable`.
 */
export class SessionEnvelopeCodec {
  // Each call regenerates the DEK and every IV, so re-sealing after a posture change never
  // reuses key material. Requires at least one slot; the caller owns the plaintext buffer.
  public async sealBytes(
    plaintext: Buffer,
    slots: readonly SlotSecret[],
  ): Promise<Result<SessionEnvelopeV2, AppError>> {
    if (slots.length < 1) {
      return err(
        validationError('A session envelope requires at least one unlock slot'),
      );
    }
    const dek = randomBytes(KEY_BYTES);
    const keks: Buffer[] = [];
    try {
      const built: Slot[] = [];
      for (const spec of slots) {
        const kek = await this.deriveKek(spec.secret, spec.salt, spec.kdfParams);
        if (isErr(kek)) {
          return kek;
        }
        keks.push(kek.value);
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv(SESSION_ALGORITHM, kek.value, iv);
        const wrappedDek = Buffer.concat([cipher.update(dek), cipher.final()]);
        built.push(
          Object.freeze<Slot>({
            kind: spec.kind,
            kdf: 'scrypt',
            kdfParams: spec.kdfParams,
            salt: spec.salt.toString('base64'),
            iv: iv.toString('base64'),
            authTag: cipher.getAuthTag().toString('base64'),
            wrappedDek: wrappedDek.toString('base64'),
          }),
        );
      }

      const payloadIv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(SESSION_ALGORITHM, dek, payloadIv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);

      return ok(
        Object.freeze<SessionEnvelopeV2>({
          v: 2,
          alg: SESSION_ALGORITHM,
          payload: Object.freeze({
            iv: payloadIv.toString('base64'),
            authTag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
          }),
          slots: Object.freeze(built),
        }),
      );
    } catch {
      return err(
        appError(
          AppErrorCode.GatewayUnavailable,
          'Failed to seal session envelope',
        ),
      );
    } finally {
      dek.fill(0);
      for (const kek of keks) {
        kek.fill(0);
      }
    }
  }

  /**
   * The selected slot authenticates access to the DEK and the replacement payload gets a fresh
   * nonce, so a policy update keeps recovery access without loading or retaining the recovery
   * secret.
   */
  public async replaceBytes(
    envelope: SessionEnvelopeV2,
    slot: Slot,
    secret: Buffer,
    plaintext: Buffer,
  ): Promise<Result<SessionEnvelopeV2, AppError>> {
    const unwrapped = await this.unwrapDek(slot, secret);
    if (isErr(unwrapped)) {
      return unwrapped;
    }
    const dek = unwrapped.value;
    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(SESSION_ALGORITHM, dek, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      return ok(
        Object.freeze<SessionEnvelopeV2>({
          ...envelope,
          payload: Object.freeze({
            iv: iv.toString('base64'),
            authTag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
          }),
        }),
      );
    } catch {
      return err(
        appError(
          AppErrorCode.GatewayUnavailable,
          'Failed to seal session envelope',
        ),
      );
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Derives the slot's KEK, unwraps the DEK, then decrypts the payload. DEK and KEK are
   * zeroized before return and the caller owns the returned plaintext. A wrong secret, tampered
   * slot or corrupt payload fail closed as Validation — no plaintext, no stack trace, no
   * secret.
   */
  public async openBytes(
    envelope: SessionEnvelopeV2,
    slot: Slot,
    secret: Buffer,
  ): Promise<Result<Buffer, AppError>> {
    const unwrapped = await this.unwrapDek(slot, secret);
    if (isErr(unwrapped)) {
      return unwrapped;
    }
    const dek = unwrapped.value;
    try {
      try {
        const decipher = createDecipheriv(
          SESSION_ALGORITHM,
          dek,
          Buffer.from(envelope.payload.iv, 'base64'),
        );
        decipher.setAuthTag(Buffer.from(envelope.payload.authTag, 'base64'));
        // Capture the intermediates so they can be zeroized: Buffer.concat copies the
        // plaintext, leaving update()/final()'s own buffers as un-wiped GC garbage.
        const head = decipher.update(
          Buffer.from(envelope.payload.ciphertext, 'base64'),
        );
        const tail = decipher.final();
        const plaintext = Buffer.concat([head, tail]);
        head.fill(0);
        tail.fill(0);
        return ok(plaintext);
      } catch {
        return err(validationError('Payload decryption failed'));
      }
    } finally {
      dek.fill(0);
    }
  }

  private async unwrapDek(
    slot: Slot,
    secret: Buffer,
  ): Promise<Result<Buffer, AppError>> {
    const derived = await this.deriveKek(
      secret,
      Buffer.from(slot.salt, 'base64'),
      slot.kdfParams,
    );
    if (isErr(derived)) {
      return derived;
    }
    const kek = derived.value;
    try {
      const decipher = createDecipheriv(
        SESSION_ALGORITHM,
        kek,
        Buffer.from(slot.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(slot.authTag, 'base64'));
      return ok(
        Buffer.concat([
          decipher.update(Buffer.from(slot.wrappedDek, 'base64')),
          decipher.final(),
        ]),
      );
    } catch {
      return err(
        validationError('Unlock failed (wrong secret or tampered unlock slot)'),
      );
    } finally {
      kek.fill(0);
    }
  }

  // A scrypt failure — bad params, or a tampered `N` above the clamp — collapses to a generic
  // Validation error: no secret, no parameter echo, no process crash.
  private deriveKek(
    secret: Buffer,
    salt: Buffer,
    params: KdfParams,
  ): Promise<Result<Buffer, AppError>> {
    return new Promise<Result<Buffer, AppError>>((resolve) => {
      try {
        scrypt(
          secret,
          salt,
          KEY_BYTES,
          { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
          (error, derivedKey) => {
            if (error) {
              resolve(err(validationError('Key derivation failed')));
            } else {
              resolve(ok(derivedKey));
            }
          },
        );
      } catch {
        // Node throws SYNCHRONOUSLY when the params exceed `maxmem` (a tampered
        // envelope's absurd N) — fail closed with the same generic diagnosis.
        resolve(err(validationError('Key derivation failed')));
      }
    });
  }
}

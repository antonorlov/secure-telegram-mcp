/**
 * Session-envelope FORMAT — the on-disk, self-describing encrypted-at-rest
 * representation of a sealed blob (a session, or the sealed policy). An
 * infrastructure detail: these types + type-guards NEVER leak across a port
 * boundary (the application sees only `SessionMaterial` / raw bytes). All binary
 * fields are base64.
 *
 * v2: a random DEK encrypts the PAYLOAD; the DEK is GCM-wrapped under one or more
 * per-slot KEKs (each derived from an operator channel via scrypt). A wrong
 * secret => the slot's GCM tag mismatches => clean fail; a tampered payload =>
 * the payload's GCM tag mismatches => clean fail. There is NO separate commit
 * MAC: each slot wrap and the payload are independently AES-256-GCM
 * authenticated, and anti-rollback is out of scope (a same-uid writer can restore
 * any older file).
 *
 * The codec ({@link SessionEnvelopeCodec}) at the bottom owns DEK generation,
 * per-slot wrap/unwrap, scrypt KEK derivation, and zeroize. Pure crypto/format:
 * NO file I/O, NO GramJS — the store owns persistence and secret acquisition.
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

/** AES-256-GCM is the only authenticated cipher used at rest. */
export const SESSION_ALGORITHM = 'aes-256-gcm' as const;
export type SessionAlgorithm = typeof SESSION_ALGORITHM;

/** scrypt cost parameters, persisted in the envelope so old files stay readable. */
export interface KdfParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** The sealed crown-jewel payload — api creds travel WITH the session atomically. */
export interface SessionPayload {
  /** The Telegram session string. */
  readonly session: string;
  /** Telegram app api_id. */
  readonly apiId: number;
  /** Telegram app api_hash. */
  readonly apiHash: string;
  /**
   * OPTIONAL human label (the account's Telegram display name), SEALED so the
   * setup menu can show "Log out (<name>)" without a network call and without
   * leaking the name as plaintext beside the ciphertext. Absent on older blobs.
   */
  readonly label?: string;
}

/**
 * Which operator channel a slot's KEK is derived from. Every blob is sealed
 * DIRECTLY under the operator channels present: a passphrase (HARDENED), the
 * host machine id (SMOOTH), and/or an exported recovery keyfile.
 */
export type SlotKind = 'passphrase' | 'machine' | 'recovery';

/**
 * One unlock slot: a GCM-wrap of the shared DEK under a KEK derived (scrypt)
 * from this slot's secret channel. Wrong secret => GCM tag mismatch => clean
 * fail (no separate verifier).
 */
export interface Slot {
  readonly kind: SlotKind;
  readonly kdf: 'scrypt';
  readonly kdfParams: KdfParams;
  /** 16-byte fresh random per-slot salt. */
  readonly salt: string;
  readonly iv: string;
  readonly authTag: string;
  readonly wrappedDek: string;
}

/** Current DEK-over-slots envelope. */
export interface SessionEnvelopeV2 {
  readonly v: 2;
  readonly alg: SessionAlgorithm;
  /** DEK-encrypted payload (AES-256-GCM, authenticated by its own tag). */
  readonly payload: {
    readonly iv: string;
    readonly authTag: string;
    readonly ciphertext: string;
  };
  /** One or more unlock slots (>= 1). */
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
 * Defense-in-depth cap on the slot count a v2 envelope may carry. A legitimate
 * blob needs at most a handful (a PIN slot + a recovery slot, with headroom); an
 * absurd count can only come from a tampered 0600 file trying to force a per-slot
 * scrypt-DoS at load. The guard FAILS CLOSED above this — such a blob is rejected
 * as malformed, never KDF-iterated.
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

// ---------------------------------------------------------------------------
// SessionEnvelopeCodec — the v2 crypto/format engine.
// ---------------------------------------------------------------------------

/** GCM standard 96-bit nonce. A fresh random IV is minted per wrap/encrypt. */
const IV_BYTES = 12;
/** AES-256 / the DEK / every KEK are 256-bit. */
const KEY_BYTES = 32;
/**
 * scrypt memory clamp. Node's default `maxmem` (32 MiB) is too low for the
 * OWASP-grade PIN profile (N=2^17 needs 128*N*r = 128 MiB), so pass a ceiling
 * that fits the production profiles with headroom. A tampered envelope with an
 * absurd `N` makes scrypt refuse to allocate beyond this and error out (mapped to
 * a generic Validation failure) — no crash, no secret echoed.
 */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** The per-slot secret + derivation inputs the codec needs to wrap/unwrap the DEK. */
export interface SlotSecret {
  readonly kind: SlotKind;
  /**
   * Raw secret bytes the KEK is derived from (passphrase UTF-8 bytes, keyfile /
   * recovery-keyfile bytes, or the machine-id bytes). The codec NEVER zeroizes
   * the caller's secret — ownership stays with the store.
   */
  readonly secret: Buffer;
  readonly kdfParams: KdfParams;
  /** 16-byte fresh random per-slot salt. */
  readonly salt: Buffer;
}

/**
 * SessionEnvelopeCodec — owns the v2 envelope crypto + serialization end to end.
 * Generates the DEK, GCM-wraps it under each slot's scrypt KEK, and seals the
 * payload with AES-256-GCM. NO file I/O, NO long-lived state — every key buffer
 * it mints is zeroized before the method returns.
 *
 * Failure model (secret-free, fail-closed): a wrong secret, a tampered slot, or a
 * corrupt/malformed payload all collapse to a single `AppErrorCode.Validation`
 * (no secret, no stack trace); a seal-time crypto failure is `GatewayUnavailable`.
 */
export class SessionEnvelopeCodec {
  /**
   * Build a fresh v2 envelope over RAW BYTES: mint a random DEK, wrap it under
   * each slot's KEK, and seal the plaintext. Each call regenerates the DEK and
   * all IVs, so re-sealing (a posture change) never reuses key material.
   * Requires >= 1 slot. The caller owns the plaintext buffer (and its zeroization).
   */
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
   * Replace an envelope's payload while preserving its existing unlock slots.
   * The selected slot authenticates access to the DEK; the replacement payload
   * gets a fresh GCM nonce. This lets a policy update retain recovery access
   * without loading or retaining the recovery secret.
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
   * Unlock a v2 envelope through ONE chosen slot (the store picks it per the
   * channel-precedence rules): derive the slot's KEK, GCM-unwrap the DEK, then
   * decrypt the payload. The DEK/KEK never escape this method — both are zeroized
   * before return; the CALLER owns (and must zeroize) the returned plaintext.
   * A wrong secret, a tampered slot, or a corrupt payload all fail closed as a
   * Validation error (no plaintext, no stack trace, no secret).
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
        // Capture the intermediates so they can be zeroized: Buffer.concat copies
        // the plaintext, leaving update()/final()'s own buffers as un-wiped GC
        // garbage otherwise. The caller owns (and zeroizes) the returned copy.
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

  /** Authenticate one unlock slot and return its DEK to the immediate caller. */
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

  /**
   * scrypt KEK derivation with one sane memory clamp ({@link SCRYPT_MAXMEM}). A
   * scrypt failure (bad params, or a tampered envelope whose `N` exceeds the
   * clamp) collapses to a generic Validation error — no secret, no parameter
   * echo, no process crash.
   */
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

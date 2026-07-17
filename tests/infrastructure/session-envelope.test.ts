import { describe, it, expect } from 'vitest';

import {
  isSessionEnvelopeV2,
  type KdfParams,
  SessionEnvelopeCodec,
  type SessionEnvelopeV2,
  type SessionPayload,
  type Slot,
  type SlotSecret,
} from '../../src/infrastructure/index.js';
import { AppErrorCode } from '../../src/application/index.js';
import { isOk, isErr, type Result } from '../../src/shared/index.js';

// Small (cheap) scrypt params so the suite stays fast; the production posture
// uses N=2^17 / 2^15 but the codec is parameter-agnostic so a tiny N exercises
// every code path identically.
const FAST_KDF: KdfParams = { N: 1 << 8, r: 8, p: 1 };

const PAYLOAD: SessionPayload = {
  session: '1ApWaPpa.Telegram.SESSION.string.value',
  apiId: 1234567,
  apiHash: 'deadbeefcafedeadbeefcafedeadbeef',
};

const passphraseSlot = (passphrase: string, saltByte = 0xab): SlotSecret => ({
  kind: 'passphrase',
  secret: Buffer.from(passphrase, 'utf8'),
  kdfParams: FAST_KDF,
  salt: Buffer.alloc(16, saltByte),
});

const machineSlot = (machineId: string): SlotSecret => ({
  kind: 'machine',
  secret: Buffer.from(machineId, 'utf8'),
  kdfParams: FAST_KDF,
  salt: Buffer.alloc(16, 0x11),
});

const expectOk = <T>(r: Result<T, unknown>): T => {
  if (!isOk(r)) {
    throw new Error(`expected ok, got error: ${JSON.stringify(r)}`);
  }
  return r.value;
};

const sealPayload = async (
  codec: SessionEnvelopeCodec,
  slots: readonly SlotSecret[],
): ReturnType<SessionEnvelopeCodec['sealBytes']> => {
  const bytes = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');
  try {
    return await codec.sealBytes(bytes, slots);
  } finally {
    bytes.fill(0);
  }
};

const openPayload = async (
  codec: SessionEnvelopeCodec,
  envelope: SessionEnvelopeV2,
  slot: Slot,
  secret: Buffer,
): Promise<unknown> => {
  const bytes = expectOk(await codec.openBytes(envelope, slot, secret));
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return parsed;
  } finally {
    bytes.fill(0);
  }
};

/** Total accessor — keeps the strict no-non-null-assertion / no-cast rules happy. */
const slotAt = (envelope: SessionEnvelopeV2, index = 0): Slot => {
  const slot = envelope.slots[index];
  if (slot === undefined) {
    throw new Error(`no slot at index ${String(index)}`);
  }
  return slot;
};

describe('SessionEnvelopeCodec', () => {
  const codec = new SessionEnvelopeCodec();

  it('round-trips the payload through a passphrase slot', async () => {
    const slot = passphraseSlot('correct horse battery staple');
    const envelope = expectOk(await sealPayload(codec, [slot]));

    expect(isSessionEnvelopeV2(envelope)).toBe(true);
    expect(envelope.v).toBe(2);
    expect(envelope.alg).toBe('aes-256-gcm');
    expect(envelope.slots).toHaveLength(1);
    expect(slotAt(envelope).kind).toBe('passphrase');

    const opened = await openPayload(codec, envelope, slotAt(envelope), slot.secret);
    expect(opened).toEqual(PAYLOAD);
  });

  it('never writes the session secret in cleartext into the envelope', async () => {
    const slot = passphraseSlot('a-strong-pin');
    const envelope = expectOk(await sealPayload(codec, [slot]));
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(PAYLOAD.session);
    expect(serialized).not.toContain(PAYLOAD.apiHash);
  });

  it('wraps the DEK under multiple slots — each independently unlocks', async () => {
    const pass = passphraseSlot('the-pin', 0x01);
    const recovery: SlotSecret = {
      kind: 'recovery',
      secret: Buffer.from('recovery-keyfile-bytes'),
      kdfParams: FAST_KDF,
      salt: Buffer.alloc(16, 0x02),
    };
    const envelope = expectOk(await sealPayload(codec, [pass, recovery]));
    expect(envelope.slots).toHaveLength(2);

    const viaPass = await openPayload(codec, envelope, slotAt(envelope, 0), pass.secret);
    const viaRecovery = await openPayload(
      codec,
      envelope,
      slotAt(envelope, 1),
      recovery.secret,
    );
    expect(viaPass).toEqual(PAYLOAD);
    expect(viaRecovery).toEqual(PAYLOAD);
  });

  it('rejects sealing with zero slots (envelope needs >= 1)', async () => {
    const r = await sealPayload(codec, []);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe(AppErrorCode.Validation);
    }
  });

  it('fails closed on a wrong secret (GCM tag mismatch, no plaintext)', async () => {
    const slot = passphraseSlot('right-pin');
    const envelope = expectOk(await sealPayload(codec, [slot]));

    const r = await codec.openBytes(
      envelope,
      slotAt(envelope),
      Buffer.from('wrong-pin', 'utf8'),
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe(AppErrorCode.Validation);
      expect(r.error.message).not.toContain('right-pin');
      expect(r.error.message).not.toContain(PAYLOAD.session);
    }
  });

  it('fails closed when the payload IV is swapped (GCM tag mismatch)', async () => {
    const slot = passphraseSlot('pin');
    const envelope = expectOk(await sealPayload(codec, [slot]));

    // Re-encode the same envelope but with a different payload IV: the DEK
    // unwraps fine, but the ciphertext/authTag no longer match the swapped IV.
    const tampered: SessionEnvelopeV2 = {
      ...envelope,
      payload: {
        ...envelope.payload,
        iv: Buffer.alloc(12, 0x99).toString('base64'),
      },
    };
    const r = await codec.openBytes(tampered, slotAt(tampered), slot.secret);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe(AppErrorCode.Validation);
    }
  });

  it('fails closed when a slot authTag is corrupted (per-slot GCM authenticates the wrap)', async () => {
    const slot = passphraseSlot('pin');
    const envelope = expectOk(await sealPayload(codec, [slot]));
    const original = slotAt(envelope);
    const corrupt: SessionEnvelopeV2 = {
      ...envelope,
      slots: [{ ...original, authTag: Buffer.alloc(16, 0x00).toString('base64') }],
    };
    const r = await codec.openBytes(corrupt, slotAt(corrupt), slot.secret);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe(AppErrorCode.Validation);
    }
  });

  it('mints a unique DEK + IVs on every seal (no key/nonce reuse)', async () => {
    const slot = passphraseSlot('pin');
    const a = expectOk(await sealPayload(codec, [slot]));
    const b = expectOk(await sealPayload(codec, [slot]));

    expect(a.payload.iv).not.toBe(b.payload.iv);
    expect(a.payload.ciphertext).not.toBe(b.payload.ciphertext);
    expect(slotAt(a).iv).not.toBe(slotAt(b).iv);
    // Different DEK => different wrapped DEK.
    expect(slotAt(a).wrappedDek).not.toBe(slotAt(b).wrappedDek);
  });

  it('re-sealing regenerates the DEK (wrappedDek differs for identical inputs)', async () => {
    const slot = passphraseSlot('pin');
    const first = expectOk(await sealPayload(codec, [slot]));
    // Simulate a posture change that keeps the same payload + slot secret.
    const second = expectOk(await sealPayload(codec, [slot]));
    expect(slotAt(first).wrappedDek).not.toBe(slotAt(second).wrappedDek);

    // The fresh envelope still decrypts to the same payload.
    expect(
      await openPayload(codec, second, slotAt(second), slot.secret),
    ).toEqual(PAYLOAD);
  });

  it('fails closed (no crash) when a tampered slot demands scrypt memory past the clamp', async () => {
    const oversized: SlotSecret = {
      kind: 'passphrase',
      secret: Buffer.from('pin'),
      // 128 * N * r far exceeds the sane maxmem clamp -> scrypt refuses.
      kdfParams: { N: 1 << 24, r: 8, p: 1 },
      salt: Buffer.alloc(16, 0x05),
    };
    const r = await sealPayload(codec, [oversized]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // A generic, secret-free failure — no distinct OOM taxonomy, no crash.
      expect(r.error.code).toBe(AppErrorCode.Validation);
      expect(r.error.message).not.toContain('pin');
    }
  });
});

describe('isSessionEnvelopeV2 — slot-count cap (scrypt-DoS defense)', () => {
  const codec = new SessionEnvelopeCodec();

  it('accepts a legitimate two-slot blob (under the cap)', async () => {
    const envelope = expectOk(
      await sealPayload(codec, [passphraseSlot('pin'), machineSlot('m')]),
    );
    expect(isSessionEnvelopeV2(envelope)).toBe(true);
  });

  it('FAILS CLOSED on a tampered blob whose slot count exceeds the cap', async () => {
    const envelope = expectOk(await sealPayload(codec, [passphraseSlot('pin')]));
    const oneSlot = slotAt(envelope);
    // Forge a blob piling on far more slots than the internal cap (8) allows —
    // the shape a tampered 0600 file would use to force a per-slot scrypt-DoS at
    // load. Rejected as not-a-v2-envelope BEFORE any KDF runs over the slots.
    const tampered = {
      ...envelope,
      slots: Array.from({ length: 9 }, () => oneSlot),
    };
    expect(isSessionEnvelopeV2(tampered)).toBe(false);
  });
});

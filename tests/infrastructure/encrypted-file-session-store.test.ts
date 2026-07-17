/**
 * EncryptedFileSessionStore — DIRECT-slot v2 DEK-over-slots behaviour (no
 * app-key indirection). Exercises the persistence + secret-acquisition layer
 * around SessionEnvelopeCodec: posture round-trips (SMOOTH/HARDENED), the
 * no-machine-fallthrough unlock rule, channel precedence, the setup-only posture
 * mutators (each re-sealing every blob directly under the new slot set), the
 * hardened-has-no-machine-slot invariant, recovery-keyfile export, the sealed
 * policy blob, and api-cred round-trip.
 *
 * A CHEAP scrypt profile is injected so the suite stays fast; the codec is
 * parameter-agnostic so a tiny N exercises every path identically.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  EncryptedFileSessionStore,
  type SessionKdfProfile,
} from '../../src/infrastructure/index.js';
import {
  MAX_POLICY_PLAINTEXT_BYTES,
  MAX_KEY_FILE_BYTES,
} from '../../src/infrastructure/bounded-read.js';
import type { MachineIdReader } from '../../src/infrastructure/index.js';
import type {
  SessionMaterial,
  SessionKeySource,
} from '../../src/application/index.js';
import { SessionRef, type SessionRefValue } from '../../src/domain/index.js';
import { unwrap, isOk, isErr } from '../../src/shared/result.js';

const REF: SessionRefValue = unwrap(SessionRef.create('primary'));

const CHEAP: SessionKdfProfile = {
  pin: { N: 1 << 8, r: 8, p: 1 },
  machine: { N: 1 << 8, r: 8, p: 1 },
};

const material = (
  over: Partial<SessionMaterial> = {},
): SessionMaterial => ({
  sessionRef: REF,
  secret: '1ApWaPpa.Telegram.SESSION.string',
  apiId: 1234567,
  apiHash: 'deadbeefcafedeadbeefcafedeadbeef',
  ...over,
});

const fixedMachineId = (id: string | undefined): MachineIdReader => ({
  read: (): Promise<string | undefined> => Promise.resolve(id),
});

interface StoreSetup {
  readonly directory: string;
  readonly keySource: SessionKeySource;
  readonly machineId?: string;
}

const makeStore = (s: StoreSetup): EncryptedFileSessionStore =>
  new EncryptedFileSessionStore({
    directory: s.directory,
    keySource: s.keySource,
    machineIdReader: fixedMachineId(s.machineId ?? 'machine-AAA'),
    kdf: CHEAP,
  });

interface OnDiskBlob {
  readonly v: number;
  readonly slots: { kind: string }[];
  readonly payload: { ciphertext: string };
}

let dir: string;
const fileFor = (ref: SessionRefValue): string =>
  join(dir, `${String(ref)}.session`);
const readBlob = async (ref: SessionRefValue = REF): Promise<OnDiskBlob> =>
  JSON.parse(await readFile(fileFor(ref), 'utf8')) as OnDiskBlob;
const slotKinds = async (ref: SessionRefValue = REF): Promise<string[]> =>
  (await readBlob(ref)).slots.map((s) => s.kind).sort();
const policySlotKinds = async (): Promise<string[]> =>
  (
    JSON.parse(await readFile(join(dir, 'policy.blob'), 'utf8')) as OnDiskBlob
  ).slots.map((slot) => slot.kind).sort();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'efss-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('EncryptedFileSessionStore — SMOOTH (machine) posture', () => {
  it('round-trips the sealed payload incl. api creds on the same host', async () => {
    const store = makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    });
    expect(isOk(await store.save(material()))).toBe(true);

    // The blob is sealed DIRECTLY under a machine slot — no app.key indirection.
    expect(await slotKinds()).toEqual(['machine']);

    const reader = makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    });
    const loaded = await reader.load(REF);
    expect(isOk(loaded)).toBe(true);
    if (isOk(loaded)) {
      expect(loaded.value).toEqual(material());
    }
  });

  it('fails closed when loaded on a DIFFERENT machine (binding mismatch)', async () => {
    const store = makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    });
    await store.save(material());

    const other = makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-2',
    });
    const loaded = await other.load(REF);
    expect(isErr(loaded)).toBe(true);
    if (isErr(loaded)) {
      expect(loaded.error.message).toContain('machine');
    }
  });

  it('refuses to seal a machine slot when the host exposes no machine id', async () => {
    const store = new EncryptedFileSessionStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineIdReader: fixedMachineId(undefined),
      kdf: CHEAP,
    });
    const saved = await store.save(material());
    expect(isErr(saved)).toBe(true);
  });
});

describe('EncryptedFileSessionStore — HARDENED (passphrase) posture', () => {
  const PIN: SessionKeySource = {
    kind: 'passphrase',
    passphrase: 'correct horse battery staple',
  };

  it('round-trips under the correct passphrase (blob sealed directly under the PIN slot)', async () => {
    const store = makeStore({ directory: dir, keySource: PIN });
    expect(isOk(await store.save(material()))).toBe(true);
    expect(await slotKinds()).toEqual(['passphrase']);

    const loaded = await makeStore({ directory: dir, keySource: PIN }).load(REF);
    expect(isOk(loaded)).toBe(true);
    if (isOk(loaded)) expect(loaded.value).toEqual(material());
  });

  it('fails closed under a wrong passphrase and does NOT mutate the blob', async () => {
    const store = makeStore({ directory: dir, keySource: PIN });
    await store.save(material());
    const before = await readFile(fileFor(REF), 'utf8');

    const wrong = makeStore({
      directory: dir,
      keySource: { kind: 'passphrase', passphrase: 'nope' },
    });
    const loaded = await wrong.load(REF);
    expect(isErr(loaded)).toBe(true);

    // Runtime load is read-only: the blob is untouched.
    expect(await readFile(fileFor(REF), 'utf8')).toBe(before);
  });
});

describe('EncryptedFileSessionStore — unlock precedence & no fallthrough', () => {
  // Channel PRECEDENCE is resolved eagerly in the composition root (main.ts):
  // the store is handed the SINGLE winning source. These tests pin the store's
  // half of the contract — given that one source, a PIN never silently falls
  // through to the machine slot.
  it('a PIN source NEVER falls through to a machine slot (SMOOTH blob + PIN supplied => fail)', async () => {
    // Seal SMOOTH (machine slot only) on host-1.
    const store = makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    });
    await store.save(material());

    // Now load with a PIN source AND a VALID machine id available: the machine
    // slot WOULD unlock, but a PIN source must never reach it.
    const reader = makeStore({
      directory: dir,
      keySource: { kind: 'passphrase', passphrase: 'x' },
      machineId: 'host-1',
    });
    const loaded = await reader.load(REF);
    expect(isErr(loaded)).toBe(true); // fail-closed, no machine fallthrough.
  });

  it('fails closed with a no-channel diagnosis when neither PIN nor machine slot applies', async () => {
    // HARDENED blob (passphrase slot only) loaded with a machine source — no PIN
    // source, and the blob carries no machine slot.
    await makeStore({
      directory: dir,
      keySource: { kind: 'passphrase', passphrase: 'p' },
    }).save(material());

    const reader = makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    });
    const loaded = await reader.load(REF);
    expect(isErr(loaded)).toBe(true);
    if (isErr(loaded)) expect(loaded.error.message).toContain('No unlock channel');
  });

  it('uses the machine slot ONLY when the source is a machine source', async () => {
    await makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    }).save(material());

    const reader = makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    });
    const loaded = await reader.load(REF);
    expect(isOk(loaded)).toBe(true);
    if (isOk(loaded)) expect(loaded.value).toEqual(material());
  });

  it('wrong PIN on a SMOOTH blob: fail-closed, NO machine fallthrough, NO blob write', async () => {
    await makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    }).save(material());
    const before = await readFile(fileFor(REF), 'utf8');

    const reader = makeStore({
      directory: dir,
      keySource: { kind: 'passphrase', passphrase: 'wrong' },
      machineId: 'host-1', // present — but a PIN source was supplied.
    });
    const loaded = await reader.load(REF);

    expect(isErr(loaded)).toBe(true);
    expect(await readFile(fileFor(REF), 'utf8')).toBe(before);
  });
});

describe('EncryptedFileSessionStore — tamper at load', () => {
  it('rejects a blob whose payload authTag was flipped (AES-GCM)', async () => {
    const PIN: SessionKeySource = { kind: 'passphrase', passphrase: 'p' };
    await makeStore({ directory: dir, keySource: PIN }).save(material());

    const raw = JSON.parse(await readFile(fileFor(REF), 'utf8')) as {
      payload: { authTag: string };
    };
    raw.payload.authTag = Buffer.alloc(16, 0x00).toString('base64');
    await writeFile(fileFor(REF), JSON.stringify(raw), 'utf8');

    const loaded = await makeStore({ directory: dir, keySource: PIN }).load(REF);
    expect(isErr(loaded)).toBe(true);
  });

  it('rejects a malformed envelope (not v2)', async () => {
    const PIN: SessionKeySource = { kind: 'passphrase', passphrase: 'p' };
    await writeFile(fileFor(REF), JSON.stringify({ v: 99, slots: [] }), 'utf8');
    const loaded = await makeStore({ directory: dir, keySource: PIN }).load(REF);
    expect(isErr(loaded)).toBe(true);
  });
});

describe('EncryptedFileSessionStore — posture mutators (SessionAdmin)', () => {
  const P1: SessionKeySource = { kind: 'passphrase', passphrase: 'pin-one' };
  const P2: SessionKeySource = { kind: 'passphrase', passphrase: 'pin-two' };

  it('addKek: SMOOTH -> HARDENED re-seals the blob directly under the PIN slot', async () => {
    const store = makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    });
    await store.save(material());
    const blobBefore = await readFile(fileFor(REF), 'utf8');

    const added = await store.addKek({ current: { kind: 'machine' }, pin: P1 });
    expect(isOk(added)).toBe(true);

    // Re-sealed (rewritten) directly under a passphrase slot; machine slot gone.
    expect(await readFile(fileFor(REF), 'utf8')).not.toBe(blobBefore);
    expect(await slotKinds()).toEqual(['passphrase']);

    const loaded = await makeStore({ directory: dir, keySource: P1 }).load(REF);
    expect(isOk(loaded)).toBe(true);
    if (isOk(loaded)) expect(loaded.value).toEqual(material());
    // The old machine channel no longer unlocks (machine slot dropped).
    expect(
      isErr(
        await makeStore({
          directory: dir,
          keySource: { kind: 'machine' },
          machineId: 'host-1',
        }).load(REF),
      ),
    ).toBe(true);
  });

  it('rewrapKek: changes the PIN, old PIN stops working, payload intact', async () => {
    const store = makeStore({ directory: dir, keySource: P1 });
    await store.save(material());

    expect(isOk(await store.rewrapKek({ current: P1, replacement: P2 }))).toBe(true);

    expect(isErr(await makeStore({ directory: dir, keySource: P1 }).load(REF))).toBe(true);
    const loaded = await makeStore({ directory: dir, keySource: P2 }).load(REF);
    expect(isOk(loaded)).toBe(true);
    if (isOk(loaded)) expect(loaded.value).toEqual(material());
  });

  it('removeKek: HARDENED -> SMOOTH (machine slot only), payload preserved', async () => {
    const store = makeStore({ directory: dir, keySource: P1, machineId: 'host-1' });
    await store.save(material());

    expect(isOk(await store.removeKek({ current: P1 }))).toBe(true);
    expect(await slotKinds()).toEqual(['machine']);

    const loaded = await makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    }).load(REF);
    expect(isOk(loaded)).toBe(true);
    if (isOk(loaded)) expect(loaded.value).toEqual(material());
  });

  it('a corrupt second blob is reported, but the healthy blob still migrates (best-effort)', async () => {
    const store = makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    });
    await store.save(material());
    // A second session file that cannot be opened/re-sealed (corrupt JSON).
    const corruptRef: SessionRefValue = unwrap(SessionRef.create('corrupt'));
    await writeFile(fileFor(corruptRef), 'not-json', 'utf8');

    const added = await store.addKek({ current: { kind: 'machine' }, pin: P1 });
    // The corrupt blob makes the change report an error...
    expect(isErr(added)).toBe(true);
    // ...but the HEALTHY blob was still re-sealed under the new PIN (best-effort).
    expect(await slotKinds(REF)).toEqual(['passphrase']);
    expect(
      isOk(await makeStore({ directory: dir, keySource: P1 }).load(REF)),
    ).toBe(true);
  });

  it('emitRecoveryKeyfile: writes a 0600 keyfile + adds a recovery slot that unlocks', async () => {
    const store = makeStore({ directory: dir, keySource: P1 });
    await store.save(material());

    const outputPath = join(dir, 'recovery.key');
    const emitted = await store.emitRecoveryKeyfile({ current: P1, outputPath });
    expect(isOk(emitted)).toBe(true);

    const mode = (await stat(outputPath)).mode & 0o777;
    expect(mode).toBe(0o600);

    // The blob now carries BOTH the passphrase slot and the recovery slot.
    expect(await slotKinds()).toEqual(['passphrase', 'recovery']);

    // The original PIN still unlocks...
    expect(isOk(await makeStore({ directory: dir, keySource: P1 }).load(REF))).toBe(true);
    // ...and so does the exported recovery keyfile (loaded as the sole source).
    const viaRecovery = await makeStore({
      directory: dir,
      keySource: { kind: 'keyfile', keyfilePath: outputPath },
    }).load(REF);
    expect(isOk(viaRecovery)).toBe(true);
    if (isOk(viaRecovery)) expect(viaRecovery.value).toEqual(material());
  });

  it('recovery export covers blobs present at export time, not later sessions', async () => {
    const store = makeStore({ directory: dir, keySource: P1 });
    expect(isOk(await store.save(material()))).toBe(true);
    const outputPath = join(dir, 'recovery-snapshot.key');
    expect(
      isOk(await store.emitRecoveryKeyfile({ current: P1, outputPath })),
    ).toBe(true);

    const secondary = unwrap(SessionRef.create('secondary'));
    expect(isOk(await store.save(material({ sessionRef: secondary })))).toBe(true);
    const recoveryStore = makeStore({
      directory: dir,
      keySource: { kind: 'keyfile', keyfilePath: outputPath },
    });
    expect(isOk(await recoveryStore.load(REF))).toBe(true);
    expect(isErr(await recoveryStore.load(secondary))).toBe(true);
  });

  it('refuses an existing recovery destination without changing either file', async () => {
    const store = makeStore({ directory: dir, keySource: P1 });
    await store.save(material());
    const sessionBefore = await readFile(fileFor(REF), 'utf8');
    const outputDir = await mkdtemp(join(tmpdir(), 'efss-recovery-existing-'));
    const outputPath = join(outputDir, 'recovery.key');
    await writeFile(outputPath, 'keep-me', 'utf8');
    try {
      const emitted = await store.emitRecoveryKeyfile({
        current: P1,
        outputPath,
      });

      expect(isErr(emitted)).toBe(true);
      expect(await readFile(outputPath, 'utf8')).toBe('keep-me');
      expect(await readFile(fileFor(REF), 'utf8')).toBe(sessionBefore);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('refuses recovery destinations inside the managed session directory', async () => {
    const store = makeStore({ directory: dir, keySource: P1 });
    await store.save(material());
    await store.savePolicy(Buffer.from('{"version":1}', 'utf8'));
    const sessionBefore = await readFile(fileFor(REF), 'utf8');
    const policyPath = join(dir, 'policy.blob');
    const policyBefore = await readFile(policyPath, 'utf8');

    for (const outputPath of [fileFor(REF), policyPath, join(dir, 'new.session')]) {
      expect(
        isErr(await store.emitRecoveryKeyfile({ current: P1, outputPath })),
      ).toBe(true);
    }

    expect(await readFile(fileFor(REF), 'utf8')).toBe(sessionBefore);
    expect(await readFile(policyPath, 'utf8')).toBe(policyBefore);
    await expect(stat(join(dir, 'new.session'))).rejects.toThrow();
  });

  it('emitRecoveryKeyfile with a keyfile `current` still round-trips after the dual-zeroize finally', async () => {
    const currentKeyfile = join(dir, 'current.key');
    await writeFile(currentKeyfile, randomBytes(24));
    const keyfileSrc: SessionKeySource = {
      kind: 'keyfile',
      keyfilePath: currentKeyfile,
    };
    const store = makeStore({ directory: dir, keySource: keyfileSrc });
    await store.save(material());

    const recoveryPath = join(dir, 'rec2.key');
    const emitted = await store.emitRecoveryKeyfile({
      current: keyfileSrc,
      outputPath: recoveryPath,
    });
    expect(isOk(emitted)).toBe(true);

    expect(
      isOk(await makeStore({ directory: dir, keySource: keyfileSrc }).load(REF)),
    ).toBe(true);
    const viaRecovery = await makeStore({
      directory: dir,
      keySource: { kind: 'keyfile', keyfilePath: recoveryPath },
    }).load(REF);
    expect(isOk(viaRecovery)).toBe(true);
    if (isOk(viaRecovery)) expect(viaRecovery.value).toEqual(material());
  });
});

describe('EncryptedFileSessionStore — sealed policy blob', () => {
  const PIN: SessionKeySource = { kind: 'passphrase', passphrase: 'policy-pin' };

  it('round-trips policy bytes; a wrong PIN fails closed', async () => {
    const store = makeStore({ directory: dir, keySource: PIN });
    const bytes = Buffer.from('{"version":1}', 'utf8');
    expect(isOk(await store.savePolicy(bytes))).toBe(true);

    // The policy file is NOT a session ref (excluded from listRefs).
    expect(await store.listRefs()).toEqual({ ok: true, value: [] });

    const loaded = await makeStore({ directory: dir, keySource: PIN }).loadPolicy();
    expect(isOk(loaded)).toBe(true);
    if (isOk(loaded) && loaded.value !== undefined) {
      expect(loaded.value.toString('utf8')).toBe('{"version":1}');
    }

    const wrong = await makeStore({
      directory: dir,
      keySource: { kind: 'passphrase', passphrase: 'nope' },
    }).loadPolicy();
    expect(isErr(wrong)).toBe(true);
  });

  it('loadPolicy returns undefined when no policy blob exists (migration trigger)', async () => {
    const loaded = await makeStore({ directory: dir, keySource: PIN }).loadPolicy();
    expect(isOk(loaded)).toBe(true);
    if (isOk(loaded)) expect(loaded.value).toBeUndefined();
  });

  it('a PIN change re-seals the policy blob too (recovery-independent)', async () => {
    const P2: SessionKeySource = { kind: 'passphrase', passphrase: 'policy-pin-2' };
    const store = makeStore({ directory: dir, keySource: PIN });
    await store.save(material());
    await store.savePolicy(Buffer.from('{"version":1}', 'utf8'));

    expect(isOk(await store.rewrapKek({ current: PIN, replacement: P2 }))).toBe(true);

    // The policy blob now opens under the NEW PIN, not the old one.
    expect(isErr(await makeStore({ directory: dir, keySource: PIN }).loadPolicy())).toBe(true);
    const loaded = await makeStore({ directory: dir, keySource: P2 }).loadPolicy();
    expect(isOk(loaded)).toBe(true);
    if (isOk(loaded) && loaded.value !== undefined) {
      expect(loaded.value.toString('utf8')).toBe('{"version":1}');
    }
  });

  it('policy saves preserve exported recovery access and PIN access', async () => {
    const store = makeStore({ directory: dir, keySource: PIN });
    await store.save(material());
    await store.savePolicy(Buffer.from('{"version":1}', 'utf8'));
    const recoveryPath = join(dir, 'policy-recovery.key');
    expect(
      isOk(
        await store.emitRecoveryKeyfile({
          current: PIN,
          outputPath: recoveryPath,
        }),
      ),
    ).toBe(true);

    expect(await policySlotKinds()).toEqual(['passphrase', 'recovery']);
    const updated = Buffer.from('{"version":2}', 'utf8');
    try {
      expect(isOk(await store.savePolicy(updated))).toBe(true);
      expect(await policySlotKinds()).toEqual(['passphrase', 'recovery']);

      for (const keySource of [
        PIN,
        { kind: 'keyfile', keyfilePath: recoveryPath } as const,
      ]) {
        const loaded = await makeStore({ directory: dir, keySource }).loadPolicy();
        expect(isOk(loaded)).toBe(true);
        if (isOk(loaded) && loaded.value !== undefined) {
          expect(loaded.value.equals(updated)).toBe(true);
          loaded.value.fill(0);
        }
      }
    } finally {
      updated.fill(0);
    }
  });

  it('refuses a policy replacement under the wrong secret without changing the blob', async () => {
    const original = Buffer.from('{"version":1}', 'utf8');
    const replacement = Buffer.from('{"version":2}', 'utf8');
    const store = makeStore({ directory: dir, keySource: PIN });
    expect(isOk(await store.savePolicy(original))).toBe(true);
    const before = await readFile(join(dir, 'policy.blob'), 'utf8');

    try {
      const wrong = makeStore({
        directory: dir,
        keySource: { kind: 'passphrase', passphrase: 'wrong-pin' },
      });
      expect(isErr(await wrong.savePolicy(replacement))).toBe(true);
      expect(await readFile(join(dir, 'policy.blob'), 'utf8')).toBe(before);

      const loaded = await store.loadPolicy();
      expect(isOk(loaded)).toBe(true);
      if (isOk(loaded) && loaded.value !== undefined) {
        expect(loaded.value.equals(original)).toBe(true);
        loaded.value.fill(0);
      }
    } finally {
      original.fill(0);
      replacement.fill(0);
    }
  });

  it('reloads a maximum-size plaintext policy through its larger encrypted envelope', async () => {
    const store = makeStore({ directory: dir, keySource: PIN });
    const plaintext = Buffer.alloc(MAX_POLICY_PLAINTEXT_BYTES, 0x61);
    try {
      expect(isOk(await store.savePolicy(plaintext))).toBe(true);
      expect((await stat(join(dir, 'policy.blob'))).size).toBeGreaterThan(
        MAX_POLICY_PLAINTEXT_BYTES,
      );

      const loaded = await store.loadPolicy();
      expect(isOk(loaded)).toBe(true);
      if (isOk(loaded) && loaded.value !== undefined) {
        expect(loaded.value.length).toBe(MAX_POLICY_PLAINTEXT_BYTES);
        expect(loaded.value.equals(plaintext)).toBe(true);
        loaded.value.fill(0);
      }
    } finally {
      plaintext.fill(0);
    }
  });

  it('refuses policy plaintext above the reloadable ceiling', async () => {
    const store = makeStore({ directory: dir, keySource: PIN });
    const oversized = Buffer.alloc(MAX_POLICY_PLAINTEXT_BYTES + 1);
    try {
      expect(isErr(await store.savePolicy(oversized))).toBe(true);
      await expect(stat(join(dir, 'policy.blob'))).rejects.toThrow();
    } finally {
      oversized.fill(0);
    }
  });
});

describe('EncryptedFileSessionStore — appPosture / verifyUnlock', () => {
  const PIN: SessionKeySource = { kind: 'passphrase', passphrase: 'pp' };

  it('posture is none before anything is sealed', async () => {
    expect(await makeStore({ directory: dir, keySource: PIN }).appPosture()).toBe('none');
  });

  it('posture is derived from the sealed slots (hardened / smooth)', async () => {
    await makeStore({ directory: dir, keySource: PIN }).save(material());
    expect(await makeStore({ directory: dir, keySource: PIN }).appPosture()).toBe('hardened');

    const smoothDir = await mkdtemp(join(tmpdir(), 'efss-s-'));
    try {
      await new EncryptedFileSessionStore({
        directory: smoothDir,
        keySource: { kind: 'machine' },
        machineIdReader: fixedMachineId('host-1'),
        kdf: CHEAP,
      }).save(material());
      expect(
        await new EncryptedFileSessionStore({
          directory: smoothDir,
          keySource: { kind: 'machine' },
          machineIdReader: fixedMachineId('host-1'),
          kdf: CHEAP,
        }).appPosture(),
      ).toBe('smooth');
    } finally {
      await rm(smoothDir, { recursive: true, force: true });
    }
  });

  it('verifyUnlock accepts the right PIN, rejects the wrong one, and is trivial when nothing is sealed', async () => {
    const empty = makeStore({ directory: dir, keySource: PIN });
    expect(isOk(await empty.verifyUnlock())).toBe(true); // nothing sealed yet

    await empty.save(material());
    expect(
      isOk(await makeStore({ directory: dir, keySource: PIN }).verifyUnlock(PIN)),
    ).toBe(true);
    expect(
      isErr(
        await makeStore({ directory: dir, keySource: PIN }).verifyUnlock({
          kind: 'passphrase',
          passphrase: 'wrong',
        }),
      ),
    ).toBe(true);
  });

  it('does not misreport a corrupt session-only store as first-run posture', async () => {
    await writeFile(fileFor(REF), 'not-json', 'utf8');

    await expect(
      makeStore({ directory: dir, keySource: PIN }).appPosture(),
    ).rejects.toThrow('Could not determine session posture');
  });
});

describe('EncryptedFileSessionStore — strict session enumeration', () => {
  it('keeps a missing directory as the first-run empty case', async () => {
    const missing = join(dir, 'missing');
    const listed = await makeStore({
      directory: missing,
      keySource: { kind: 'machine' },
    }).listRefs();

    expect(listed).toEqual({ ok: true, value: [] });
  });

  it.skipIf(process.getuid?.() === 0)(
    'fails rekey before writing when the session directory cannot be enumerated',
    async () => {
      const store = makeStore({
        directory: dir,
        keySource: { kind: 'machine' },
        machineId: 'host-1',
      });
      await store.save(material());
      const before = await readFile(fileFor(REF), 'utf8');
      try {
        await chmod(dir, 0o300);
        expect(isErr(await store.listRefs())).toBe(true);
        expect(
          isErr(
            await store.addKek({
              current: { kind: 'machine' },
              pin: { kind: 'passphrase', passphrase: 'new-pin' },
            }),
          ),
        ).toBe(true);
      } finally {
        await chmod(dir, 0o700);
      }
      expect(await readFile(fileFor(REF), 'utf8')).toBe(before);
    },
  );
});

describe('EncryptedFileSessionStore — hardened invariant (no PIN slot beside a machine slot)', () => {
  it('refuses to export a recovery keyfile on a SMOOTH app (would mix machine + recovery)', async () => {
    const store = makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    });
    await store.save(material());

    const recPath = join(dir, 'rec.key');
    const emitted = await store.emitRecoveryKeyfile({
      current: { kind: 'machine' },
      outputPath: recPath,
    });
    expect(isErr(emitted)).toBe(true);
    if (isErr(emitted)) {
      expect(emitted.error.message).toContain('machine slot');
    }

    // The invariant is checked BEFORE the 0600 keyfile is written, so a rejected
    // export leaves NO dangling recovery keyfile on disk.
    await expect(stat(recPath)).rejects.toThrow();

    // The original SMOOTH store is untouched (machine-slot blob).
    expect(await slotKinds()).toEqual(['machine']);
  });

  it.skipIf(process.getuid?.() === 0)(
    'removes the orphan recovery keyfile when the re-seal blob write fails',
    async () => {
      const pin: SessionKeySource = {
        kind: 'passphrase',
        passphrase: 'pin-seal-fail',
      };
      await makeStore({ directory: dir, keySource: pin }).save(material());

      const outDir = await mkdtemp(join(tmpdir(), 'efss-out-'));
      const outputPath = join(outDir, 'recovery.key');
      try {
        // Read+search but NOT write: readEnvelope (read) succeeds; the blob's
        // atomic temp-file create (write) fails closed.
        await chmod(dir, 0o500);

        const emitted = await makeStore({
          directory: dir,
          keySource: pin,
        }).emitRecoveryKeyfile({ current: pin, outputPath });

        expect(isErr(emitted)).toBe(true);
        await expect(stat(outputPath)).rejects.toThrow();
      } finally {
        await chmod(dir, 0o700);
        await rm(outDir, { recursive: true, force: true });
      }
    },
  );
});

describe('EncryptedFileSessionStore — a keyfile channel is "supplied", never "unset"', () => {
  it('an empty keyfile fails closed and does NOT fall through to the machine slot', async () => {
    await makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    }).save(material());

    const emptyKeyfile = join(dir, 'empty.key');
    await writeFile(emptyKeyfile, '', 'utf8');

    const reader = makeStore({
      directory: dir,
      keySource: { kind: 'keyfile', keyfilePath: emptyKeyfile },
      machineId: 'host-1',
    });
    expect(isErr(await reader.load(REF))).toBe(true);
  });

  it('a whitespace-only keyfile likewise fails closed (no fallthrough)', async () => {
    await makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    }).save(material());

    const blankKeyfile = join(dir, 'blank.key');
    await writeFile(blankKeyfile, '   \n\t', 'utf8');

    const reader = makeStore({
      directory: dir,
      keySource: { kind: 'keyfile', keyfilePath: blankKeyfile },
      machineId: 'host-1',
    });
    expect(isErr(await reader.load(REF))).toBe(true);
  });

  it('refuses an oversized keyfile before key derivation', async () => {
    await makeStore({
      directory: dir,
      keySource: { kind: 'machine' },
      machineId: 'host-1',
    }).save(material());
    const oversized = join(dir, 'oversized.key');
    await writeFile(oversized, Buffer.alloc(MAX_KEY_FILE_BYTES + 1));

    const reader = makeStore({
      directory: dir,
      keySource: { kind: 'keyfile', keyfilePath: oversized },
      machineId: 'host-1',
    });

    expect(isErr(await reader.load(REF))).toBe(true);
  });
});

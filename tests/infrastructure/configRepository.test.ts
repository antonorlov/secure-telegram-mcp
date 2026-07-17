/**
 * FileConfigRepository — contract tests for the ACL SSOT persistence adapter.
 *
 * The config file is the SINGLE SOURCE OF TRUTH for access control (#5), so this
 * adapter is a security boundary, not mere I/O. These tests assert the invariants
 * concretely against the REAL adapter + REAL Zod schema / scope-lint / mapper
 * (no mocking of the validation pipeline — that pipeline IS the thing under test):
 *
 *   1. FAIL-CLOSED reads      — any malformed / invalid / unreadable config makes
 *                               load() return Err (default-deny); never a partial
 *                               or "best effort" success.
 *   2. Scope-lint gates       — a 0-peer (empty) declared scope is a fail-closed
 *                               ERROR; risky-but-allowed shapes (write-without-HITL,
 *                               admin elevation) are surfaced as WARNINGS that do
 *                               not block. (The broadcast-channel write check is
 *                               intentionally deferred to BIND time per
 *                               src/config/scope-lint.ts — it needs network truth
 *                               (ChatInfoDto.isBroadcast) and is out of the static
 *                               lint's scope.)
 *   3. Lossless save          — save() round-trips a ValidatedConfig through the
 *                               file and back without drift, re-validates +
 *                               re-lints so it can never persist a file load()
 *                               would later reject, and writes 0600 (#8).
 *
 * Ports are exercised through real temp files; the only injected collaborator is
 * the `warn` sink, captured so we can assert what the operator is told.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileConfigRepository } from '../../src/infrastructure/config/file-config-repository.js';
import { configSchema } from '../../src/config/index.js';
import type { ValidatedConfig } from '../../src/config/index.js';
import { AppErrorCode } from '../../src/application/index.js';
import { isErr, isOk } from '../../src/shared/index.js';
import { PermissionVerb } from '../../src/domain/index.js';

// ---------------------------------------------------------------------------
// Per-test temp sandbox + small helpers (no shared mutable state across tests).
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tmcp-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const configPath = (): string => join(dir, 'config.json');

/** Serialize an arbitrary value to the config path and return the path. */
const writeRawConfig = async (value: unknown): Promise<string> => {
  const path = configPath();
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
  return path;
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * A fresh, valid on-disk config object each call. Exercises every chat/folder
 * shorthand ('me', '@username', numeric id, folder title, folder id) so the
 * lossless round-trip proof is meaningful, plus a kill-switch entry so the
 * daemon-wide deny-list is carried through to the domain.
 */
const validConfigObject = (): unknown => ({
  version: 1,
  killSwitch: { disabledVerbs: ['delete'] },
  endpoints: [
    {
      name: 'support-reader',
      session: 'main',
      tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      scope: {
        chats: ['@acme_support', '-1001234567890', 'me'],
        folders: ['Work', 2],
      },
      verbs: ['read', 'mark_read'],
      hitl: { confirmWrites: true },
    },
    {
      name: 'ops-bot',
      session: 'main',
      tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      scope: { chats: ['me'], folders: [2] },
      verbs: ['read', 'send', 'draft'],
      hitl: { confirmWrites: true },
    },
  ],
});

// ===========================================================================
// 1. Zod validation — fail-closed read path
// ===========================================================================

describe('FileConfigRepository — Zod validation (fail-closed read path)', () => {
  it('loads a valid config into domain endpoints + kill-switch', async () => {
    const path = await writeRawConfig(validConfigObject());
    const repo = new FileConfigRepository({ filePath: path });

    const result = await repo.load();

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }
    const { endpoints, killSwitch } = result.value;

    expect(endpoints.map((e) => e.name as string)).toEqual([
      'support-reader',
      'ops-bot',
    ]);

    const reader = endpoints.find((e) => e.name === 'support-reader');
    expect(reader).toBeDefined();
    expect(reader?.permits(PermissionVerb.Read)).toBe(true);
    expect(reader?.permits(PermissionVerb.MarkRead)).toBe(true);
    expect(reader?.permits(PermissionVerb.Send)).toBe(false);

    // Kill-switch is the daemon-wide deny-list intersected with each endpoint
    // (defence in depth) — it must survive the load as domain verbs.
    expect(killSwitch.disabledVerbs.has(PermissionVerb.Delete)).toBe(true);
    expect(killSwitch.disabledVerbs.has(PermissionVerb.Send)).toBe(false);
    // No maxDownloadBytes override in the fixture -> undefined (gateway default).
    expect(result.value.maxDownloadBytes).toBeUndefined();
  });

  it('surfaces the global maxDownloadBytes override through to LoadedConfiguration', async () => {
    const base = validConfigObject() as Record<string, unknown>;
    const path = await writeRawConfig({ ...base, maxDownloadBytes: 12 * 1024 * 1024 });
    const repo = new FileConfigRepository({ filePath: path });

    const result = await repo.load();

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.maxDownloadBytes).toBe(12 * 1024 * 1024);
    }
  });

  it('fails closed when the config file is missing', async () => {
    const repo = new FileConfigRepository({ filePath: join(dir, 'absent.json') });

    const result = await repo.load();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      // Config failures adapt to a non-Telegram VALIDATION code at the port.
      expect(result.error.code).toBe(AppErrorCode.Validation);
    }
  });

  it('fails closed on malformed JSON (no partial parse)', async () => {
    const path = configPath();
    await writeFile(path, '{ "version": 1, endpoints: ', 'utf8');
    const repo = new FileConfigRepository({ filePath: path });

    const result = await repo.load();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(AppErrorCode.Validation);
    }
  });

  it('fails closed on an unknown permission verb', async () => {
    const path = await writeRawConfig({
      version: 1,
      killSwitch: { disabledVerbs: [] },
      endpoints: [
        {
          name: 'rogue',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: { chats: ['me'], folders: [] },
          verbs: ['read', 'superuser'],
          hitl: { confirmWrites: true },
        },
      ],
    });
    const repo = new FileConfigRepository({ filePath: path });

    const result = await repo.load();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(AppErrorCode.Validation);
    }
  });

  it('fails closed on unknown top-level keys (strict schema — no smuggled fields)', async () => {
    const path = await writeRawConfig({
      version: 1,
      killSwitch: { disabledVerbs: [] },
      allowAll: true,
      endpoints: [
        {
          name: 'reader',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: { chats: ['me'], folders: [] },
          verbs: ['read'],
          hitl: { confirmWrites: true },
        },
      ],
    });
    const repo = new FileConfigRepository({ filePath: path });

    const result = await repo.load();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(AppErrorCode.Validation);
    }
  });

  it('fails closed on duplicate endpoint names (SSOT structural invariant)', async () => {
    const path = await writeRawConfig({
      version: 1,
      killSwitch: { disabledVerbs: [] },
      endpoints: [
        {
          name: 'dup',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: { chats: ['me'], folders: [] },
          verbs: ['read'],
          hitl: { confirmWrites: true },
        },
        {
          name: 'dup',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: { chats: ['me'], folders: [] },
          verbs: ['send'],
          hitl: { confirmWrites: true },
        },
      ],
    });
    const repo = new FileConfigRepository({ filePath: path });

    const result = await repo.load();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(AppErrorCode.Validation);
    }
  });

  it('fails closed when an endpoint grants zero verbs (least-privilege has a floor)', async () => {
    const path = await writeRawConfig({
      version: 1,
      killSwitch: { disabledVerbs: [] },
      endpoints: [
        {
          name: 'verbless',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: { chats: ['me'], folders: [] },
          verbs: [],
          hitl: { confirmWrites: true },
        },
      ],
    });
    const repo = new FileConfigRepository({ filePath: path });

    const result = await repo.load();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(AppErrorCode.Validation);
    }
  });
});

// ===========================================================================
// 2. Scope-lint — fail-closed errors vs. surfaced warnings
// ===========================================================================

describe('FileConfigRepository — scope-lint security gates', () => {
  it('fails closed when an endpoint declares neither chats nor folders (0-peer allow-list)', async () => {
    const warnings: string[] = [];
    const path = await writeRawConfig({
      version: 1,
      killSwitch: { disabledVerbs: [] },
      endpoints: [
        {
          name: 'empty-scope',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: { chats: [], folders: [] },
          verbs: ['read'],
          hitl: { confirmWrites: true },
        },
      ],
    });
    const repo = new FileConfigRepository({
      filePath: path,
      warn: (m): void => {
        warnings.push(m);
      },
    });

    const result = await repo.load();

    // An empty declared scope can only resolve to an empty (or, if careless,
    // allow-all) client — the lint rejects it BEFORE any network access.
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(AppErrorCode.Validation);
      expect(result.error.message.toLowerCase()).toContain('allow-list');
    }
  });

  it('does NOT warn for write-without-confirmation (opt-in default) and loads', async () => {
    // HITL confirmation is opt-in per endpoint and defaults OFF by design, so a
    // write endpoint with confirmWrites off is the sanctioned normal case and must
    // NOT produce a load-time warning (that would nag on the out-of-the-box config).
    const warnings: string[] = [];
    const path = await writeRawConfig({
      version: 1,
      killSwitch: { disabledVerbs: [] },
      endpoints: [
        {
          name: 'writer',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: { chats: ['me'], folders: [] },
          verbs: ['read', 'send'],
          hitl: { confirmWrites: false },
        },
      ],
    });
    const repo = new FileConfigRepository({
      filePath: path,
      warn: (m): void => {
        warnings.push(m);
      },
    });

    const result = await repo.load();

    expect(isOk(result)).toBe(true);
    expect(warnings.some((m) => m.includes('confirmWrites'))).toBe(false);
  });

  it('REJECTS an admin-tier verb — no longer accepted vocabulary (fail-closed)', async () => {
    const path = await writeRawConfig({
      version: 1,
      killSwitch: { disabledVerbs: [] },
      endpoints: [
        {
          name: 'elevated',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: { chats: ['me'], folders: [] },
          verbs: ['read', 'admin.read'],
          hitl: { confirmWrites: true },
        },
      ],
    });
    const repo = new FileConfigRepository({ filePath: path });

    const result = await repo.load();

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(AppErrorCode.Validation);
    }
  });

  it('emits no warnings for a clean least-privilege config', async () => {
    const warnings: string[] = [];
    const path = await writeRawConfig(validConfigObject());
    const repo = new FileConfigRepository({
      filePath: path,
      warn: (m): void => {
        warnings.push(m);
      },
    });

    const result = await repo.load();

    expect(isOk(result)).toBe(true);
    expect(warnings).toEqual([]);
  });
});

// ===========================================================================
// 3. Lossless save round-trip + at-rest hardening (#8)
// ===========================================================================

describe('FileConfigRepository — lossless save round-trip + at-rest hardening', () => {
  it('round-trips a validated config losslessly through save -> file -> load', async () => {
    const validated: ValidatedConfig = configSchema.parse(validConfigObject());
    const path = configPath();
    const repo = new FileConfigRepository({ filePath: path });

    const saved = await repo.save(validated);
    expect(isOk(saved)).toBe(true);
    if (isOk(saved)) {
      expect(saved.value).toBe(await readFile(path, 'utf8'));
    }

    // Re-parsing the persisted bytes through the SSOT schema must reproduce the
    // exact ValidatedConfig (no drift in chats/folders/verbs/kill-switch).
    const onDisk: unknown = JSON.parse(await readFile(path, 'utf8'));
    const reparsed = configSchema.parse(onDisk);
    expect(reparsed).toEqual(validated);

    // And the read path consumes our own write into the same domain shape.
    const loaded = await repo.load();
    expect(isOk(loaded)).toBe(true);
    if (isOk(loaded)) {
      expect(loaded.value.endpoints.map((e) => e.name as string)).toEqual([
        'support-reader',
        'ops-bot',
      ]);
      expect(
        loaded.value.killSwitch.disabledVerbs.has(PermissionVerb.Delete),
      ).toBe(true);
    }
  });

  it('writes the config file with 0600 (owner-only) permissions', async () => {
    const validated: ValidatedConfig = configSchema.parse(validConfigObject());
    const path = configPath();
    const repo = new FileConfigRepository({ filePath: path });

    expect(isOk(await repo.save(validated))).toBe(true);

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates missing parent directories on save', async () => {
    const validated: ValidatedConfig = configSchema.parse(validConfigObject());
    const nested = join(dir, 'nested', 'deep', 'config.json');
    const repo = new FileConfigRepository({ filePath: nested });

    const saved = await repo.save(validated);

    expect(isOk(saved)).toBe(true);
    expect(await fileExists(nested)).toBe(true);
  });

  it('refuses to persist a config the DOMAIN mapping rejects (@x) — save gates exactly like load', async () => {
    const base: ValidatedConfig = configSchema.parse(validConfigObject());
    // A hand-constructed 'x' username is too short for a real Telegram username
    // (the schema's PeerRef-factory transform rejects its '@x' serialization).
    // save() must run the SAME pipeline load() runs, or it would write a file
    // its own load() then refuses.
    const domainInvalid: ValidatedConfig = {
      ...base,
      endpoints: [
        {
          ...base.endpoints[0],
          scope: {
            chats: [{ kind: 'username', username: 'x' }],
            folders: [],
            chatOverrides: [],
          },
        },
      ],
    };
    const path = configPath();
    const repo = new FileConfigRepository({ filePath: path });

    const saved = await repo.save(domainInvalid);

    expect(isErr(saved)).toBe(true);
    if (isErr(saved)) {
      expect(saved.error.code).toBe(AppErrorCode.Validation);
      expect(saved.error.message).toContain('runtime would reject');
    }
    expect(await fileExists(path)).toBe(false);
  });

  it('refuses to persist a 0-peer config — fail-closed write, no file left behind', async () => {
    const base: ValidatedConfig = configSchema.parse(validConfigObject());
    // Type-valid (empty arrays) but lint-rejected at runtime: proves save()
    // re-lints rather than trusting the caller's static types.
    const emptyScope: ValidatedConfig = {
      ...base,
      endpoints: [
        { ...base.endpoints[0], scope: { chats: [], folders: [], chatOverrides: [] } },
      ],
    };
    const path = configPath();
    const repo = new FileConfigRepository({ filePath: path });

    const saved = await repo.save(emptyScope);

    expect(isErr(saved)).toBe(true);
    if (isErr(saved)) {
      expect(saved.error.code).toBe(AppErrorCode.Validation);
      expect(saved.error.message).toContain('Scope-lint');
    }
    // Nothing must be written when the guard rejects (no half-written ACL).
    expect(await fileExists(path)).toBe(false);
  });

  it('refuses to persist a structurally invalid config (duplicate names) — defence in depth', async () => {
    const base: ValidatedConfig = configSchema.parse(validConfigObject());
    const duplicated: ValidatedConfig = {
      ...base,
      endpoints: [base.endpoints[0], base.endpoints[0]],
    };
    const path = configPath();
    const repo = new FileConfigRepository({ filePath: path });

    const saved = await repo.save(duplicated);

    expect(isErr(saved)).toBe(true);
    if (isErr(saved)) {
      expect(saved.error.code).toBe(AppErrorCode.Validation);
      expect(saved.error.message).toContain('runtime would reject');
    }
    expect(await fileExists(path)).toBe(false);
  });
});

/**
 * loadExistingDraft — the setup editing baseline's fail-closed contract.
 *
 * Only a MISSING config.json is a first run (empty draft). Any other failure —
 * unreadable file, malformed JSON, non-object JSON — must be an ERROR the wizard
 * stops on: proceeding would start editing from an empty baseline, and the next
 * autosave would silently overwrite the operator's real config (endpoints,
 * scopes, token hashes) with just the new edits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadExistingDraft } from '../../src/presentation/cli/setup.js';
import { isErr, isOk } from '../../src/shared/index.js';

let dir: string;

const VALID = {
  version: 1,
  killSwitch: { disabledVerbs: ['delete'] },
  maxDownloadBytes: 1024,
  endpoints: [
    {
      name: 'reader',
      session: 'main',
      scope: { chats: ['me'], folders: [] },
      verbs: ['read'],
      hitl: { confirmWrites: true },
      tokenHash: `${'a'.repeat(32)}$${'b'.repeat(64)}`,
    },
  ],
};

describe('loadExistingDraft (fail-closed editing baseline)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'setup-draft-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a MISSING file is a first run: empty draft, no error', async () => {
    const r = await loadExistingDraft(join(dir, 'nope.json'));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.endpoints).toEqual([]);
      expect(r.value.disabledVerbs).toEqual([]);
    }
  });

  it('a valid config round-trips into the draft (endpoints, kill-switch, download cap)', async () => {
    const p = join(dir, 'config.json');
    await writeFile(p, JSON.stringify(VALID));
    const r = await loadExistingDraft(p);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.endpoints).toHaveLength(1);
      expect(r.value.endpoints[0]?.name).toBe('reader');
      expect(r.value.disabledVerbs).toEqual(['delete']);
      expect(r.value.maxDownloadBytes).toBe(1024);
    }
  });

  it('uses the shared normalized DTO for trimmed refs and schema defaults', async () => {
    const p = join(dir, 'config.json');
    await writeFile(
      p,
      JSON.stringify({
        version: 1,
        endpoints: [
          {
            name: 'reader',
            session: 'main',
            scope: { chats: ['  @example_user  '], folders: [] },
            verbs: ['read'],
            tokenHash: `${'a'.repeat(32)}$${'b'.repeat(64)}`,
          },
        ],
      }),
    );

    const loaded = await loadExistingDraft(p);

    expect(isOk(loaded)).toBe(true);
    if (isOk(loaded)) {
      expect(loaded.value.disabledVerbs).toEqual([]);
      // Trimmed + normalised into the schema's domain PeerRef form.
      expect(loaded.value.endpoints[0]?.chats).toEqual([
        { kind: 'username', username: 'example_user' },
      ]);
      expect(loaded.value.endpoints[0]?.confirmWrites).toBe(false);
    }
  });

  it('MALFORMED JSON is an error, never an empty draft (autosave would clobber the file)', async () => {
    const p = join(dir, 'config.json');
    // A single-character typo away from valid — exactly the hand-edit case.
    await writeFile(p, `${JSON.stringify(VALID)}}`);
    const r = await loadExistingDraft(p);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error).toContain('not valid JSON');
    }
  });

  it('non-object JSON (array / scalar) is an error, never an empty draft', async () => {
    const p = join(dir, 'config.json');
    await writeFile(p, '[1,2,3]');
    expect(isErr(await loadExistingDraft(p))).toBe(true);
    await writeFile(p, '"hello"');
    expect(isErr(await loadExistingDraft(p))).toBe(true);
  });

  it('SCHEMA-INVALID objects are errors — never a silently empty/gutted baseline', async () => {
    const p = join(dir, 'config.json');
    // Valid JSON, wrong shape: the lenient extraction used to yield ZERO
    // endpoints and the next autosave clobbered the file.
    await writeFile(p, JSON.stringify({ version: 1, endpoints: 'typo' }));
    const r = await loadExistingDraft(p);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error).toContain('invalid');
      expect(r.error).toContain('endpoints');
    }
  });

  it('an endpoint entry damaged out of shape (name deleted) is an error, not a silent drop', async () => {
    const p = join(dir, 'config.json');
    const damaged = {
      ...VALID,
      endpoints: [{ ...VALID.endpoints[0], name: undefined }],
    };
    await writeFile(p, JSON.stringify(damaged));
    expect(isErr(await loadExistingDraft(p))).toBe(true);
  });

  it('an UNREADABLE path (a directory) is an error, never an empty draft', async () => {
    // readFile on a directory fails with EISDIR — a stand-in for any non-ENOENT
    // read failure (EACCES etc.), which must stop setup rather than blank the draft.
    const r = await loadExistingDraft(dir);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error).toContain('could not read');
    }
  });

  it('rejects an oversized config before parsing it', async () => {
    const p = join(dir, 'config.json');
    await writeFile(p, ' '.repeat(4 * 1024 * 1024 + 1));

    const loaded = await loadExistingDraft(p);

    expect(isErr(loaded)).toBe(true);
    if (isErr(loaded)) {
      expect(loaded.error).toContain('size ceiling');
    }
  });

  it('SCHEMA-VALID but RUNTIME-INVALID configs are errors (setup gates like the runtime)', async () => {
    // Each of these passes the Zod schema yet fails the shared schema/lint/domain
    // pipeline the daemon loads through. A weaker setup gate would adopt them as
    // the baseline and re-save a config the runtime then refuses to load.
    const p = join(dir, 'config.json');
    const withScope = (scope: unknown): unknown => ({
      ...VALID,
      endpoints: [{ ...VALID.endpoints[0], scope }],
    });

    // A username too short for Telegram (the domain PeerRef rejects it).
    await writeFile(p, JSON.stringify(withScope({ chats: ['@x'], folders: [] })));
    expect(isErr(await loadExistingDraft(p))).toBe(true);

    // Chat id 0 is never a valid peer (the domain ChatId rejects it).
    await writeFile(p, JSON.stringify(withScope({ chats: ['0'], folders: [] })));
    expect(isErr(await loadExistingDraft(p))).toBe(true);

    // An empty scope fails the scope-lint (a 0-peer endpoint is fail-closed).
    await writeFile(p, JSON.stringify(withScope({ chats: [], folders: [] })));
    expect(isErr(await loadExistingDraft(p))).toBe(true);
  });
});

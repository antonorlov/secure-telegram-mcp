import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileAuditLog,
} from '../../src/infrastructure/index.js';
import type { AuditRecord } from '../../src/application/index.js';
import { PermissionVerb, type EndpointNameValue } from '../../src/domain/index.js';
import { isOk, isErr } from '../../src/shared/index.js';

const record = (): AuditRecord => ({
  timestampIso: '2026-01-01T00:00:00.000Z',
  endpointName: 'e1' as EndpointNameValue,
  verb: PermissionVerb.Send,
  outcome: 'allow',
});

describe('FileAuditLog — append-only sink + loud failures (M19)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tmcp-audit-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one NDJSON line and never raises the failure alarm on success', async () => {
    const alarms: string[] = [];
    const log = new FileAuditLog({
      filePath: join(dir, 'audit.log'),
      onAppendFailure: (r): void => {
        alarms.push(r);
      },
    });

    expect(isOk(await log.append(record()))).toBe(true);

    const lines = (await readFile(join(dir, 'audit.log'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? '{}') as { verb: string }).verb).toBe('send');
    expect(alarms).toEqual([]);
  });

  it('drain waits for every append already admitted', async () => {
    const path = join(dir, 'audit.log');
    const log = new FileAuditLog({ filePath: path });
    const writes = [log.append(record()), log.append(record()), log.append(record())];

    await log.drain();

    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(3);
    expect((await Promise.all(writes)).every(isOk)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'tightens an existing audit file to owner-only permissions',
    async () => {
      const path = join(dir, 'audit.log');
      await writeFile(path, '');
      await chmod(path, 0o666);

      const log = new FileAuditLog({ filePath: path });
      expect(isOk(await log.append(record()))).toBe(true);

      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
  );

  it('a failed append is LOUD, errno-only, and alarms ONCE per failure streak', async () => {
    // A regular file where a directory is expected makes `ensureReady` fail, so
    // every append fails deterministically (no real disk-full needed).
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x');
    const alarms: string[] = [];
    const log = new FileAuditLog({
      filePath: join(blocker, 'sub', 'audit.log'),
      onAppendFailure: (r): void => {
        alarms.push(r);
      },
    });

    const r1 = await log.append(record());
    const r2 = await log.append(record());

    expect(isErr(r1)).toBe(true);
    expect(isErr(r2)).toBe(true);
    // Signalled exactly ONCE for the streak (not once per lost record)...
    expect(alarms).toHaveLength(1);
    // ...and the signal is errno-only — never leaks the path or record content.
    expect(alarms[0] ?? '').not.toContain(blocker);
  });
});

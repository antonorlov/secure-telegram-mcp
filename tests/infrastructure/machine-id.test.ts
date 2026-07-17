/**
 * SystemMachineIdReader — unit tests over a FAKE {@link HostProbe} (DIP). No real
 * OS, no native dep: we simulate Linux/macOS/Windows hosts and assert (a) the
 * per-OS machine-id extraction & dbus fallback, (b) placeholder/cleared ids
 * collapse to `undefined` (fail-closed steering), and (c) a DIFFERENT injected
 * probe yields a DIFFERENT id (the machine-binding mismatch seam).
 */
import { describe, it, expect } from 'vitest';
import {
  SystemMachineIdReader,
  type HostProbe,
} from '../../src/infrastructure/session/machine-id.js';

interface FakeHost {
  readonly platform: NodeJS.Platform;
  readonly files?: Readonly<Record<string, string>>;
  readonly commands?: Readonly<Record<string, string>>;
}

/** Build an in-memory probe; absent files/commands resolve to `undefined`. */
const fakeProbe = (host: FakeHost): HostProbe => ({
  platform: host.platform,
  readText: (path: string): Promise<string | undefined> =>
    Promise.resolve(host.files?.[path]),
  run: (command: string, args: readonly string[]): Promise<string | undefined> =>
    Promise.resolve(host.commands?.[[command, ...args].join(' ')]),
});

const IOREG_KEY = '/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice';
const REG_KEY =
  'reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid';

describe('SystemMachineIdReader', () => {
  it('reads /etc/machine-id on Linux', async () => {
    const reader = new SystemMachineIdReader(
      fakeProbe({
        platform: 'linux',
        files: { '/etc/machine-id': 'abc123def456\n' },
      }),
    );
    expect(await reader.read()).toBe('abc123def456');
  });

  it('falls back to the dbus machine-id when /etc/machine-id is absent', async () => {
    const reader = new SystemMachineIdReader(
      fakeProbe({
        platform: 'linux',
        files: { '/var/lib/dbus/machine-id': 'dbusid0001' },
      }),
    );
    expect(await reader.read()).toBe('dbusid0001');
  });

  it('treats an empty (cleared) machine-id as no id — fail-closed', async () => {
    const reader = new SystemMachineIdReader(
      fakeProbe({ platform: 'linux', files: { '/etc/machine-id': '\n' } }),
    );
    expect(await reader.read()).toBeUndefined();
  });

  it('rejects an all-zero placeholder id', async () => {
    const reader = new SystemMachineIdReader(
      fakeProbe({
        platform: 'linux',
        files: { '/etc/machine-id': '00000000000000000000000000000000' },
      }),
    );
    expect(await reader.read()).toBeUndefined();
  });

  it('parses IOPlatformUUID on macOS', async () => {
    const reader = new SystemMachineIdReader(
      fakeProbe({
        platform: 'darwin',
        commands: {
          [IOREG_KEY]:
            '  "IOPlatformUUID" = "11111111-2222-3333-4444-555555555555"',
        },
      }),
    );
    expect(await reader.read()).toBe(
      '11111111-2222-3333-4444-555555555555',
    );
  });

  it('parses MachineGuid on Windows', async () => {
    const reader = new SystemMachineIdReader(
      fakeProbe({
        platform: 'win32',
        commands: {
          [REG_KEY]:
            'HKEY_LOCAL_MACHINE\\...\\Cryptography\n    MachineGuid    REG_SZ    deadbeef-0000-1111-2222-333344445555',
        },
      }),
    );
    expect(await reader.read()).toBe('deadbeef-0000-1111-2222-333344445555');
  });

  it('returns undefined on an unsupported platform', async () => {
    const reader = new SystemMachineIdReader(
      fakeProbe({ platform: 'freebsd' }),
    );
    expect(await reader.read()).toBeUndefined();
  });
});

/**
 * Stable per-host machine id (Linux `/etc/machine-id` with a dbus fallback, macOS
 * `IOPlatformUUID`, Windows `MachineGuid`), used as the KEK input for the machine slot — each
 * blob still adds its own salt. It is not a secret, never touches MAC or IP, and needs no
 * native dependency.
 * `normaliseId` FAILS CLOSED on the real footgun: an empty machine-id or an all-zero UUID — a
 * template awaiting first-boot regeneration — collapses to `undefined`, so the store refuses to
 * seal against a non-identifying id and steers the operator to a PIN.
 */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// `undefined` when the host exposes none; the caller then fails closed and steers the operator
// to a PIN.
export interface MachineIdReader {
  read(): Promise<string | undefined>;
}

// Every method is TOTAL: it never throws and never leaks a secret — absence or failure
// collapses to `undefined`.
export interface HostProbe {
  readonly platform: NodeJS.Platform;
  readText(path: string): Promise<string | undefined>;
  run(command: string, args: readonly string[]): Promise<string | undefined>;
}

// Hard cap so a hung or forked probe can never wedge setup.
const PROBE_TIMEOUT_MS = 2_000;
// Probe stdout is tiny; cap the buffer to refuse pathological output.
const PROBE_MAX_BUFFER = 64 * 1024;

// `run` uses execFile with no shell, to avoid injection.
export const nodeHostProbe = (): HostProbe => ({
  platform: process.platform,
  readText: async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  run: async (
    command: string,
    args: readonly string[],
  ): Promise<string | undefined> => {
    try {
      const { stdout } = await execFileAsync(command, [...args], {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      });
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  },
});

// An empty machine-id or an all-zero UUID signals a template or uninitialised host rather than
// a real install; compared lowercase.
const PLACEHOLDER_IDS: ReadonlySet<string> = new Set([
  '',
  'uninitialized',
  '00000000000000000000000000000000',
  '00000000-0000-0000-0000-000000000000',
]);

const normaliseId = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (PLACEHOLDER_IDS.has(value.toLowerCase())) return undefined;
  return value;
};

const LINUX_MACHINE_ID_PATHS: readonly string[] = [
  '/etc/machine-id',
  '/var/lib/dbus/machine-id',
];

// Concrete per-OS {@link MachineIdReader}. Pure over an injected {@link HostProbe} (default:
// {@link nodeHostProbe}); inject a fake to simulate a different host.
export class SystemMachineIdReader implements MachineIdReader {
  private readonly probe: HostProbe;

  public constructor(probe: HostProbe = nodeHostProbe()) {
    this.probe = probe;
  }

  public async read(): Promise<string | undefined> {
    switch (this.probe.platform) {
      case 'linux':
        return this.readLinux();
      case 'darwin':
        return this.readDarwin();
      case 'win32':
        return this.readWindows();
      default:
        return undefined;
    }
  }

  private async readLinux(): Promise<string | undefined> {
    for (const path of LINUX_MACHINE_ID_PATHS) {
      const id = normaliseId(await this.probe.readText(path));
      if (id !== undefined) return id;
    }
    return undefined;
  }

  private async readDarwin(): Promise<string | undefined> {
    const out = await this.probe.run('/usr/sbin/ioreg', [
      '-rd1',
      '-c',
      'IOPlatformExpertDevice',
    ]);
    const match = out?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    return normaliseId(match?.[1]);
  }

  private async readWindows(): Promise<string | undefined> {
    const out = await this.probe.run('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
    ]);
    const match = out?.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/);
    return normaliseId(match?.[1]);
  }
}

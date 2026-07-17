/**
 * Host machine-id reader for the SMOOTH posture. Yields a STABLE, per-host
 * machine identifier (Linux `/etc/machine-id` -> dbus fallback, macOS
 * `IOPlatformUUID`, Windows `MachineGuid`), used as the KEK input for the
 * machine slot (each blob adds its own fresh salt). It is NOT a secret, it
 * NEVER touches MAC/IP, and it has NO native dep.
 *
 * `normaliseId` FAILS CLOSED on the real footgun: an empty/cleared machine-id or
 * an all-zero UUID (a template/golden image awaiting first-boot regeneration)
 * collapses to `undefined`, so the store refuses to seal/unlock a machine slot
 * against a non-identifying id and steers the operator to a PIN.
 *
 * Depends on the small injectable {@link HostProbe} seam (platform + file/command
 * reads), so tests can simulate a different machine. The probe is the ONLY part
 * bound to `node:*`; the reader is pure over it.
 */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The stable machine id for this install, or `undefined` when the host exposes
 * none (caller then fails closed / steers the operator to a PIN). The concrete
 * per-OS reader is injected so the mismatch path is testable without the host.
 */
export interface MachineIdReader {
  read(): Promise<string | undefined>;
}

/**
 * The injected OS seam. Every method is TOTAL — it NEVER throws and NEVER leaks a
 * secret; absence/failure collapses to `undefined`.
 */
export interface HostProbe {
  readonly platform: NodeJS.Platform;
  /** Read a UTF-8 file; `undefined` when absent/unreadable. */
  readText(path: string): Promise<string | undefined>;
  /** Run a command (NO shell) capturing trimmed stdout; `undefined` on failure. */
  run(command: string, args: readonly string[]): Promise<string | undefined>;
}

/** Hard cap so a hung/forked probe can never wedge setup. */
const PROBE_TIMEOUT_MS = 2_000;
/** Probe stdout is tiny; cap the buffer to refuse pathological output. */
const PROBE_MAX_BUFFER = 64 * 1024;

/**
 * Production {@link HostProbe} over `node:*`. The only `node:fs`/`child_process`
 * binding in this module. `run` uses `execFile` (no shell) to avoid injection.
 */
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

/**
 * Placeholder ids that scrypt-binding to would be a footgun: an empty/cleared
 * machine-id, or an all-zero UUID, signal a template/uninitialised host rather
 * than a real install. Normalised to lowercase before comparison.
 */
const PLACEHOLDER_IDS: ReadonlySet<string> = new Set([
  '',
  'uninitialized',
  '00000000000000000000000000000000',
  '00000000-0000-0000-0000-000000000000',
]);

/** Trim + collapse to a real id, or `undefined` for blank/placeholder values. */
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

/**
 * Concrete per-OS {@link MachineIdReader}. Pure over an injected {@link HostProbe}
 * (default: {@link nodeHostProbe}); inject a fake to simulate a different host.
 */
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

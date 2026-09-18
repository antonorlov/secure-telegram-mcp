// A disposable world for socket-level suites: sealed state on a temp dir, an in-process daemon
// with guaranteed shutdown, and the clean-room env a spawned CLI should inherit.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  daemonAddress,
  EncryptedFileSessionStore,
  type TelegramClientFactory,
} from '../../src/infrastructure/index.js';
import { FileConfigRepository } from '../../src/infrastructure/config/file-config-repository.js';
import { SealedPolicyRepository } from '../../src/infrastructure/config/sealed-policy-repository.js';
import { SessionRef } from '../../src/domain/index.js';
import { OperatorClient } from '../../src/presentation/operator/client.js';
import { CHEAP_KDF } from './socket-mcp-client.js';
import { DaemonHarness } from './daemon-harness.js';
import {
  assertNoPlaintextSecrets,
  type SecretSpec,
  type Surfaces,
} from './leak-detector.js';

// The synthetic credentials every world seals; exported so leak checks can look for them.
export const SESSION_STRING = '1ApWaPpa.Telegram.SESSION.string';
export const API_HASH = 'deadbeefcafedeadbeefcafedeadbeef';

export interface SeedInput {
  readonly config: unknown;
  readonly sessionRefs: readonly string[];
  readonly pin: string;
}

export interface StartInput {
  readonly clientFactory?: TelegramClientFactory;
}

export class E2EWorld {
  private readonly operators: OperatorClient[] = [];
  private harness: DaemonHarness | undefined;
  // Daemons this world already stopped: a restart case still needs their log and exit code.
  private readonly retired: DaemonHarness[] = [];
  // One disposal and one shutdown, shared by every caller — an `afterEach` and a `finally`
  // often race, and a fixture that lets the second caller past a draining daemon deletes the
  // state directory out from under it.
  private disposing: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  private constructor(
    public readonly dir: string,
    public readonly sessionDir: string,
    public readonly configPath: string,
    public readonly mediaDir: string,
    public readonly auditPath: string,
  ) {}

  public static async create(prefix: string): Promise<E2EWorld> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    return new E2EWorld(
      dir,
      join(dir, 'secrets'),
      join(dir, 'config.json'),
      join(dir, 'media'),
      join(dir, 'audit.log'),
    );
  }

  // Writes the draft and seals it, plus one session blob per ref, exactly as login.commit would.
  public async seal(input: SeedInput): Promise<void> {
    await writeFile(this.configPath, JSON.stringify(input.config));
    const store = new EncryptedFileSessionStore({
      directory: this.sessionDir,
      keySource: { kind: 'passphrase', passphrase: input.pin },
      kdf: CHEAP_KDF,
    });
    for (const ref of input.sessionRefs) {
      const parsed = SessionRef.create(ref);
      if (!parsed.ok) throw new Error(`invalid test session ref: ${ref}`);
      const saved = await store.save({
        sessionRef: parsed.value,
        secret: SESSION_STRING,
        apiId: 1234567,
        apiHash: API_HASH,
      });
      if (!saved.ok) throw new Error(`could not seal session ${ref}`);
    }
    const sealed = await store.savePolicy(await readFile(this.configPath));
    if (!sealed.ok) throw new Error('could not seal the policy');
  }

  public async startDaemon(input: StartInput = {}): Promise<void> {
    const parser = new FileConfigRepository({ filePath: this.configPath });
    this.harness = await DaemonHarness.start({
      makeConfigRepository: (store) =>
        new SealedPolicyRepository({ configPath: this.configPath, parser, store }),
      plainConfigRepository: parser,
      configParser: parser,
      sessionDir: this.sessionDir,
      sessionKey: { kind: 'machine' },
      auditLogPath: this.auditPath,
      mediaRootDir: this.mediaDir,
      ...(input.clientFactory !== undefined
        ? { clientFactory: input.clientFactory }
        : {}),
    });
  }

  public address(): string {
    return daemonAddress(this.sessionDir);
  }

  // Authenticates the operator plane, which is what opens the gate on a hardened store.
  public async unlock(pin: string): Promise<OperatorClient> {
    const operator = new OperatorClient({
      sessionDir: this.sessionDir,
      daemonCommand: { execPath: process.execPath, args: ['-e', ''] },
    });
    this.operators.push(operator);
    const connected = await operator.connect();
    if (!connected.ok) throw new Error('operator connect failed');
    const authenticated = await operator.authenticate({
      kind: 'passphrase',
      passphrase: pin,
    });
    if (!authenticated.ok) throw new Error('operator authentication failed');
    return operator;
  }

  /**
   * The env a spawned CLI inherits: PATH plus what the case sets, never the ambient TELEGRAM_*.
   * Every path is explicit AND `HOME` points into the world, so a child that falls back to a
   * default path lands here rather than in the operator's real state directory.
   */
  public childEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
    return {
      PATH: process.env['PATH'] ?? '',
      HOME: this.dir,
      TELEGRAM_MCP_SESSION_DIR: this.sessionDir,
      TELEGRAM_MCP_CONFIG: this.configPath,
      TELEGRAM_MCP_AUDIT_LOG: this.auditPath,
      TELEGRAM_MCP_MEDIA_DIR: this.mediaDir,
      ...extra,
    };
  }

  /**
   * Stops the daemon but keeps every sealed byte on disk, so a case can start a new one over
   * the same state — the only way to tell a live cache from what actually persisted.
   */
  public async stopDaemon(): Promise<void> {
    const harness = this.harness;
    if (harness === undefined) {
      // A shutdown already owns this daemon: join it instead of racing ahead of the drain.
      await this.stopping;
      return;
    }
    this.harness = undefined;
    this.retired.push(harness);
    for (const operator of this.operators) operator.close();
    this.operators.length = 0;
    this.stopping = harness.stop();
    await this.stopping;
  }

  /**
   * Runs whether or not assertions passed: a leaked daemon outlives the case that started it.
   * The directory goes even when shutdown failed; the reason is raised afterwards.
   */
  public dispose(): Promise<void> {
    this.disposing ??= this.runDispose();
    return this.disposing;
  }

  private async runDispose(): Promise<void> {
    let failure: Error | undefined;
    try {
      // Performs the shutdown or joins one in flight; the directory goes only after it ends.
      await this.stopDaemon();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(JSON.stringify(error));
    }
    for (const operator of this.operators) operator.close();
    this.operators.length = 0;
    await rm(this.dir, { recursive: true, force: true });
    if (failure !== undefined) throw failure;
  }

  // The live daemon's, or the last one this world stopped.
  public exitCodes(): readonly number[] {
    return (this.harness ?? this.retired[this.retired.length - 1])?.exitCodes() ?? [];
  }

  public ownedHandlerCount(): number {
    return this.harness?.ownedHandlerCount() ?? 0;
  }

  // Every daemon this world ran, so a restart case still scans what the first one logged.
  public daemonLog(): string {
    return [...this.retired, ...(this.harness !== undefined ? [this.harness] : [])]
      .flatMap((harness) => harness.logLines())
      .join('\n');
  }

  // Sweeps the whole world directory plus the given transcripts; the daemon log is always in.
  public assertNoLeaks(
    secrets: readonly SecretSpec[],
    surfaces: Surfaces = {},
  ): Promise<number> {
    return assertNoPlaintextSecrets({
      root: this.dir,
      secrets,
      surfaces: { 'the daemon log': this.daemonLog(), ...surfaces },
    });
  }
}

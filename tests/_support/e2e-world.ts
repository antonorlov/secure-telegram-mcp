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
  // One disposal, shared by every caller — an `afterEach` and a `finally` often race.
  private disposing: Promise<void> | undefined;

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

  // The env a spawned CLI inherits: PATH plus what the case sets, never the ambient TELEGRAM_*.
  public childEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
    return {
      PATH: process.env['PATH'] ?? '',
      TELEGRAM_MCP_SESSION_DIR: this.sessionDir,
      TELEGRAM_MCP_CONFIG: this.configPath,
      ...extra,
    };
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
    for (const operator of this.operators) operator.close();
    this.operators.length = 0;
    let failure: Error | undefined;
    try {
      // Kept after disposal: a case still reads its exit code and log to assert the shutdown.
      await this.harness?.stop();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(JSON.stringify(error));
    }
    await rm(this.dir, { recursive: true, force: true });
    if (failure !== undefined) throw failure;
  }

  public exitCodes(): readonly number[] {
    return this.harness?.exitCodes() ?? [];
  }

  public ownedHandlerCount(): number {
    return this.harness?.ownedHandlerCount() ?? 0;
  }

  public daemonLog(): string {
    return (this.harness?.logLines() ?? []).join('\n');
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

import { readFile } from 'node:fs/promises';

import {
  AppErrorCode,
  appError,
  PolicyApplicationService,
  SessionGate,
  type AppError,
  type ConfigRepository,
  type SessionKeySource,
} from '../../../src/application/index.js';
import {
  EncryptedFileSessionStore,
  type SessionKdfProfile,
} from '../../../src/infrastructure/index.js';
import { FileConfigRepository } from '../../../src/infrastructure/config/file-config-repository.js';
import { err, type Result } from '../../../src/shared/index.js';

const unusedRepository: ConfigRepository = {
  load: () =>
    Promise.resolve(
      err(appError(AppErrorCode.NotFound, 'no boot policy in test apply helper')),
    ),
};

/** Exercise the production validate -> seal -> publish use case with cheap test KDFs. */
export const applyConfigDraftForTest = async (input: {
  readonly configPath: string;
  readonly sessionDir: string;
  readonly source: SessionKeySource;
  readonly kdf: SessionKdfProfile;
}): Promise<Result<void, AppError>> => {
  const store = new EncryptedFileSessionStore({
    directory: input.sessionDir,
    keySource: input.source,
    kdf: input.kdf,
  });
  const parser = new FileConfigRepository({
    filePath: input.configPath,
    warn: (): void => undefined,
  });
  const gate = new SessionGate(
    store,
    unusedRepository,
    { endpoints: [], killSwitch: { disabledVerbs: new Set() } },
  );
  const raw = await readFile(input.configPath);
  return new PolicyApplicationService(parser, store, gate).apply(raw);
};

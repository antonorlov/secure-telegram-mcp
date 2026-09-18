// Sweeps everything a case produced for plaintext secrets. Several secrets travel by design —
// the endpoint key reaches `connect` through the environment, a PIN may sit in its own 0600
// file — so each one carries the places it is allowed to appear.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface SecretSpec {
  readonly label: string;
  readonly value: string;
  // Paths, relative to the world root, where this secret legitimately lives.
  readonly allowedPaths?: readonly string[];
}

// Free-form transcripts by label: PTY scrollback, a child's stderr, captured daemon log lines.
export type Surfaces = Readonly<Record<string, string>>;

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) out.push(...(await walk(full)));
    else if (info.isFile()) out.push(full);
  }
  return out;
};

// Throws with the offending place named; returns the number of files it inspected.
export const assertNoPlaintextSecrets = async (input: {
  readonly root: string;
  readonly secrets: readonly SecretSpec[];
  readonly surfaces?: Surfaces;
}): Promise<number> => {
  for (const [label, text] of Object.entries(input.surfaces ?? {})) {
    for (const secret of input.secrets) {
      if (secret.value.length > 0 && text.includes(secret.value)) {
        throw new Error(`${secret.label} leaked into ${label}`);
      }
    }
  }
  const files = await walk(input.root);
  for (const file of files) {
    const rel = relative(input.root, file);
    const text = (await readFile(file)).toString('utf8');
    for (const secret of input.secrets) {
      if (secret.value.length === 0 || !text.includes(secret.value)) continue;
      if ((secret.allowedPaths ?? []).includes(rel)) continue;
      throw new Error(`${secret.label} leaked into ${rel}`);
    }
  }
  return files.length;
};

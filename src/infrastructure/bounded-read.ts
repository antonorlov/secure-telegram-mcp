/**
 * Bounded UTF-8 reads for OPERATOR-OWNED artifacts (config.json / the sealed
 * policy / session envelopes): stat the OPEN handle first (no stat-then-read
 * TOCTOU) and refuse to slurp a file beyond its ceiling, so a corrupt or
 * same-uid-tampered file cannot balloon memory before `JSON.parse` runs. No layer
 * vocabulary here — callers map {@link FileTooLargeError} to their own secret-free
 * error, and ENOENT propagates as the usual errno error.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Maximum plaintext config/draft bytes accepted from disk or the operator. */
export const MAX_POLICY_PLAINTEXT_BYTES = 4 * 1024 * 1024;

/**
 * Encrypted envelopes base64-expand their plaintext by 4/3 and add slot metadata.
 * Keeping this distinct from the plaintext ceiling guarantees that every accepted
 * policy can be sealed and read back after restart.
 */
export const MAX_ENCRYPTED_BLOB_BYTES = 6 * 1024 * 1024;

/** A 4096-byte passphrase plus the optional trailing CRLF accepted by *_FILE. */
export const MAX_PASSPHRASE_FILE_BYTES = 4 * 1024 + 2;

/** Compatibility ceiling for arbitrary operator-generated key material. */
export const MAX_KEY_FILE_BYTES = 1024 * 1024;

/** True when a caught value is a Node errno error with the given `code`. */
export const hasErrnoCode = (e: unknown, code: string): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;

/** Thrown when a file exceeds its read ceiling. Carries sizes, never content. */
export class FileTooLargeError extends Error {
  public constructor(byteLength: number, maxBytes: number) {
    super(
      `file is ${String(byteLength)} bytes; the read ceiling is ${String(maxBytes)}`,
    );
    this.name = 'FileTooLargeError';
  }
}

/** Thrown when a path is not a regular file (devices/FIFOs must never be slurped). */
export class NotRegularFileError extends Error {
  public constructor() {
    super('path is not a regular file');
    this.name = 'NotRegularFileError';
  }
}

/**
 * Read one regular file through its already-open handle and enforce `maxBytes`
 * before allocation. A concurrent in-place size change fails closed; application
 * writers use atomic rename, so legitimate reads always see a stable inode.
 */
export const readRegularFileBounded = async (
  filePath: string,
  maxBytes: number,
): Promise<Buffer> => {
  // O_NONBLOCK prevents a FIFO path from hanging before fstat can reject it.
  // It has no behavioral effect for ordinary regular files.
  const handle = await open(
    filePath,
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NONBLOCK,
  );
  let bytes: Buffer | undefined;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new NotRegularFileError();
    if (stats.size > maxBytes) {
      throw new FileTooLargeError(stats.size, maxBytes);
    }

    bytes = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }

    const probe = Buffer.alloc(1);
    const extra = await handle.read(probe, 0, 1, offset);
    probe.fill(0);
    if (extra.bytesRead > 0) {
      throw new FileTooLargeError(Math.max(stats.size + 1, maxBytes + 1), maxBytes);
    }

    if (offset === bytes.length) {
      const result = bytes;
      bytes = undefined;
      return result;
    }
    const shortened = Buffer.from(bytes.subarray(0, offset));
    bytes.fill(0);
    bytes = undefined;
    return shortened;
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
};

/** Read a UTF-8 file, refusing files over `maxBytes` (default: the ceiling). */
export const readUtf8Bounded = async (
  filePath: string,
  maxBytes: number = MAX_POLICY_PLAINTEXT_BYTES,
): Promise<string> => {
  const bytes = await readRegularFileBounded(filePath, maxBytes);
  try {
    return bytes.toString('utf8');
  } finally {
    bytes.fill(0);
  }
};

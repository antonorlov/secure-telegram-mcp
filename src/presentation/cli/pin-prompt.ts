/**
 * pin-prompt — a masked one-line TTY secret reader for the daemon unlock path. Deliberately
 * Ink-free: the daemon graph must never load React, and 30 lines of raw-mode readline are all
 * this job needs. Streams are injected so tests drive it with plain PassThroughs.
 */
import type { ReadStream } from 'node:tty';

export interface PinPromptStreams {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

/** Read one masked line (echoes `*`). Resolves undefined on Ctrl-C/EOF. */
export const promptPin = (
  title: string,
  streams: PinPromptStreams,
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const { input, output } = streams;
    const tty = input as ReadStream;
    const raw = typeof tty.setRawMode === 'function';
    if (raw) tty.setRawMode(true);
    output.write(title);
    let value = '';
    const done = (result: string | undefined): void => {
      input.off('data', onData);
      if (raw) tty.setRawMode(false);
      // Release the stream: on('data')/raw mode leave process.stdin flowing AND
      // event-loop-REFERENCED, so without this the unlock command hangs after
      // "Unlocked" until Ctrl-C. A fresh stdin starts paused, so this also leaves
      // it as we found it. No-op-safe for the test PassThroughs.
      input.pause();
      output.write('\n');
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { done(value.normalize('NFC')); return; }
        if (ch === '\u0003' || ch === '\u0004') { done(undefined); return; } // ^C/^D
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        value += ch;
        output.write('*');
      }
    };
    input.on('data', onData);
    // A prior prompt's cleanup leaves the stream EXPLICITLY paused, and Node
    // does NOT auto-resume an explicitly-paused stream when a 'data' listener
    // attaches — without this, the attempt-2 re-prompt after "Wrong PIN." reads
    // nothing, the event loop drains, and the process exits (code 0!) leaving a
    // dangling "PIN: ". No-op when the stream is already flowing.
    input.resume();
  });

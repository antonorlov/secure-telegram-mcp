import { Logger, LogLevel } from 'telegram/extensions/Logger.js';

/**
 * A GramJS logger silenced to {@link LogLevel.NONE}.
 *
 * GramJS otherwise prints its own diagnostic lines ("Running gramJS version …",
 * "Connecting to …", "Using LAYER …") via `console` on construct/connect. That is
 * bypasses the application's diagnostic sink, so every `TelegramClient` in this
 * app is built with this `baseLogger`. Intentional diagnostics flow through the
 * daemon logger instead.
 *
 * A fresh instance per call keeps clients independent (a Logger carries mutable
 * level state); the returned logger never emits.
 */
export const silentGramjsLogger = (): Logger => new Logger(LogLevel.NONE);

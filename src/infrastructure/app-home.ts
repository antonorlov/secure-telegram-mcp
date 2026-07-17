/**
 * App HOME — where secure-telegram-mcp keeps its state when the operator does not
 * say otherwise: ONE well-known, per-user, 0700 directory
 * (`~/.secure-telegram-mcp`, matching the package name — `~/.telegram-mcp` is
 * ALREADY TAKEN by other Telegram MCP tools with plaintext Telethon sessions, and
 * colliding with them would corrupt both). The shim, daemon, and setup all
 * resolve the SAME paths from here, so TELEGRAM_MCP_CONFIG,
 * TELEGRAM_MCP_SESSION_DIR, and TELEGRAM_MCP_MEDIA_DIR are pure power-user
 * overrides (docker/CI), not required wiring.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The per-user home directory (created 0700 on first write by its owners). */
export const appHomeDir = (): string => join(homedir(), '.secure-telegram-mcp');

/** Default config path. */
export const defaultConfigPath = (): string => join(appHomeDir(), 'config.json');

/** Default encrypted-session directory (also hosts the sealed policy + daemon socket/log). */
export const defaultSessionDir = (): string => join(appHomeDir(), 'sessions');

/** Default media root shared by every endpoint; downloads use its `downloads/` child. */
export const defaultMediaDir = (): string => join(appHomeDir(), 'media');

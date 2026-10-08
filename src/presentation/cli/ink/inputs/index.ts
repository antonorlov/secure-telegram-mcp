/**
 * Input-wrapper barrel — the reusable single-line input component set the single Ink app routes
 * to (one LinePrompt/ConfirmPrompt, not a hand-rolled field per call site). Each is a thin
 * adapter over `@inkjs/ui` behind the framework-free `SetupUi` request DTOs.
 * Importing this barrel loads Ink, so only the lazy setup app reaches it — `connect` never does.
 */
export { LinePrompt, type LinePromptProps } from './LinePrompt.js';
export { ConfirmPrompt, type ConfirmPromptProps } from './ConfirmPrompt.js';
export { PromptFrame, type PromptFrameProps } from './PromptFrame.js';

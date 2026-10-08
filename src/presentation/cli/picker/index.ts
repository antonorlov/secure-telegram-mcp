/**
 * Picker public surface — the FRAMEWORK-FREE access-picker core (model + pure
 * reducer/selector contracts + the config<->picker mapper contract). The Ink
 * layer and the Vitest suite import from here; nothing in this subtree imports
 * Ink/React/node:*, so `connect` stays clean even if it transitively reached this.
 */

// Model (immutable state shapes)
export type {
  AccessBits,
  ChatKey,
  ChatRow,
  EffectiveAccess,
  FolderRow,
  PickerChatKind,
  PickerSelectionModel,
  PickerState,
  PickerTab,
  Row,
  RowId,
  TabKey,
  TriState,
} from './model.js';

// Reducer contract (types)
export type { PickerAction } from './reducer.js';

// Pure reducer + selectors + state factory (values)
export {
  createPickerState,
  deriveFolderTriState,
  pickerReducer,
  resolveEffective,
  selectFolderCounts,
  selectShownCounts,
  selectTabs,
  selectVisibleRows,
  selectWindow,
  uniformFolderBits,
  uniqueChatKeys,
} from './reducer.js';

// Config <-> picker projection — contract DTOs + the pure lossless 2-bit mapper.
export type {
  HydrateInput,
  PickerChatSource,
  PickerEnumeration,
  PickerFolderSource,
  ProjectedScope,
} from './config-mapper-impl.js';
export {
  bitsToVerbs,
  hydratePickerSelection,
  isCommittedFolderUnit,
  projectPickerSelection,
  unmatchedPickerRefs,
  verbsToBits,
} from './config-mapper-impl.js';

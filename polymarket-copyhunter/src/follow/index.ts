/**
 * CopyHunter - Follow Module Exports
 */

export {
  FollowEngine,
  getFollowEngine,
  type FollowDecision,
  type FollowEngineStats,
} from './engine.js';
export {
  buildFollowDisplayStatus,
  type FollowDisplayStatus,
} from './status-display.js';
export {
  buildEventFollowDisplay,
  summarizeEventFollowDisplays,
  type EventFollowDisplaySummary,
  type EventFollowDisplay,
  type EventFollowOutcomeLike,
} from './event-display.js';
export {
  buildStoredFollowOutcomeReason,
  classifyFollowErrorCategory,
  classifyFollowSkipCategory,
  parseStoredFollowOutcomeReason,
  type FollowOutcomeCategory,
  type FollowOutcomeKind,
  type ParsedFollowOutcomeReason,
} from './outcome-reason.js';

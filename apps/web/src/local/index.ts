/**
 * Local transport: the engine, an authorized per-seat view, and a durable save.
 *
 * Import from here rather than from the individual modules.
 */
export {
  LOCAL_MODE_NOTICE,
  LOCAL_SNAPSHOT_FORMAT,
  LOCAL_SNAPSHOT_FORMAT_VERSION,
  LocalSnapshotError,
  assertReadable,
  buildEnvelope,
  readDocument,
  readEnvelope,
  readabilityProblem,
  recheckSummary,
  summarize,
  writeDocument,
  type LocalMatchSummary,
  type LocalSnapshotEnvelope,
  type LocalSnapshotErrorCode,
  type ReadabilityVersions,
} from './snapshot';
export {
  LOCAL_DATABASE_NAME,
  LocalStoreError,
  createMemoryStore,
  openIndexedDbStore,
  type LocalMatchRecord,
  type LocalSnapshotStore,
} from './store';
export {
  createLocalMatch,
  deleteLocalMatch,
  importLocalMatch,
  listLocalMatches,
  randomSeed,
  resumeLocalMatch,
  type LocalMatch,
  type LocalMatchOptions,
  type LocalViewResult,
} from './localMatch';

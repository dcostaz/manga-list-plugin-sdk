/**
 * Type definitions for manga-list plugin packages, contract 4.0.0
 * (docs/plugins/host-capability-contract.md in the host repo; §2.6 defines the result shapes).
 *
 * Moved from manga-list-plugin-template/types/plugintypedefs.d.ts by Plan-2026Q4-tracker-plugin-standardization
 * Phase 1.6b and brought to the contract: the nine §2.6 shapes added, `getStatus` a Promise, `linkState`
 * removed from PluginLiveData and PluginCardSummary (A4), A1/A10/A12/A13 applied, the 3.x-only shapes
 * (PluginSubscribeContext, PluginProgressDTO, the init factories) dropped. From here this file is normative.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type PluginServiceSettings = Record<string, unknown>;

/** A credential as the host presents it — its fields are the manifest's credentialOptions.fields. */
export type PluginCredential = Record<string, string>;

/** The host's reading statuses: the keys of statusVocabulary.push. */
export type PluginReadingStatus = 'READING' | 'COMPLETED' | 'PLAN_TO_READ' | 'ON_HOLD' | 'DROPPED' | 'RE_READING';

/** Contract §2: the trailing argument of every operation method. */
export interface PluginCallContext {
  credential: PluginCredential | null;
  /** Opaque label of the slot presented: the key for what a plugin keeps per credential (a token). */
  identity: string;
  /** Opaque label of the acting user, or 'system': the key for what a plugin keeps per user (a cache entry). */
  scope: string;
  signal: AbortSignal | null;
}

// ---------------------------------------------------------------------------
// Cache adapter the host injects as context.cache
// ---------------------------------------------------------------------------

export interface PluginCacheAdapterLike {
  getValue(key: string): Promise<unknown>;
  setValue(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  deleteValue?(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Manifest blocks (contract §1.4, §2.2, §2.3)
// ---------------------------------------------------------------------------

export interface PluginStatusVocabulary {
  /** Every host status; null where the source has no such list. */
  push: Record<PluginReadingStatus, string | null>;
  /** Every source token the plugin can return. */
  pull: Record<string, PluginReadingStatus>;
}

export type PluginProgressAxis = 'chapter' | 'rating';
export type PluginProgressAxisDecl = PluginProgressAxis | { axis: PluginProgressAxis; scale: 'integer' | 'decimal' };

export interface PluginSyncOptions {
  statusVocabulary?: PluginStatusVocabulary;
  progressAxes?: { pull?: PluginProgressAxisDecl[]; push?: PluginProgressAxisDecl[] };
}

export interface PluginCredentialField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  placeholder?: string;
  description?: string;
}

export interface PluginManifest {
  pluginName: string;
  displayName: string;
  pluginType: 'tracker' | 'adapter';
  pluginContractVersion: string;
  hostApiVersion: string;
  capabilities: string[];
  entrypoints: { pluginModule: string; settingsFile: string };
  iconPath?: string;
  syncOptions?: PluginSyncOptions;
  retrieveOptions?: { requiresCredential: boolean };
  searchOptions?: { requiresCredential: boolean };
  credentialOptions?: { fields: PluginCredentialField[] };
  /** A `file-path` plugin: the settings that make up its path grant (§1.4, A19). */
  filePathOptions?: { fields: PluginFilePathField[] };
  /** A `filterable` plugin: the fields of its Filters Panel section (§1.4, A21). */
  filterSchema?: Record<string, PluginFilterField>;
  filterPresets?: Array<{ id: string; label: string; fields: Record<string, unknown> }>;
  workspace?: { entry?: string; [key: string]: unknown };
}

export interface PluginFilePathField {
  /** A setting of the plugin's settings document. */
  key: string;
  label: string;
  kind: 'file' | 'directory';
}

/** A `file-path` plugin's credential: one absolute path per `filePathOptions.fields` key (A19). */
export type PluginPathGrant = Record<string, string>;

export interface PluginFilterField {
  type: 'enum' | 'boolean' | 'text';
  label?: string;
  values?: string[];
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface PluginInitResult {
  status: 'ok' | 'error' | 'unconfigured';
  message?: string;
}

export interface PluginStatus {
  status: 'ok' | 'error' | 'initializing';
  message?: string;
}

export interface PluginModuleDescriptor {
  pluginName: string;
  displayName: string;
  WrapperClass: Function;
  SettingsClass: Function;
}

// ---------------------------------------------------------------------------
// Errors (§2.6)
// ---------------------------------------------------------------------------

export type PluginErrorCode = 'not_found' | 'credential_rejected' | 'rate_limited' | 'offline' | 'source_error';

export interface PluginEntryError {
  code: PluginErrorCode;
  message: string;
}

// ---------------------------------------------------------------------------
// Search and enrich (§2, §2.4, §2.6)
// ---------------------------------------------------------------------------

export interface PluginMatchCandidate {
  pluginEntryId: string;
  title: string;
  altTitles?: string[];
  confidence: number;
  canonicalUrl: string | null;
  cached?: boolean;
  fetchedAt?: string;
}

export interface PluginSourceLink {
  siteId: string;
  siteLabel: string;
  seriesUrl: string;
  isPrimary: boolean;
}

/** A contributor: a plain name, or a name with a source-defined role. */
export type PluginContributor = string | { name: string; type?: string };

export interface PluginLinkContribution {
  pluginEntryId: string;
  displayTitle?: string;
  altTitles?: string[];
  authors?: PluginContributor[];
  artists?: PluginContributor[];
  description?: string;
  coverUrl?: string;
  seriesStatus?: 'ongoing' | 'completed' | 'hiatus' | 'unknown';
  genres?: string[];
  tags?: string[];
  year?: number;
  seriesType?: string;
  publishers?: PluginContributor[];
  sourceLinks?: PluginSourceLink[];
  syncedAt: string;
  syncIntervalHint?: number;
}

/** search.lookup's result: full detail for one known entry. */
export interface PluginEntryDetail extends PluginLinkContribution {
  canonicalUrl: string | null;
}

export interface PluginEnrichResult {
  pluginEntryId: string;
  success: boolean;
  contribution?: PluginLinkContribution;
  error?: PluginEntryError;
}

export interface PluginCoverQuery {
  title: string;
  altTitles?: string[];
}

export interface PluginCoverOptions {
  pluginEntryId?: string;
  limit?: number;
}

export interface PluginCoverResult {
  coverId: string;
  imageUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  volumeNumber?: number;
}

// ---------------------------------------------------------------------------
// Syncing and Subscribing (§2, §2.6)
// ---------------------------------------------------------------------------

export interface PluginPullResult {
  pluginEntryId: string;
  /** The source's token: a key of statusVocabulary.pull. */
  status: string | null;
  chapter: number | null;
  rating: number | null;
  lastUpdated: string | null;
}

export interface PluginPushEntry {
  pluginEntryId: string;
  chapter?: number;
  volume?: number;
  rating?: number;
}

export interface PluginPushResult {
  pluginEntryId: string;
  success: boolean;
  applied: { chapter?: number; rating?: number } | null;
  error?: PluginEntryError;
}

export interface PluginReadingListEntry {
  pluginEntryId: string;
  title: string | null;
  canonicalUrl: string | null;
  /** The source's token: a key of statusVocabulary.pull. */
  status: string | null;
  chapter: number | null;
  rating: number | null;
  volume: number | null;
  listId: number | null;
  priority: number | null;
  lastUpdated: string | null;
}

export interface PluginSubscribeEntry {
  pluginEntryId: string;
  /** The source's token, resolved by the host through statusVocabulary.push. */
  status: string;
}

export interface PluginSubscribeResult {
  pluginEntryId: string;
  success: boolean;
  listId: number | null;
  status: string | null;
  error?: PluginEntryError;
}

export interface PluginUnsubscribeResult {
  pluginEntryId: string;
  success: boolean;
  error?: PluginEntryError;
}

// ---------------------------------------------------------------------------
// Watching (§2, §2.6)
// ---------------------------------------------------------------------------

export type PluginLiveSection =
  | { type: 'stat-grid'; label?: string; fields: Array<{ label: string; value: string | number }> }
  | { type: 'progress'; label?: string; value: number; max?: number }
  | { type: 'item-list'; label?: string; items: Array<{ id: string; label: string; value?: string; url?: string }> }
  | { type: 'link-list'; label?: string; links: Array<{ label: string; url: string }> }
  | { type: 'text'; label?: string; content: string };

export interface PluginLiveData {
  pluginEntryId: string;
  displayTitle?: string;
  statusLabel?: string;
  fetchedAt: string;
  sections: PluginLiveSection[];
}

export type PluginLiveQueryResult =
  | { status: 'ok'; data: PluginLiveData }
  | { status: 'offline'; message?: string }
  | { status: 'not_found' }
  | { status: 'error'; message: string; retryable: boolean };

export interface PluginCardSummary {
  label: string | null;
  status: string | null;
  latestChapter: number | null;
  lastUpdated: string | null;
}

export interface PluginSummaryResult {
  pluginEntryId: string;
  success: boolean;
  summary?: PluginCardSummary;
  error?: PluginEntryError;
}

// ---------------------------------------------------------------------------
// Retrieving (§2, §2.3, §2.6)
// ---------------------------------------------------------------------------

export interface PluginChapterSummary {
  id: string;
  label: string;
  ordering: number;
  /** '' for a source with no language concept. */
  language: string;
}

export interface PluginChapterListResult {
  chapters: PluginChapterSummary[];
  availableLanguages: string[];
}

export interface PluginPageSummary {
  pageKey: string;
  pageNumber: number;
  sizeHint?: number;
}

// ---------------------------------------------------------------------------
// Filtering (§2 `filterable`, A21) and the own-data reads (§5.4, A22)
// ---------------------------------------------------------------------------

export interface PluginFilterSpec {
  fields: Record<string, unknown>;
  presetId?: string;
}

export interface PluginFilterResult {
  applicable: boolean;
  pluginEntryIds: string[];
}

/** One entry of the plugin's own catalog: the three named fields are the host's; the rest is the plugin's surface's. */
export interface PluginWorkspaceEntry {
  pluginEntryId: string;
  title: string;
  altTitles?: string[];
  [field: string]: unknown;
}

export interface PluginEntryPage {
  entries: PluginWorkspaceEntry[];
  totalCount: number;
  page: number;
  pageSize: number;
}

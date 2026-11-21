/**
 * Type definitions for manga-list plugin packages, contract 4.4.0
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
  /** A `watch.list` plugin: `wholeHolding` true where the system's list is the source's whole holding (§1.4, A28). */
  watchOptions?: { wholeHolding?: boolean };
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

/**
 * `search(query, options?)`'s options. `refresh` (A31) answers from the source, never the plugin's cache; `allHits`
 * (A35, 4.4.0) answers every hit the plugin finds, its own filtering of hits skipped, at most its result cap (A36).
 */
export interface PluginSearchOptions {
  refresh?: boolean;
  allHits?: boolean;
}

/**
 * A search candidate (§2.6). From 4.4.0 every candidate is an entry the plugin's `lookup` and `enrich` resolve by
 * its `pluginEntryId` (A38), and may carry `detail`, the record as far as the search response holds it (A32).
 */
export interface PluginMatchCandidate {
  pluginEntryId: string;
  title: string;
  altTitles?: string[];
  confidence: number;
  canonicalUrl: string | null;
  cached?: boolean;
  fetchedAt?: string;
  /** A32 (4.4.0): the record without its identity; the candidate holds `pluginEntryId`, `canonicalUrl`, `cached`, `fetchedAt`. */
  detail?: PluginEntryRecord;
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
  seriesStatus?: PluginSeriesStatus;
  genres?: string[];
  tags?: string[];
  year?: number;
  seriesType?: string;
  publishers?: PluginContributor[];
  sourceLinks?: PluginSourceLink[];
  syncedAt: string;
  syncIntervalHint?: number;
  /** A31 (4.3.0): set by a plugin that answered from its own cache. Both absent: the answer is live. */
  cached?: boolean;
  /** A31: the ISO time the cached answer was fetched from the source. */
  fetchedAt?: string;
}

/** `enrich(pluginEntryIds, options?)`'s options (A31, 4.3.0): `refresh` answers from the source, never the plugin's cache. */
export interface PluginEnrichOptions {
  refresh?: boolean;
}

/**
 * search.lookup's result: full detail for one known entry. From 4.4.0 its `display` part is everything the source
 * holds for it, a second read of the source included where the source needs one (A33).
 */
export interface PluginEntryDetail extends PluginLinkContribution {
  canonicalUrl: string | null;
  /** A33 (4.4.0): Presenting's only; Enriching never stores it. */
  display?: PluginEntryDisplay;
}

/**
 * A32 (4.4.0): the record a search candidate carries — the contribution's descriptive fields without its identity
 * (`pluginEntryId`, `syncedAt`, `syncIntervalHint`, `cached`, `fetchedAt`), and the display part. A field the source
 * does not hold is absent, never empty, `null` or a placeholder.
 */
export interface PluginEntryRecord extends Omit<PluginLinkContribution, 'pluginEntryId' | 'syncedAt' | 'syncIntervalHint' | 'cached' | 'fetchedAt'> {
  display?: PluginEntryDisplay;
}

// ---------------------------------------------------------------------------
// The display part (§2.4.1, §2.6; 4.4.0)
// ---------------------------------------------------------------------------

/** A34 (4.4.0): `cancelled` joins the series statuses. */
export type PluginSeriesStatus = 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'unknown';

/** A title as the source gives it; the host's *matched title* is the host's mark, never a kind. */
export interface PluginDisplayTitle {
  title: string;
  /** A language code. */
  language?: string;
  kind: 'main' | 'alternate' | 'native' | 'romanized';
}

export interface PluginDisplayDescription {
  /** Plain text, line breaks kept. */
  text: string;
  language?: string;
}

export interface PluginDisplayCoverSize {
  url: string;
  width?: number;
}

export interface PluginDisplayCover {
  sizes: PluginDisplayCoverSize[];
  placeholder?: { blurhash: string };
}

export type PluginContentRating = 'safe' | 'suggestive' | 'erotica' | 'pornographic';

/** ISO dates. */
export interface PluginDisplayDates {
  started?: string;
  ended?: string;
  updated?: string;
}

export interface PluginDisplayCount {
  final?: number;
  latest?: number;
  total?: number;
}

export interface PluginDisplayTag {
  name: string;
  group?: string;
  path?: string;
  spoiler?: boolean;
  votes?: number;
}

/** A rating on the source's own scale; its percentage is `value / scale`. */
export interface PluginDisplayRating {
  source: string;
  value: number;
  scale: number;
  votes?: number;
}

export interface PluginDisplayPopularity {
  rank?: number;
  follows?: number;
  lists?: number;
}

export interface PluginDisplayLicensing {
  licensed?: boolean;
  anime?: boolean;
}

export interface PluginDisplayRelation {
  relation: string;
  title?: string;
  pluginEntryId?: string;
  url?: string;
}

export interface PluginDisplayRecommendation {
  title: string;
  pluginEntryId?: string;
  url?: string;
}

/** An external link; an adapter's site lists (the sites a series is listed on) are links too (A38). */
export interface PluginDisplayLink {
  label: string;
  url: string;
  type?: string;
  language?: string;
}

export interface PluginDisplayTranslation {
  language: string;
}

/** The site within the source, and the series' path there. */
export interface PluginDisplaySite {
  id: string;
  label: string;
  address?: string;
  path?: string;
}

/** The entry's own progress at the source. */
export interface PluginDisplayProgress {
  chapter?: number;
  downloaded?: number;
  checking?: boolean;
}

export interface PluginDisplayFolder {
  path: string;
  exists: boolean;
}

/**
 * A33 (4.4.0): what Presenting shows and Enriching never stores. Every field optional. Where it holds a richer form
 * of a contribution field (titles, descriptions, cover, tags, links, dates, the status as worded), Presenting reads
 * this one; a role on an author or publisher is the contributor's own `type` (`PluginContributor`).
 */
export interface PluginEntryDisplay {
  titles?: PluginDisplayTitle[];
  descriptions?: PluginDisplayDescription[];
  cover?: PluginDisplayCover;
  /** A language code. */
  originalLanguage?: string;
  demographic?: string;
  contentRating?: PluginContentRating;
  /** The status as the source words it. */
  statusText?: string;
  dates?: PluginDisplayDates;
  volumes?: PluginDisplayCount;
  chapters?: PluginDisplayCount;
  magazine?: string;
  tags?: PluginDisplayTag[];
  ratings?: PluginDisplayRating[];
  popularity?: PluginDisplayPopularity;
  licensing?: PluginDisplayLicensing;
  relations?: PluginDisplayRelation[];
  recommendations?: PluginDisplayRecommendation[];
  links?: PluginDisplayLink[];
  translations?: PluginDisplayTranslation[];
  site?: PluginDisplaySite;
  progress?: PluginDisplayProgress;
  folder?: PluginDisplayFolder;
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
  /** The source's alternate titles, or null where its list carries none (A30; from 4.2.0). */
  altTitles: string[] | null;
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

/**
 * The SDK's public API, for a plugin's typecheck (`require('@manga-list/plugin-sdk')`). The DTOs are in
 * ./plugintypedefs.d.ts and re-exported here.
 */

export * from './plugintypedefs';
import type { PluginCallContext, PluginModuleDescriptor } from './plugintypedefs';

export const PLUGIN_CONTRACT_VERSION: string;
export const PLUGIN_SETTINGS_CONTRACT_VERSION: string;
export const MIN_ADAPTER_CONTRACT_VERSION: string;
export const KNOWN_CAPABILITIES: readonly string[];
export const OPERATION_OFFERS: readonly string[];
export const OFFER_METHODS: Readonly<Record<string, readonly string[]>>;
export const OWN_READ_METHODS: readonly string[];
export const TRANSITIONAL_READ_METHODS: readonly string[];
export const OFFER_DOMAIN: Readonly<Record<string, string>>;
export const DOMAIN_SIDE: Readonly<Record<string, 'system' | 'user'>>;
export const HOST_READING_STATUSES: readonly string[];
export const PLUGIN_ERROR_CODES: readonly string[];
export const HOST_CONTRACT_VIOLATION: 'host_contract_violation';

export class PluginError extends Error {
  constructor(code: string, message: string, details?: { status?: number; retryAfterMs?: number; cause?: unknown });
  code: string;
  status?: number;
  retryAfterMs?: number;
  toEntryError(): { code: string; message: string };
}
export function isPluginError(value: unknown): value is PluginError;
export function toPluginError(error: unknown): PluginError;

export type TokenSet = Record<string, { value: string; expiresAt?: number | null }>;

export interface RequestConfig {
  url?: string;
  method?: string;
  endpoint?: string;
  timeoutKind?: 'request' | 'search';
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  data?: unknown;
  [key: string]: unknown;
}

export interface CallHttp {
  readonly signal: AbortSignal | null;
  request(config: RequestConfig): Promise<any>;
  get(url: string, config?: RequestConfig): Promise<any>;
  post(url: string, data?: unknown, config?: RequestConfig): Promise<any>;
  authed<T>(fn: (tokens: TokenSet) => Promise<T>): Promise<T>;
  authedRequest(config: RequestConfig): Promise<any>;
}

export interface AuthStrategy {
  exchange(credential: any, ctx: { http: CallHttp; settings: Record<string, unknown>; previous: TokenSet | null; reason: 'initial' | 'expired' | 'rejected' }): Promise<{ tokens: TokenSet }>;
  apply(tokens: TokenSet, config: RequestConfig): RequestConfig;
  isAuthFailure?(error: unknown): boolean;
}

export interface ScopedCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CallViewBase extends Omit<PluginCallContext, 'credential'> {
  credential: any;
  /** A `file-path` plugin's path grant for this call (A19); null for a `credential` plugin. */
  paths: Record<string, string> | null;
  /** The host's SQLite driver constructor (`context.sqlite`, A24), or null. */
  sqlite: any;
  http: CallHttp;
  cache: ScopedCache;
  settings: Record<string, unknown>;
  utils: Record<string, any>;
}

export interface CallView extends CallViewBase {
  client: any;
}

export interface SettingsDocument {
  metadata: Record<string, any>;
  schema: Record<string, any>;
  settings: Record<string, unknown>;
}

export interface PluginDefinition {
  manifest: Record<string, any>;
  settings?: SettingsDocument | null;
  auth?: AuthStrategy | null;
  createClient(deps: { settings: Record<string, unknown>; utils: Record<string, any>; sqlite: any; pluginName: string; addNormalizer(fn: (response: any) => void): void }): (view: CallViewBase) => any;
  methods?: Record<string, (view: CallView, ...args: any[]) => Promise<any>>;
  mapping?: Record<string, (raw: any, ...args: any[]) => any>;
  initialize?(deps: { settings: Record<string, unknown> }): Promise<{ status: string; message?: string } | void>;
  getStatus?(deps: { settings: Record<string, unknown> }): Promise<{ status: string; message?: string }> | { status: string; message?: string };
}

export type TrackerDefinition = PluginDefinition;

/** One definition for every plugin type (Decision 5); the two named forms are aliases. */
export function definePlugin(definition: PluginDefinition): Readonly<PluginModuleDescriptor>;
export function defineTrackerPlugin(definition: PluginDefinition): Readonly<PluginModuleDescriptor>;
export function defineAdapterPlugin(definition: PluginDefinition): Readonly<PluginModuleDescriptor>;

export function perEntry<TEntry, TResult extends object>(
  entries: TEntry[],
  fn: (entry: TEntry) => Promise<TResult>,
  options?: { idOf?: (entry: TEntry) => string; concurrency?: number },
): Promise<Array<{ pluginEntryId: string; success: boolean; error?: { code: string; message: string } } & Partial<TResult>>>;
export function notFoundEntry(pluginEntryId: string, message?: string): { pluginEntryId: string; success: false; error: { code: 'not_found'; message: string } };
export function markCached<T extends object>(candidate: T, fetchedAt?: string | Date | null): T & { cached: true; fetchedAt?: string };

export function validateResult(method: string, result: unknown, options?: { manifest?: { syncOptions?: any } | null; inputIds?: string[] | null }): string[];
export const VALIDATED_METHODS: readonly string[];

export function createSettingsClass(embedded: SettingsDocument | null): Function;
export function assertSettingsDocument(doc: unknown, where: string): SettingsDocument;


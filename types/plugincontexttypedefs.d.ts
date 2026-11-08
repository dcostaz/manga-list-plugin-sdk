/**
 * The context the host injects at WrapperClass.init() (contract §3). Adding a field is a minor bump;
 * removing or changing one is a major.
 */

import type { PluginCacheAdapterLike, PluginServiceSettings } from './plugintypedefs';

export interface PluginContextUtils {
  /** NFKD-normalise, strip filesystem-unsafe characters, collapse whitespace, lowercase, trim. */
  sanitizeForSearch(text: string): string;
}

export interface PluginContextLike {
  utils: PluginContextUtils;
  /** The host's HTTP client instance; the SDK's http wraps it. */
  http: unknown;
  /** Null when the host's cache is disabled: every read a miss, every write a no-op. */
  cache: PluginCacheAdapterLike | null;
}

export interface PluginWrapperInitOptions {
  context: PluginContextLike;
  apiSettings?: { getAll(): PluginServiceSettings } | null;
  serviceSettings?: PluginServiceSettings | null;
}

/**
 * Type declarations for `@manga-list/plugin-sdk/testing` (testing/index.cjs): the stubs a plugin's or the
 * host's tests build a WrapperClass over, and the conformance suite that runs the contract's cases against it.
 */

/** What a stub source answers for one request; a status of 400 or more is thrown as an axios-shaped error. */
export interface StubResponse {
    status?: number;
    data?: unknown;
    headers?: Record<string, string>;
}

/** A stub source: one request config in, one response out. */
export type StubHandler = (config: Record<string, any>) => StubResponse | Promise<StubResponse>;

/** The response a stub client resolves with. */
export interface StubAxiosResponse {
    status: number;
    data: unknown;
    headers: Record<string, string>;
    config: Record<string, any>;
}

/** An axios-shaped HTTP client over a StubHandler; `calls` records every request config in order. */
export interface StubAxios {
    calls: Array<Record<string, any>>;
    request(config: Record<string, any>): Promise<StubAxiosResponse>;
    get(url: string, config?: Record<string, any>): Promise<StubAxiosResponse>;
    delete(url: string, config?: Record<string, any>): Promise<StubAxiosResponse>;
    post(url: string, data?: unknown, config?: Record<string, any>): Promise<StubAxiosResponse>;
    put(url: string, data?: unknown, config?: Record<string, any>): Promise<StubAxiosResponse>;
    patch(url: string, data?: unknown, config?: Record<string, any>): Promise<StubAxiosResponse>;
    defaults: { headers: Record<string, any> };
    interceptors: {
        request: { use(...args: any[]): number; eject(id?: number): void };
        response: { use(...args: any[]): number; eject(id?: number): void };
    };
    setHandler(next: StubHandler): void;
    getHandler(): StubHandler;
}

/** An in-memory host cache adapter; `writes` records each key with the scope active when it was written. */
export interface StubCache {
    store: Map<string, unknown>;
    writes: Array<{ key: string; scope: string | null }>;
    setActiveScope(scope: string | null): void;
    getValue(key: string): Promise<unknown>;
    setValue(key: string, value: unknown): Promise<void>;
    deleteValue(key: string): Promise<void>;
}

/** The context the host injects at init. */
export interface StubContext {
    utils: { sanitizeForSearch(text: string): string };
    http: any;
    cache: any;
}

/** A source that knows no plugin: login-like POSTs mint tokens, every other call answers an empty payload. */
export interface GenericSource {
    handler: StubHandler;
    /** Each minted token and the phase it was minted in. */
    tokenPhase: Map<string, string>;
    setPhase(next: string): void;
}

/** The per-call context the host passes as a method's last argument (contract §2). */
export interface CallContext {
    credential: unknown;
    identity: string;
    scope: string;
    signal: AbortSignal | null;
}

/** One failed conformance case, with the analysis finding it reproduces where it encodes one. */
export interface CaseFailure {
    id: string;
    kind: 'structure' | 'shape' | 'behaviour' | 'harness';
    finding?: string;
    problems: string[];
    threw?: boolean;
}

export interface RunConformanceOptions {
    WrapperClass: any;
    manifest: Record<string, any>;
    descriptor?: Record<string, any> | null;
    harness?: '4.0' | '3.x';
    settings?: Record<string, unknown>;
    source?: StubHandler;
    axios?: StubAxios;
    initOptions?: Record<string, any>;
    inputs?: Record<string, any[]>;
    credentials?: [unknown, unknown];
    context?: (overrides?: object) => CallContext;
    expect?: { readingListLength?: number };
}

export interface ConformanceResult {
    passed: string[];
    failed: CaseFailure[];
    /** Cases that need the plugin's own source fixture and were not run against the generic one (4.4.0: A35, A38). */
    skipped: string[];
}

export function createStubAxios(handler?: StubHandler): StubAxios;
export function createStubCache(): StubCache;
export function createStubContext(options?: { axios?: any; cache?: any }): StubContext;
export function createGenericSource(): GenericSource;
export function callContext(overrides?: Partial<CallContext>): CallContext;
export function credentialFor(suffix: string): {
    apiKey: string;
    username: string;
    password: string;
    client_id: string;
    client_secret: string;
};
/** Sample arguments per method, everything but the callContext. */
export function defaultInputs(manifest: Record<string, any>): Record<string, any[]>;
/** Run the contract cases against a WrapperClass. */
export function runConformance(options: RunConformanceOptions): Promise<ConformanceResult>;
/** Lifecycle and access methods a WrapperClass may carry beside its §2 operation methods. */
export const LIFECYCLE_METHODS: readonly string[];

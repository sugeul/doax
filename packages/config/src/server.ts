import { readFile } from "node:fs/promises";

export type StorageConfig = { kind: "sqlite" } | { kind: "postgres"; url: string };

export interface ServerConfig {
    /** Public domain (or origin) this server is reached at. Drives the `manifesto` field (spec §10A). */
    domain: string;
    /** Who operates this instance; shown in manifesto.json. */
    operator: string;
    port: number;
    /** Directory for embedded storage: SQLite database and package files. */
    dataDir: string;
    storage: StorageConfig;
    /** Upstream public registry to proxy through (spec §12.2). Off by default so an air-gapped install stays air-gapped. */
    upstream: string | null;
    auth: {
        /** OIDC issuer. Google Sign-In is OIDC, so the public reference and "plug in your SSO" are the same code. */
        oidcIssuer: string;
        clientId: string | null;
    };
}

export const GOOGLE_OIDC_ISSUER = "https://accounts.google.com";

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
    domain: "http://localhost:8080",
    operator: "unconfigured",
    port: 8080,
    dataDir: "./data",
    storage: { kind: "sqlite" },
    upstream: null,
    auth: { oidcIssuer: GOOGLE_OIDC_ISSUER, clientId: null },
};

type Env = Record<string, string | undefined>;

/** Deep-partial of ServerConfig as it may appear in a config file. */
export interface ServerConfigFile {
    domain?: string;
    operator?: string;
    port?: number;
    dataDir?: string;
    storage?: StorageConfig;
    upstream?: string | null;
    auth?: Partial<ServerConfig["auth"]>;
}

/** Precedence: environment variables > config file > defaults. */
export function loadServerConfig(env: Env = {}, file: ServerConfigFile = {}): ServerConfig {
    const merged: ServerConfig = {
        ...DEFAULT_SERVER_CONFIG,
        ...file,
        storage: file.storage ?? DEFAULT_SERVER_CONFIG.storage,
        upstream: file.upstream === undefined ? DEFAULT_SERVER_CONFIG.upstream : file.upstream,
        auth: { ...DEFAULT_SERVER_CONFIG.auth, ...file.auth },
    };

    if (env.PORT) merged.port = parsePort(env.PORT);
    if (env.DOAX_DOMAIN) merged.domain = env.DOAX_DOMAIN;
    if (env.DOAX_OPERATOR) merged.operator = env.DOAX_OPERATOR;
    if (env.DOAX_DATA_DIR) merged.dataDir = env.DOAX_DATA_DIR;
    if (env.DOAX_UPSTREAM !== undefined) merged.upstream = env.DOAX_UPSTREAM || null;
    if (env.DOAX_OIDC_ISSUER) merged.auth.oidcIssuer = env.DOAX_OIDC_ISSUER;
    if (env.DOAX_OIDC_CLIENT_ID) merged.auth.clientId = env.DOAX_OIDC_CLIENT_ID;
    if (env.DOAX_STORAGE === "postgres") {
        if (!env.DOAX_POSTGRES_URL) throw new Error("DOAX_STORAGE=postgres requires DOAX_POSTGRES_URL");
        merged.storage = { kind: "postgres", url: env.DOAX_POSTGRES_URL };
    } else if (env.DOAX_STORAGE === "sqlite") {
        merged.storage = { kind: "sqlite" };
    } else if (env.DOAX_STORAGE) {
        throw new Error(`Unknown DOAX_STORAGE: ${env.DOAX_STORAGE}`);
    }

    // Domain defaults to the port we actually listen on when nobody configured it.
    if (merged.domain === DEFAULT_SERVER_CONFIG.domain && merged.port !== DEFAULT_SERVER_CONFIG.port) {
        merged.domain = `http://localhost:${merged.port}`;
    }
    return merged;
}

/** Reads the config file named by DOAX_CONFIG (if set and present), then applies the environment. */
export async function readServerConfig(env: Env = process.env): Promise<ServerConfig> {
    let file: ServerConfigFile = {};
    if (env.DOAX_CONFIG) {
        file = JSON.parse(await readFile(env.DOAX_CONFIG, "utf8")) as ServerConfigFile;
    }
    return loadServerConfig(env, file);
}

function parsePort(value: string): number {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${value}`);
    return port;
}

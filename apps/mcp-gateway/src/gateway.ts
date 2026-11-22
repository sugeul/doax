import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCliConfig } from "@doax/config";
import { parseResourceRef } from "@doax/protocol";
import { type CliDeps, handle, type JsonRpcMessage, type Mode, run } from "doax-cli/mcp";

/**
 * doax MCP Gateway core — transport-independent (main.ts = HTTP, lambda.ts = API Gateway). It reuses the
 * executor core through the same handle() the stdio `doax mcp` uses, and adds the web-side credential model:
 * the caller's cookie is the credential store — each authenticator's minted token lives under its own cookie
 * key (doax_tok_<@ns/name>), the web equivalent of ~/.doax/credentials.json. A token is minted by invoking
 * the authenticator (the secret surfaces its declared interaction) and cached in the cookie; there is no
 * server-side store and no central verifier. Credentials are per-request isolated; only the package cache is shared.
 */

export const REGISTRY = (process.env.DOAX_REGISTRY ?? "https://registry.doax.io").replace(/\/+$/, "");
const MODE: Mode = { single: false };
const COOKIE_PREFIX = "doax_tok_";

export const REQUIRE_LOGIN = process.env.DOAX_REQUIRE_LOGIN === "1";
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

export const gatewayOrigin = (host: string | undefined): string => (process.env.DOAX_GATEWAY_ORIGIN ?? `https://${host ?? ""}`).replace(/\/+$/, "");

export const protectedResource = (origin: string): { resource: string; authorization_servers: string[] } => ({ resource: `${origin}/`, authorization_servers: [REGISTRY] });

export const challenge = (origin: string): string => `Bearer resource_metadata="${origin}${PROTECTED_RESOURCE_PATH}"`;

// Content-addressed package cache, safe to share across callers; credentials never are.
const CACHE = join(tmpdir(), "doax-mcp-cache");
mkdirSync(CACHE, { recursive: true });

export interface SetCookie {
    name: string;
    value: string;
}

/** A per-request home: this caller's credentials.json (from their cookie) plus the shared package cache. */
function freshHome(): string {
    const home = mkdtempSync(join(tmpdir(), "doax-mcp-"));
    try {
        symlinkSync(CACHE, join(home, "cache"), "dir");
    } catch {
        /* no symlink here — the cache just repopulates in-home */
    }
    return home;
}

/** True only when the URL's origin is the registry's own — not merely a string that starts with it. */
function sameOrigin(url: string, base: string): boolean {
    try {
        return new URL(url).origin === new URL(base).origin;
    } catch {
        return false;
    }
}

/** Per-request identity: forward the caller's bearer to the registry's own origin; the gateway holds nothing. */
function depsFor(token: string | undefined, home: string): CliDeps {
    const fetchAsCaller: typeof fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!token || !sameOrigin(url, REGISTRY)) return globalThis.fetch(input, init);
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
        return globalThis.fetch(input, { ...init, headers });
    };
    return { config: loadCliConfig({ DOAX_REGISTRY: REGISTRY }), fetch: fetchAsCaller, home, prompt: undefined };
}

/* cookie <-> credential store */

function cookiesToCreds(home: string, cookies: Record<string, string>): void {
    const creds: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(cookies)) {
        if (!name.startsWith(COOKIE_PREFIX)) continue;
        try {
            const entry = JSON.parse(Buffer.from(value, "base64url").toString()) as { authenticator: string };
            const ref = parseResourceRef(entry.authenticator);
            creds[`@${ref.namespace}/${ref.name}`] = entry;
        } catch {
            /* a malformed cookie is simply an absent credential */
        }
    }
    if (Object.keys(creds).length) writeFileSync(join(home, "credentials.json"), JSON.stringify(creds));
}

function credsToCookies(home: string): SetCookie[] {
    let creds: Record<string, { authenticator: string }> = {};
    try {
        creds = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")) as typeof creds;
    } catch {
        return [];
    }
    return Object.entries(creds).map(([key, entry]) => ({
        name: COOKIE_PREFIX + key.replace(/[^a-zA-Z0-9]/g, "_"),
        value: Buffer.from(JSON.stringify(entry)).toString("base64url"),
    }));
}

/* tools: discovery via handle(); read/execute owned here so the mint secret and cookie threading apply */

const paramArgs = (params: unknown): string[] =>
    !params || typeof params !== "object"
        ? []
        : Object.entries(params as Record<string, unknown>).flatMap(([k, v]) => ["--param", `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`]);
const asText = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], isError });

const SECRET_PROP = { secret: { type: "string", description: "mint the authenticator's token on first use; cached in the cookie afterward" } };
const READ_TOOL = {
    name: "doax_read",
    description: "Read a data-source. Needs the authenticator's token; the gateway caches the minted token in your cookie. Pass `secret` to mint on first use.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, params: { type: "object" }, metadata: { type: "boolean" }, ...SECRET_PROP }, required: ["ref"] },
};
const DRY_RUN_TOOL = {
    name: "doax_dry_run",
    description: "Preview an action with no side effects.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, params: { type: "object" }, ...SECRET_PROP }, required: ["ref"] },
};
const EXECUTE_TOOL = {
    name: "doax_execute",
    description: "Run an action. A Tier 1/2 action needs human authorization (itself a minted token); without it the call returns the guarded next step, never a silent effect.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, params: { type: "object" }, ...SECRET_PROP }, required: ["ref"] },
};

const argStrings = (args: Record<string, unknown>): string[] => [...paramArgs(args.params), ...(typeof args.secret === "string" ? ["--secret", args.secret] : [])];

/** A fault the caller resolves by minting/approving (not an error) becomes a `needs_mint` directive. */
function handbackOrError(stderr: string | undefined) {
    let d: Record<string, unknown> = {};
    try {
        d = JSON.parse(stderr ?? "{}") as Record<string, unknown>;
    } catch {
        /* non-JSON stderr falls through to a plain error */
    }
    const fault = d.faultClass as string | undefined;
    if (fault === "credential-missing" || fault === "authorization-required" || fault === "authorization-declined") {
        return asText(JSON.stringify({ status: "needs_mint", faultClass: fault, interactionDetails: d.interactionDetails ?? null, fix: d.fix ?? null }, null, 2));
    }
    return asText(typeof d.error === "string" ? d.error : (stderr ?? "failed"), true);
}

async function readTool(deps: CliDeps, args: Record<string, unknown>) {
    const extra = [...argStrings(args), ...(args.metadata ? ["--metadata"] : [])];
    const r = await run(["read", String(args.ref ?? ""), ...extra, "--json", "--no-input"], deps);
    return r.exitCode === 0 ? asText(r.stdout ?? "") : handbackOrError(r.stderr);
}

async function executeTool(deps: CliDeps, args: Record<string, unknown>, dryRun: boolean) {
    const extra = [...argStrings(args), ...(dryRun ? ["--dry-run"] : [])];
    const r = await run(["execute", String(args.ref ?? ""), ...extra, "--json", "--no-input"], deps);
    return r.exitCode === 0 ? asText(r.stdout ?? "") : handbackOrError(r.stderr);
}

async function route(deps: CliDeps, msg: JsonRpcMessage): Promise<unknown> {
    if (msg.method === "tools/list") {
        const base = (await handle(deps, MODE, msg)) as { tools: { name: string }[] };
        const discovery = base.tools.filter((t) => t.name === "doax_search" || t.name === "doax_describe");
        return { tools: [...discovery, READ_TOOL, DRY_RUN_TOOL, EXECUTE_TOOL] };
    }
    if (msg.method === "tools/call") {
        const name = String(msg.params?.name);
        const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
        if (name === "doax_read") return readTool(deps, args);
        if (name === "doax_dry_run") return executeTool(deps, args, true);
        if (name === "doax_execute") return executeTool(deps, args, false);
    }
    return handle(deps, MODE, msg);
}

/** Handle one JSON-RPC message for a caller identified by their bearer and cookie-borne credentials. */
export async function handleRpc(ctx: { token?: string; cookies: Record<string, string> }, msg: JsonRpcMessage): Promise<{ result: unknown; setCookies: SetCookie[] }> {
    const home = freshHome();
    try {
        cookiesToCreds(home, ctx.cookies);
        const result = await route(depsFor(ctx.token, home), msg);
        return { result, setCookies: credsToCookies(home) };
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}

export function bearer(header: string | undefined): string | undefined {
    const m = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
    return m ? m[1] : undefined;
}

export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (header ?? "").split(";")) {
        const eq = part.indexOf("=");
        if (eq < 1) continue;
        out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
}

export const setCookieHeader = ({ name, value }: SetCookie): string => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=86400`;

export const rpcError = (id: JsonRpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export type { JsonRpcMessage };

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
const COOKIE_CRED = "doax_tok_";
const COOKIE_AUTH = "doax_auth_";
const COOKIE_POLL = "doax_poll_";

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
    expire?: boolean;
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

function cookiesToFiles(home: string, cookies: Record<string, string>): void {
    const creds: Record<string, unknown> = {};
    const auth: Record<string, unknown> = {};
    const poll: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(cookies)) {
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(Buffer.from(value, "base64url").toString()) as Record<string, unknown>;
        } catch {
            continue;
        }
        try {
            if (name.startsWith(COOKIE_CRED) && typeof entry.authenticator === "string") {
                creds[authDomain(entry.authenticator)] = entry;
            } else if (name.startsWith(COOKIE_POLL) && typeof entry.authenticator === "string") {
                poll[authDomain(entry.authenticator)] = entry;
            } else if (name.startsWith(COOKIE_AUTH) && typeof entry.resource === "string") {
                auth[entry.resource] = entry;
            }
        } catch {
            /* a malformed authenticator ref is simply an absent entry */
        }
    }
    if (Object.keys(creds).length) writeFileSync(join(home, "credentials.json"), JSON.stringify(creds));
    if (Object.keys(auth).length) writeFileSync(join(home, "auth-tokens.json"), JSON.stringify(auth));
    if (Object.keys(poll).length) writeFileSync(join(home, "poll-handles.json"), JSON.stringify(poll));
}

/** The credential cache key: the authenticator's versionless `@ns/name`. */
function authDomain(authenticator: string): string {
    const ref = parseResourceRef(authenticator);
    return `@${ref.namespace}/${ref.name}`;
}

function filesToCookies(home: string): SetCookie[] {
    const out: SetCookie[] = [];
    const add = (prefix: string, file: string) => {
        let obj: Record<string, unknown> = {};
        try {
            obj = JSON.parse(readFileSync(join(home, file), "utf8")) as Record<string, unknown>;
        } catch {
            return;
        }
        for (const [key, entry] of Object.entries(obj)) {
            const name = prefix + key.replace(/[^a-zA-Z0-9]/g, "_");
            if ((entry as { expired?: boolean })?.expired) out.push({ name, value: "", expire: true });
            else out.push({ name, value: Buffer.from(JSON.stringify(entry)).toString("base64url") });
        }
    };
    add(COOKIE_CRED, "credentials.json");
    add(COOKIE_AUTH, "auth-tokens.json");
    add(COOKIE_POLL, "poll-handles.json");
    return out;
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
    description: "Read a data-source. Needs the authenticator's token; the gateway caches the minted token in your cookie. Pass `secret` to mint on first use; a Tier 1/2 source needs `yes: true` to authorize.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, params: { type: "object" }, metadata: { type: "boolean" }, yes: { type: "boolean" }, ...SECRET_PROP }, required: ["ref"] },
};
const DRY_RUN_TOOL = {
    name: "doax_dry_run",
    description: "Preview an action with no side effects.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, params: { type: "object" }, ...SECRET_PROP }, required: ["ref"] },
};
const EXECUTE_TOOL = {
    name: "doax_execute",
    description: "Run an action. Tier 1/2 needs the caller's authorization: pass `yes: true`. Tier 2 caches it in the cookie for its window; Tier 1 needs it every call.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, params: { type: "object" }, yes: { type: "boolean" }, ...SECRET_PROP }, required: ["ref"] },
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

/* poll-login over the gateway (§4.7.1a): the client pokes twice. On a credential-missing read/execute whose
   authenticator offers poll-login, drive one `doax auth poll` step, carrying the handle the cookie remembers
   between pokes. Pending -> return the sign-in URL and remember the handle; credential -> proceed this poke. */

const pollFile = (home: string) => join(home, "poll-handles.json");
function readPollHandle(home: string, key: string): string | undefined {
    try {
        return (JSON.parse(readFileSync(pollFile(home), "utf8")) as Record<string, { handle?: string }>)[key]?.handle;
    } catch {
        return undefined;
    }
}
function savePollHandle(home: string, key: string, entry: Record<string, unknown> | null): void {
    let all: Record<string, unknown> = {};
    try {
        all = JSON.parse(readFileSync(pollFile(home), "utf8")) as Record<string, unknown>;
    } catch {
        /* no file yet */
    }
    if (entry) all[key] = entry;
    else delete all[key];
    writeFileSync(pollFile(home), JSON.stringify(all));
}

type PollStep = { signIn: ReturnType<typeof asText> } | { retry: true } | null;
async function maybePoll(deps: CliDeps, stderr: string | undefined): Promise<PollStep> {
    let d: Record<string, unknown> = {};
    try {
        d = JSON.parse(stderr ?? "{}") as Record<string, unknown>;
    } catch {
        return null;
    }
    const authRef = d.authenticator;
    const kinds = d.interactionKinds;
    if (d.faultClass !== "credential-missing" || typeof authRef !== "string" || !Array.isArray(kinds) || !kinds.includes("poll-login")) return null;
    const home = deps.home!;
    const key = authDomain(authRef);
    const handle = readPollHandle(home, key);
    const p = await run(["auth", "poll", authRef, ...(handle ? ["--handle", handle] : []), "--json", "--no-input"], deps);
    if (p.exitCode !== 0) return null;
    let pr: Record<string, unknown>;
    try {
        pr = JSON.parse(p.stdout ?? "{}") as Record<string, unknown>;
    } catch {
        return null;
    }
    if (pr.pending) {
        savePollHandle(home, key, { authenticator: authRef, handle: pr.handle, verificationUrl: pr.verificationUrl });
        return { signIn: asText(JSON.stringify({ status: "sign_in", verificationUrl: pr.verificationUrl, howto: "open the URL and sign in, then call this tool again" }, null, 2)) };
    }
    if (pr.authenticated) {
        savePollHandle(home, key, { expired: true });
        return { retry: true };
    }
    return null;
}

async function readTool(deps: CliDeps, args: Record<string, unknown>) {
    const extra = [...argStrings(args), ...(args.yes ? ["--yes"] : []), ...(args.metadata ? ["--metadata"] : [])];
    const cmd = ["read", String(args.ref ?? ""), ...extra, "--json", "--no-input"];
    let r = await run(cmd, deps);
    if (r.exitCode !== 0) {
        const step = await maybePoll(deps, r.stderr);
        if (step && "signIn" in step) return step.signIn;
        // The completed sign-in is this call's authorization for a read (§7.4), so --yes alongside --authed.
        if (step && "retry" in step) r = await run([...cmd, "--authed", "--yes"], deps);
    }
    return r.exitCode === 0 ? asText(r.stdout ?? "") : handbackOrError(r.stderr);
}

async function executeTool(deps: CliDeps, args: Record<string, unknown>, dryRun: boolean) {
    const extra = [...argStrings(args), ...(dryRun ? ["--dry-run"] : args.yes ? ["--yes"] : [])];
    const cmd = ["execute", String(args.ref ?? ""), ...extra, "--json", "--no-input"];
    let r = await run(cmd, deps);
    if (r.exitCode !== 0) {
        const step = await maybePoll(deps, r.stderr);
        if (step && "signIn" in step) return step.signIn;
        if (step && "retry" in step) r = await run([...cmd, "--authed"], deps);
    }
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
        cookiesToFiles(home, ctx.cookies);
        const result = await route(depsFor(ctx.token, home), msg);
        return { result, setCookies: filesToCookies(home) };
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

export const setCookieHeader = ({ name, value, expire }: SetCookie): string =>
    `${name}=${expire ? "" : value}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${expire ? 0 : 86400}`;

export const rpcError = (id: JsonRpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export type { JsonRpcMessage };

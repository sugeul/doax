import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { type CliConfig, loadCliConfig } from "@doax/config";
import { formatResourceRef, parseResourceRef, type Tier } from "@doax/protocol";
import {
    audit,
    baseEvent,
    confirmTier,
    credentialKey,
    effectiveTierFor,
    ExecutorError,
    type ExecutorDeps,
    fault,
    invokeOperation,
    loadPackage,
    purgeCredentials,
    readCredentials,
    readRegistryMap,
    type ResolvedResource,
    resolveResource,
    tokenFor,
    writeCredential,
    writeRegistryEntry,
    writeToken,
} from "./executor.ts";

export const VERSION = "0.3.0";

const USAGE = `doax ${VERSION} — Executor CLI for the doax registry

Usage:
    doax status                               Show the registry this CLI talks to and whether it answers
    doax registry add <@ns|default> <url>     Route a namespace to a registry (npm-scope style)
    doax registry list                        Show the registry list and routing
    doax registry remove <@ns|default>        Remove a routing entry
    doax search <query> [--kind <kind>]       Search resources visible to you
    doax resolve <@ns/name[@version]>         Resolve a resource and print its manifest
    doax ref <@ns/name[@version]>             Parse and print a resource reference
    doax auth set <@ns/name[@version]> [--secret <value>]
                                              Authenticate to a target system and cache the credential
    doax auth list                            List cached credentials by authenticator
    doax auth purge [<@ns/name>|--all]        Remove cached credentials
    doax read <@ns/name[@version]> [--param k=v ...] [--metadata] [--secret <value>]
                                              Read a data-source (or its metadata)
    doax execute <@ns/name[@version]> [--param k=v ...] [--dry-run] [--yes] [--secret <value>]
                                              Dry-run or execute an action
    doax app deploy <@ns> <dir>               Deploy a static doax-app to the registry's app host
    doax publish <manifest.json> <package-file>  Publish a resource (identity comes from the manifest;
                                              @global accepts anyone logged in, other namespaces need a role)
    doax login [--email <you@x>] [--code <6 digits>] [--token <pat>] [--registry <url>]
    doax login --web [--registry <url>] [--no-browser] [--timeout <seconds>]
                                              Sign in: email gets a code, code gets a token; store a token directly; or
                                              --web opens the registry's sign-in page and catches the token on loopback
    doax logout [--registry <url>]            Drop the stored token
    doax whoami                               Show your principal and namespaces
    doax audit [--class <c>] [--actor <a>] [--resource <@ns/name>] [--since <iso>] [--limit <n>]
                                              Query the audit log for your namespaces (owners see their events)
    doax --version | --help

Every command runs non-interactively for agent callers:
    --json          Single JSON object on stdout/stderr; errors carry faultClass and a machine-actionable fix
    --no-input      Never prompt (also: DOAX_NO_INPUT=1, or any non-TTY stdin)
    --secret        Supply the authenticator secret inline when nothing is cached
    --yes           Grant tier-2 per-call authorization without a prompt

Registries: the CLI holds a list of registries and resolves each entity from the one that owns
its namespace (doax registry add @corp https://registry.corp.internal). Unrouted namespaces use
the default registry. Audit for a resource is delivered to the registry it came from.

Environment:
    DOAX_REGISTRY   Default registry origin (default: https://registry.doax.io).
    DOAX_NO_INPUT   Set to 1 to force non-interactive mode.
`;

export interface CliResult {
    exitCode: number;
    stdout?: string;
    stderr?: string;
}

export interface CliDeps {
    config: CliConfig;
    fetch: typeof fetch;
    home?: string;
    prompt?: (question: string) => Promise<string>;
    /** Opens a URL in the caller's browser (web login); absent or a no-op leaves only the printed URL. */
    openUrl?: (url: string) => void | Promise<void>;
}

const defaultPrompt = async (question: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        return await rl.question(question);
    } finally {
        rl.close();
    }
};

/** Fire-and-forget: hand the URL to the platform's browser opener. The URL is always printed too. */
function openInBrowser(url: string): void {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    void import("node:child_process").then(({ spawn }) => {
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        child.on("error", () => {
            /* no opener on this machine — the printed URL is the fallback */
        });
        child.unref();
    });
}

const defaultDeps = (): CliDeps => ({
    config: loadCliConfig(process.env),
    fetch: globalThis.fetch,
    home: join(homedir(), ".doax"),
    prompt: process.stdin.isTTY && process.env.DOAX_NO_INPUT !== "1" ? defaultPrompt : undefined,
    openUrl: openInBrowser,
});

const executorDeps = (deps: CliDeps): ExecutorDeps => ({
    config: deps.config,
    fetch: deps.fetch,
    home: deps.home ?? join(homedir(), ".doax"),
    prompt: deps.prompt,
});

/** Runs the CLI against argv (without the node and script entries) and returns what to print. */
export async function run(argv: string[], deps: CliDeps = defaultDeps()): Promise<CliResult> {
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            help: { type: "boolean", short: "h" },
            version: { type: "boolean", short: "v" },
            kind: { type: "string" },
            secret: { type: "string" },
            param: { type: "string", short: "p", multiple: true },
            metadata: { type: "boolean" },
            "dry-run": { type: "boolean" },
            yes: { type: "boolean", short: "y" },
            all: { type: "boolean" },
            json: { type: "boolean" },
            "no-input": { type: "boolean" },
            class: { type: "string" },
            actor: { type: "string" },
            resource: { type: "string" },
            since: { type: "string" },
            until: { type: "string" },
            limit: { type: "string" },
            token: { type: "string" },
            registry: { type: "string" },
            email: { type: "string" },
            code: { type: "string" },
            web: { type: "boolean" },
            "no-browser": { type: "boolean" },
            timeout: { type: "string" },
        },
        allowPositionals: true,
        strict: false,
    });

    if (values.version) return { exitCode: 0, stdout: VERSION };
    if (values.help || positionals.length === 0) return { exitCode: 0, stdout: USAGE };

    const json = Boolean(values.json);
    if (values["no-input"]) deps = { ...deps, prompt: undefined };

    const [command, ...rest] = positionals;
    try {
        switch (command) {
            case "ref":
                return ref(rest[0]);
            case "status":
                return await status(deps);
            case "registry":
                return registryCmd(deps, rest, json);
            case "search":
                return await search(deps, rest.join(" "), values.kind as string | undefined, json);
            case "resolve":
                return await resolveCmd(deps, rest[0]);
            case "auth":
                return await authCmd(deps, rest, values, json);
            case "read":
                return await readCmd(deps, rest[0], values);
            case "execute":
                return await executeCmd(deps, rest[0], values, json);
            case "audit":
                return await auditCmd(deps, values, json);
            case "publish":
                return await publishCmd(deps, rest, json);
            case "app":
                return await appCmd(deps, rest, json);
            case "login":
                return await loginCmd(deps, values, json);
            case "logout": {
                const xd = executorDeps(deps);
                const origin = (values.registry as string | undefined) ?? readRegistryMap(xd).default;
                writeToken(xd, origin, null);
                return { exitCode: 0, stdout: json ? JSON.stringify({ ok: true, loggedOut: origin }) : `logged out of ${origin}` };
            }
            case "whoami":
                return await whoamiCmd(deps, json);
            default:
                return { exitCode: 2, stderr: `doax: unknown command "${command}"\n` + USAGE };
        }
    } catch (err) {
        const detail = (err as ExecutorError).detail ?? {};
        if (json) {
            return { exitCode: 1, stderr: JSON.stringify({ ok: false, command, error: (err as Error).message, faultClass: fault(err), ...detail }) };
        }
        let text = `doax ${command}: ${(err as Error).message} [${fault(err)}]`;
        if (typeof detail.neededScope === "string") text += `\n  needed scope: ${detail.neededScope}`;
        if (typeof detail.fix === "string") text += `\n  fix: ${detail.fix}`;
        return { exitCode: 1, stderr: text };
    }
}

function ref(input: string | undefined): CliResult {
    if (!input) return { exitCode: 2, stderr: "doax ref: missing resource reference\n" + USAGE };
    try {
        const parsed = parseResourceRef(input);
        return { exitCode: 0, stdout: JSON.stringify({ ...parsed, canonical: formatResourceRef(parsed) }, null, 2) };
    } catch (err) {
        return { exitCode: 1, stderr: (err as Error).message };
    }
}

async function status(deps: CliDeps): Promise<CliResult> {
    const map = readRegistryMap(executorDeps(deps));
    try {
        const res = await deps.fetch(`${map.default}/`);
        const body = (await res.json()) as Record<string, unknown>;
        return {
            exitCode: res.ok ? 0 : 1,
            stdout: JSON.stringify({ registry: map.default, scopes: map.scopes, reachable: res.ok, ...body }, null, 2),
        };
    } catch (err) {
        return { exitCode: 1, stderr: `doax status: ${map.default} is unreachable (${(err as Error).message})` };
    }
}

/** Deploy a static doax-app bundle: same role gate as publish, served at the app host. */
async function appCmd(deps: CliDeps, rest: string[], json: boolean): Promise<CliResult> {
    const [sub, nsInput, dir] = rest;
    if (sub !== "deploy" || !nsInput || !dir) return { exitCode: 2, stderr: "doax app: expected `deploy <@ns> <dir>`" };
    if (!/^@[a-z0-9][a-z0-9._-]*$/.test(nsInput)) return { exitCode: 2, stderr: `doax app deploy: invalid namespace ${nsInput}` };
    const { readdir, readFile, stat } = await import("node:fs/promises");
    const { join: joinPath, relative, sep } = await import("node:path");
    async function walk(base: string, current: string): Promise<string[]> {
        const out: string[] = [];
        for (const entry of await readdir(current, { withFileTypes: true })) {
            if (entry.name.startsWith(".")) continue;
            const full = joinPath(current, entry.name);
            if (entry.isDirectory()) out.push(...(await walk(base, full)));
            else out.push(full);
        }
        return out;
    }
    if (!(await stat(dir).catch(() => null))?.isDirectory()) return { exitCode: 2, stderr: `doax app deploy: ${dir} is not a directory` };
    const paths = await walk(dir, dir);
    if (paths.length === 0) return { exitCode: 2, stderr: `doax app deploy: ${dir} is empty` };
    const files = await Promise.all(
        paths.map(async (full) => ({
            path: relative(dir, full).split(sep).join("/"),
            content: (await readFile(full)).toString("base64"),
        })),
    );
    const xdeps = executorDeps(deps);
    const { registryFor: rf, authHeaders: ah } = await import("./executor.ts");
    const origin = rf(xdeps, nsInput.slice(1));
    const auth = ah(xdeps, origin);
    if (!auth.authorization) return { exitCode: 1, stderr: `doax app deploy: not logged in to ${origin}; run doax login` };
    const res = await deps.fetch(`${origin}/apps/${nsInput}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ files }),
    });
    const body = (await res.json()) as { url?: string; files?: number; error?: string };
    if (!res.ok) return { exitCode: 1, stderr: json ? JSON.stringify({ ok: false, ...body }) : `doax app deploy: ${body.error ?? res.status}` };
    return {
        exitCode: 0,
        stdout: json ? JSON.stringify({ ok: true, ...body }) : `deployed ${nsInput} (${body.files} files)\n  ${body.url}`,
    };
}

/** Publish (spec §10): PUT the manifest + package to the registry that owns the namespace. */
async function publishCmd(deps: CliDeps, rest: string[], json: boolean): Promise<CliResult> {
    const [manifestPath, packagePath] = rest;
    if (!manifestPath || !packagePath) return { exitCode: 2, stderr: "doax publish: expected <manifest.json> <package-file>" };
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { identity?: string };
    if (!manifest.identity) return { exitCode: 2, stderr: "doax publish: manifest needs an identity (@ns/name@version)" };
    const parsed = parseResourceRef(manifest.identity);
    if (!parsed.version) return { exitCode: 2, stderr: `doax publish: identity needs a version: ${manifest.identity}` };
    const xdeps = executorDeps(deps);
    const { registryFor: rf, authHeaders: ah } = await import("./executor.ts");
    const origin = rf(xdeps, parsed.namespace);
    const auth = ah(xdeps, origin);
    if (!auth.authorization) {
        return { exitCode: 1, stderr: `doax publish: not logged in to ${origin}; run doax login` };
    }
    const headers: Record<string, string> = { "content-type": "application/json", ...auth };
    const pkg = await readFile(packagePath);
    const res = await deps.fetch(`${origin}/${manifest.identity}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ manifest, package: pkg.toString("base64") }),
    });
    const body = (await res.json()) as { published?: string; digest?: string; error?: string; fix?: string };
    if (!res.ok) {
        const msg = `${body.error ?? res.status}${body.fix ? `\n  fix: ${body.fix}` : ""}`;
        return { exitCode: 1, stderr: json ? JSON.stringify({ ok: false, ...body }) : `doax publish: ${msg}` };
    }
    return {
        exitCode: 0,
        stdout: json ? JSON.stringify({ ok: true, ...body }) : `published ${body.published}\n  digest ${body.digest}\n  at ${origin}`,
    };
}

/**
  * Web sign-in (spec §10.2). Discover the registry's login methods, then catch the token on a
  * loopback listener: the browser opens the registry's own sign-in page, which form-POSTs the
  * token back to 127.0.0.1. `state` (32 CSPRNG bytes) binds the response to this run.
  */
async function webLoginToken(deps: CliDeps, origin: string, values: Record<string, unknown>): Promise<string> {
    const { createServer } = await import("node:http");
    const { randomBytes } = await import("node:crypto");

    // A registry that does not answer /auth/methods offers only email+token, as v0.1 registries do.
    let methods: string[] = ["email", "token"];
    let loginPath: string | undefined;
    try {
        const res = await deps.fetch(`${origin}/auth/methods`);
        if (res.ok) {
            const body = (await res.json()) as { methods?: string[]; web?: { login?: string } };
            if (Array.isArray(body.methods)) methods = body.methods;
            loginPath = body.web?.login;
        }
    } catch {
        /* /auth/methods unreachable — keep the v0.1 default */
    }
    if (!methods.includes("web") || !loginPath) {
        throw new ExecutorError(`${origin} does not offer web login`, "unsupported", {
            fix: `methods offered: ${methods.join(", ")}; use doax login --email or --token`,
        });
    }

    const state = randomBytes(32).toString("base64url");
    const path = `/${randomBytes(16).toString("hex")}`;
    const timeoutMs = Math.max(1, Number(values.timeout) || 300) * 1000;

    return await new Promise<string>((resolve, reject) => {
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (req.method !== "POST" || url.pathname !== path) {
                res.writeHead(400).end("bad request");
                return;
            }
            let raw = "";
            req.on("data", (chunk) => {
                raw += chunk;
                if (raw.length > 8192) req.destroy();
            });
            req.on("end", () => {
                const form = new URLSearchParams(raw);
                const got = form.get("token");
                if (form.get("state") !== state || !got) {
                    res.writeHead(400).end("bad request");
                    return;
                }
                res.writeHead(200, { "content-type": "text/html" }).end(
                    "<!doctype html><p>Signed in to doax. You can close this tab.</p>",
                );
                cleanup();
                resolve(got);
            });
        });
        const timer = setTimeout(() => {
            cleanup();
            reject(
                new ExecutorError(`web login timed out after ${Math.round(timeoutMs / 1000)}s`, "timeout", {
                    fix: `open ${origin}${loginPath} without a callback, then run doax login --token`,
                }),
            );
        }, timeoutMs);
        function cleanup() {
            clearTimeout(timer);
            server.close();
        }
        server.on("error", (err) => {
            cleanup();
            reject(new ExecutorError(`web login listener failed: ${err.message}`, "io"));
        });
        server.listen(0, "127.0.0.1", async () => {
            const addr = server.address() as { port: number };
            const callback = `http://127.0.0.1:${addr.port}${path}`;
            const loginUrl = `${origin}${loginPath}?callback=${encodeURIComponent(callback)}&state=${encodeURIComponent(state)}`;
            process.stderr.write(`opening ${loginUrl}\n`);
            if (!values["no-browser"] && deps.openUrl) {
                try {
                    await deps.openUrl(loginUrl);
                } catch {
                    /* no browser — the printed URL is the fallback */
                }
            }
        });
    });
}

async function loginCmd(deps: CliDeps, values: Record<string, unknown>, json: boolean): Promise<CliResult> {
    const xdeps = executorDeps(deps);
    const origin = ((values.registry as string | undefined) ?? readRegistryMap(xdeps).default).replace(/\/+$/, "");
    let token = values.token as string | undefined;

    // Web sign-in (spec §10.2): the registry's own login page hands the token back on a loopback redirect.
    if (values.web) {
        if (values.email || values.code || values.token) {
            return { exitCode: 2, stderr: "doax login: --web cannot be combined with --email, --code, or --token" };
        }
        token = await webLoginToken(deps, origin, values);
    }

    // Email sign-in: request a code, verify it, receive the token.
    let email = values.email as string | undefined;
    if (!token && !email && xdeps.prompt) email = (await xdeps.prompt(`email for ${origin} (or leave empty to paste a token): `)).trim() || undefined;
    if (!token && email) {
        let code = values.code as string | undefined;
        if (!code) {
            const sent = await deps.fetch(`${origin}/auth/email`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email }),
            });
            const sentBody = (await sent.json()) as { error?: string };
            if (!sent.ok) return { exitCode: 1, stderr: `doax login: ${sentBody.error ?? sent.status}` };
            if (!xdeps.prompt) {
                return {
                    exitCode: 0,
                    stdout: json
                        ? JSON.stringify({ ok: true, sent: true, email, next: `doax login --email ${email} --code <6 digits>` })
                        : `code sent to ${email} — re-run: doax login --email ${email} --code <6 digits>`,
                };
            }
            code = (await xdeps.prompt(`code sent to ${email} — enter it: `)).trim();
        }
        const verified = await deps.fetch(`${origin}/auth/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, code }),
        });
        const verifyBody = (await verified.json()) as { token?: string; error?: string };
        if (!verified.ok || !verifyBody.token) return { exitCode: 1, stderr: `doax login: ${verifyBody.error ?? verified.status}` };
        token = verifyBody.token;
    }

    if (!token && xdeps.prompt) token = (await xdeps.prompt(`token for ${origin} (doax_pat_..., input is echoed): `)).trim();
    if (!token) return { exitCode: 2, stderr: "doax login: provide --email or --token (or run interactively)" };
    const res = await deps.fetch(`${origin}/whoami`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { principal?: string; namespaces?: string[]; error?: string };
    if (!res.ok || !body.principal) {
        return { exitCode: 1, stderr: json ? JSON.stringify({ ok: false, error: body.error ?? res.status }) : `doax login: ${origin} rejected the token (${body.error ?? res.status})` };
    }
    writeToken(xdeps, origin, token);
    return {
        exitCode: 0,
        stdout: json
            ? JSON.stringify({ ok: true, registry: origin, principal: body.principal, namespaces: body.namespaces ?? [] })
            : `logged in to ${origin} as ${body.principal} (namespaces: ${(body.namespaces ?? []).join(", ") || "none"})`,
    };
}

async function whoamiCmd(deps: CliDeps, json: boolean): Promise<CliResult> {
    const xdeps = executorDeps(deps);
    const origin = readRegistryMap(xdeps).default;
    const token = tokenFor(xdeps, origin);
    if (!token) return { exitCode: 1, stderr: `doax whoami: not logged in to ${origin}; run doax login` };
    const res = await deps.fetch(`${origin}/whoami`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { principal?: string; namespaces?: string[]; error?: string };
    if (!res.ok) return { exitCode: 1, stderr: `doax whoami: ${body.error ?? res.status}` };
    return { exitCode: 0, stdout: json ? JSON.stringify({ ok: true, ...body }) : `${body.principal} @ ${origin}\nnamespaces: ${(body.namespaces ?? []).join(", ") || "none"}` };
}

/** Audit query (spec §8.5): your token sees your namespaces; the operator token sees all. */
async function auditCmd(deps: CliDeps, values: Record<string, unknown>, json: boolean): Promise<CliResult> {
    const xdeps = executorDeps(deps);
    const base = readRegistryMap(xdeps).default;
    const bearer = tokenFor(xdeps, base);
    const admin = process.env.DOAX_ADMIN_TOKEN;
    if (!bearer && !admin) return { exitCode: 2, stderr: "doax audit: log in first (doax login), or set DOAX_ADMIN_TOKEN as the operator" };
    const url = new URL(`${base}/audit`);
    for (const key of ["class", "actor", "resource", "since", "until", "limit"] as const) {
        if (typeof values[key] === "string" && values[key]) url.searchParams.set(key, values[key] as string);
    }
    const headers: Record<string, string> = bearer ? { authorization: `Bearer ${bearer}` } : { "x-doax-admin-token": admin! };
    const res = await deps.fetch(url, { headers });
    const body = (await res.json()) as { events?: Record<string, unknown>[]; count?: number; error?: string };
    if (!res.ok || !body.events) {
        return { exitCode: 1, stderr: json ? JSON.stringify({ ok: false, error: body.error ?? res.status }) : `doax audit: ${body.error ?? res.status}` };
    }
    if (json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, count: body.count, events: body.events }) };
    if (body.events.length === 0) return { exitCode: 0, stdout: "no audit events match" };
    const lines = body.events.map((e) => {
        const outcome = (e.outcome as { status?: string; reasonCode?: string }) ?? {};
        return `${e.timestamp}  ${String(e.class).padEnd(13)} ${String(e.actor).padEnd(24)} ${e.resource}  ${outcome.status ?? ""}${outcome.reasonCode && outcome.reasonCode !== "ok" ? ` [${outcome.reasonCode}]` : ""}`;
    });
    return { exitCode: 0, stdout: lines.join("\n") };
}

const REGISTRY_KEY = /^(default|@[a-z0-9][a-z0-9._-]*)$/;

/** The client's registry list (architecture: multiple registries, entities looked up by namespace). */
function registryCmd(deps: CliDeps, rest: string[], json: boolean): CliResult {
    const [sub, key, url] = rest;
    const xdeps = executorDeps(deps);

    if (!sub || sub === "list") {
        const map = readRegistryMap(xdeps);
        if (json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, default: map.default, scopes: map.scopes }) };
        const lines = [`default -> ${map.default}`, ...Object.entries(map.scopes).map(([ns, origin]) => `${ns} -> ${origin}`)];
        return { exitCode: 0, stdout: lines.join("\n") };
    }

    if (sub === "add") {
        if (!key || !url) return { exitCode: 2, stderr: "doax registry add: expected <@ns|default> <url>" };
        if (!REGISTRY_KEY.test(key)) return { exitCode: 2, stderr: `doax registry add: key must be @namespace or "default", got "${key}"` };
        if (!/^https?:\/\//.test(url)) return { exitCode: 2, stderr: `doax registry add: url must be http(s), got "${url}"` };
        writeRegistryEntry(xdeps, key, url);
        return { exitCode: 0, stdout: json ? JSON.stringify({ ok: true, added: { [key]: url.replace(/\/+$/, "") } }) : `${key} -> ${url.replace(/\/+$/, "")}` };
    }

    if (sub === "remove") {
        if (!key || !REGISTRY_KEY.test(key)) return { exitCode: 2, stderr: "doax registry remove: expected <@ns|default>" };
        writeRegistryEntry(xdeps, key, null);
        return { exitCode: 0, stdout: json ? JSON.stringify({ ok: true, removed: key }) : `removed ${key}` };
    }

    return { exitCode: 2, stderr: "doax registry: expected `add <@ns|default> <url>`, `list`, or `remove <@ns|default>`" };
}

async function search(deps: CliDeps, query: string, kind: string | undefined, json: boolean): Promise<CliResult> {
    const url = new URL(`${readRegistryMap(executorDeps(deps)).default}/search`);
    url.searchParams.set("q", query);
    if (kind) url.searchParams.set("kind", kind);
    const res = await deps.fetch(url);
    const body = (await res.json()) as { results?: ResolvedResource[]; error?: string };
    if (!res.ok || !body.results) {
        return {
            exitCode: 1,
            stderr: json ? JSON.stringify({ ok: false, error: body.error ?? String(res.status) }) : `doax search: ${body.error ?? res.status}`,
        };
    }
    if (json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, query, results: body.results }) };
    if (body.results.length === 0) return { exitCode: 0, stdout: `no resources match "${query}"` };
    const lines = body.results.map((r) => {
        const m = r.manifest as { requiredTier?: number; summary?: string };
        return `${r.identity}\n    ${r.kind} · tier ${m.requiredTier ?? "?"} · ${r.verification}\n    ${m.summary ?? ""}`;
    });
    return { exitCode: 0, stdout: lines.join("\n") };
}

async function resolveCmd(deps: CliDeps, refInput: string | undefined): Promise<CliResult> {
    if (!refInput) return { exitCode: 2, stderr: "doax resolve: missing resource reference" };
    const resolved = await resolveResource(executorDeps(deps), refInput);
    return { exitCode: 0, stdout: JSON.stringify(resolved, null, 2) };
}

/** Parses repeated --param k=v into the operation's input object. Values parse as JSON when they can. */
function paramsToInput(params: unknown): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    for (const pair of Array.isArray(params) ? (params as string[]) : []) {
        const at = pair.indexOf("=");
        if (at < 1) throw new ExecutorError(`--param expects k=v, got "${pair}"`, "bad-parameter");
        const key = pair.slice(0, at);
        const raw = pair.slice(at + 1);
        try {
            input[key] = JSON.parse(raw);
        } catch {
            input[key] = raw;
        }
    }
    return input;
}

/**
  * The authentication specification's interaction details (§4.7.1) tell the caller where to
  * obtain the secret; the CLI must display that entry point when it asks.
  */
function secretPrompt(authResolved: ResolvedResource): string {
    const spec = authResolved.manifest.authentication as
        | { interactionDetails?: Record<string, string | { instruction?: string; entryPoint?: string; docs?: string }> }
        | undefined;
    const details = spec?.interactionDetails?.["secret-entry"];
    const lines: string[] = [];
    if (typeof details === "string") lines.push(`  how: ${details}`);
    else if (details) {
        if (details.instruction) lines.push(`  how: ${details.instruction}`);
        if (details.entryPoint) lines.push(`  get one: ${details.entryPoint}`);
        if (details.docs) lines.push(`  docs: ${details.docs}`);
    }
    lines.push(`secret for ${authResolved.identity} (input is echoed): `);
    return lines.join("\n");
}

/** Run the Authenticator's flow (§4.7): collect the secret, authenticate, cache, audit. */
async function acquireCredential(deps: ExecutorDeps, authResolved: ResolvedResource, secret: string) {
    const module = await loadPackage(deps, authResolved);
    const effective = effectiveTierFor(authResolved, null);
    try {
        const outcome = (await invokeOperation(module, authResolved, "authenticate", { mode: "initial", secret }, {})) as {
            credential: Record<string, unknown>;
            principal?: Record<string, unknown>;
        };
        const entry = {
            authenticator: authResolved.identity,
            credential: outcome.credential,
            principal: outcome.principal,
            storedAt: new Date().toISOString(),
        };
        writeCredential(deps, credentialKey(authResolved.identity), entry);
        await audit(deps, [
            baseEvent(deps, "auth", authResolved.identity, effective, { status: "success", reasonCode: "ok" }, { authenticator: authResolved.identity }),
        ], authResolved.origin);
        return entry;
    } catch (err) {
        await audit(deps, [
            baseEvent(deps, "auth", authResolved.identity, effective, { status: "failure", reasonCode: fault(err) }, { authenticator: authResolved.identity }),
        ], authResolved.origin);
        throw err;
    }
}

/**
  * Resolve the resource's Authenticator, its cached credential, and the effective tier
  * (§9.1 steps 4-5). No pre-auth is required: when nothing is cached and the session is
  * interactive, the auth flow runs inline, in context, and the operation continues.
  */
async function credentialFor(deps: ExecutorDeps, resolved: ResolvedResource, inlineSecret?: string) {
    const authRef = resolved.manifest.authenticator;
    if (!authRef || authRef === "none") return { credential: null, authenticator: "none" as const, effective: effectiveTierFor(resolved, null) };
    const authResolved = await resolveResource(deps, String(authRef));
    const effective = effectiveTierFor(resolved, (authResolved.manifest.requiredTier as Tier | undefined) ?? null);
    let entry = readCredentials(deps)[credentialKey(String(authRef))];
    if (!entry && inlineSecret) {
        entry = await acquireCredential(deps, authResolved, inlineSecret);
    }
    if (!entry) {
        if (!deps.prompt) {
            const auth = authResolved.manifest.authentication as { interactionDetails?: Record<string, unknown> } | undefined;
            throw new ExecutorError(`no cached credential for ${authRef}`, "credential-missing", {
                willRequireInteraction: true,
                authenticator: authResolved.identity,
                interactionDetails: auth?.interactionDetails ?? null,
                fix: `re-run with --secret <value>, or: doax auth set ${String(authRef)} --secret <value>`,
            });
        }
        const secret = (await deps.prompt(`${resolved.identity} needs ${authRef}\n${secretPrompt(authResolved)}`)).trim();
        if (!secret) throw new ExecutorError("no secret entered", "credential-missing");
        entry = await acquireCredential(deps, authResolved, secret);
    }
    return { credential: entry.credential, authenticator: String(authRef), effective };
}

async function authCmd(deps: CliDeps, rest: string[], values: Record<string, unknown>, json: boolean): Promise<CliResult> {
    const [sub, refInput] = rest;
    const xdeps = executorDeps(deps);

    if (sub === "list") {
        const all = readCredentials(xdeps);
        const keys = Object.keys(all);
        if (json) {
            const entries = keys.map((k) => ({ key: k, authenticator: all[k]!.authenticator, principal: all[k]!.principal ?? {}, storedAt: all[k]!.storedAt }));
            return { exitCode: 0, stdout: JSON.stringify({ ok: true, credentials: entries }) };
        }
        if (keys.length === 0) return { exitCode: 0, stdout: "no cached credentials" };
        return {
            exitCode: 0,
            stdout: keys
                .map((k) => `${k}\n    authenticator ${all[k]!.authenticator} · stored ${all[k]!.storedAt}\n    principal ${JSON.stringify(all[k]!.principal ?? {})}`)
                .join("\n"),
        };
    }

    if (sub === "purge") {
        if (values.all) {
            purgeCredentials(xdeps);
            return { exitCode: 0, stdout: json ? JSON.stringify({ ok: true, purged: "all" }) : "purged all cached credentials" };
        }
        if (!refInput) return { exitCode: 2, stderr: "doax auth purge: give an authenticator ref or --all" };
        writeCredential(xdeps, credentialKey(refInput), null);
        return { exitCode: 0, stdout: json ? JSON.stringify({ ok: true, purged: credentialKey(refInput) }) : `purged ${credentialKey(refInput)}` };
    }

    if (sub !== "set" || !refInput) return { exitCode: 2, stderr: "doax auth: expected `set <ref>`, `list`, or `purge`" };

    const resolved = await resolveResource(xdeps, refInput);
    if (resolved.kind !== "authenticator") {
        return { exitCode: 1, stderr: `doax auth set: ${resolved.identity} is a ${resolved.kind}, not an authenticator` };
    }
    let secret = values.secret as string | undefined;
    if (!secret && xdeps.prompt) secret = (await xdeps.prompt(secretPrompt(resolved))).trim();
    if (!secret) {
        const auth = resolved.manifest.authentication as { interactionDetails?: Record<string, unknown> } | undefined;
        return {
            exitCode: 2,
            stderr: json
                ? JSON.stringify({ ok: false, error: "secret required", faultClass: "credential-missing", willRequireInteraction: true, interactionDetails: auth?.interactionDetails ?? null, fix: "re-run with --secret <value>" })
                : "doax auth set: provide --secret (or run interactively)",
        };
    }

    const entry = await acquireCredential(xdeps, resolved, secret);
    return {
        exitCode: 0,
        stdout: json
            ? JSON.stringify({ ok: true, authenticator: resolved.identity, principal: entry.principal ?? {} })
            : `authenticated via ${resolved.identity}\nprincipal: ${JSON.stringify(entry.principal ?? {})}`,
    };
}

async function readCmd(deps: CliDeps, refInput: string | undefined, values: Record<string, unknown>): Promise<CliResult> {
    if (!refInput) return { exitCode: 2, stderr: "doax read: missing resource reference" };
    const xdeps = executorDeps(deps);
    const resolved = await resolveResource(xdeps, refInput);
    if (resolved.kind !== "data-source") return { exitCode: 1, stderr: `doax read: ${resolved.identity} is a ${resolved.kind}, not a data-source` };

    const { credential, authenticator, effective } = await credentialFor(xdeps, resolved, values.secret as string | undefined);
    await confirmTier(xdeps, effective, Boolean(values.yes), `read ${resolved.identity}`);
    const module = await loadPackage(xdeps, resolved);
    const operation = values.metadata ? "metadata" : "read";
    const eventClass = values.metadata ? "metadata-read" : "data-read";
    try {
        const result = (await invokeOperation(module, resolved, operation, paramsToInput(values.param), { credential })) as Record<string, unknown>;
        const freshness = (result.freshness ?? (result.metadata as { lastRefreshed?: string } | undefined)?.lastRefreshed) as string | undefined;
        await audit(xdeps, [
            baseEvent(xdeps, eventClass, resolved.identity, effective, { status: "success", reasonCode: "ok" }, { authenticator, sourceFreshness: freshness }),
        ], resolved.origin);
        return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
    } catch (err) {
        await audit(xdeps, [
            baseEvent(xdeps, eventClass, resolved.identity, effective, { status: "failure", reasonCode: fault(err) }, { authenticator }),
        ], resolved.origin);
        throw err;
    }
}

async function executeCmd(deps: CliDeps, refInput: string | undefined, values: Record<string, unknown>, json: boolean): Promise<CliResult> {
    if (!refInput) return { exitCode: 2, stderr: "doax execute: missing resource reference" };
    const xdeps = executorDeps(deps);
    const resolved = await resolveResource(xdeps, refInput);
    if (resolved.kind !== "action") return { exitCode: 1, stderr: `doax execute: ${resolved.identity} is a ${resolved.kind}, not an action` };

    const { credential, authenticator, effective } = await credentialFor(xdeps, resolved, values.secret as string | undefined);
    const module = await loadPackage(xdeps, resolved);
    const input = paramsToInput(values.param);
    const dryRunMode = resolved.manifest.dryRunMode ?? "none";

    if (values["dry-run"]) {
        if (dryRunMode === "none") return { exitCode: 1, stderr: `doax execute: ${resolved.identity} declares dry-run mode "none"` };
        try {
            const result = await invokeOperation(module, resolved, "dry-run", input, { credential });
            await audit(xdeps, [
                baseEvent(xdeps, "dry-run", resolved.identity, effective, { status: "success", reasonCode: "ok" }, {
                    authenticator,
                    dryRun: { mode: dryRunMode as "predictive" | "native", estimated: dryRunMode === "predictive" },
                }),
            ], resolved.origin);
            if (json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, estimated: dryRunMode === "predictive", mode: dryRunMode, result }) };
            const label = dryRunMode === "predictive" ? "ESTIMATED (predictive dry-run; not guaranteed by the target)" : "native dry-run";
            return { exitCode: 0, stdout: `${label}\n${JSON.stringify(result, null, 2)}` };
        } catch (err) {
            await audit(xdeps, [
                baseEvent(xdeps, "dry-run", resolved.identity, effective, { status: "failure", reasonCode: fault(err) }, { authenticator }),
            ], resolved.origin);
            throw err;
        }
    }

    await confirmTier(xdeps, effective, Boolean(values.yes), `execute ${resolved.identity}`);
    if (dryRunMode === "none" && !values.yes) {
        return { exitCode: 1, stderr: `doax execute: ${resolved.identity} cannot be previewed (dry-run: none); re-run with --yes to proceed` };
    }
    const idempotencyKey = randomUUID();
    try {
        const result = await invokeOperation(module, resolved, "execute", input, { credential, idempotencyKey });
        await audit(xdeps, [
            baseEvent(xdeps, "execute", resolved.identity, effective, { status: "success", reasonCode: "ok" }, { authenticator, idempotencyKey }),
        ], resolved.origin);
        return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
    } catch (err) {
        await audit(xdeps, [
            baseEvent(xdeps, "execute", resolved.identity, effective, { status: "failure", reasonCode: fault(err) }, { authenticator, idempotencyKey }),
        ], resolved.origin);
        throw err;
    }
}

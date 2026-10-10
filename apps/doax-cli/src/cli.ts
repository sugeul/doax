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
    type ResolvedResource,
    resolveResource,
    writeCredential,
} from "./executor.ts";

export const VERSION = "0.2.0";

const USAGE = `doax ${VERSION} — Executor CLI for the doax registry

Usage:
    doax status                               Show the registry this CLI talks to and whether it answers
    doax search <query> [--kind <kind>]       Search resources visible to you
    doax resolve <@ns/name[@version]>         Resolve a resource and print its manifest
    doax ref <@ns/name[@version]>             Parse and print a resource reference
    doax auth set <@ns/name[@version]> [--secret <value>]
                                              Authenticate to a target system and cache the credential
    doax auth list                            List cached credentials by authenticator
    doax auth purge [<@ns/name>|--all]        Remove cached credentials
    doax read <@ns/name[@version]> [--param k=v ...] [--metadata]
                                              Read a data-source (or its metadata)
    doax execute <@ns/name[@version]> [--param k=v ...] [--dry-run] [--yes]
                                              Dry-run or execute an action
    doax --version | --help

Environment:
    DOAX_REGISTRY   Registry origin (default: https://registry.doax.io). Point it at a private install.
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
}

const defaultPrompt = async (question: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        return await rl.question(question);
    } finally {
        rl.close();
    }
};

const defaultDeps = (): CliDeps => ({
    config: loadCliConfig(process.env),
    fetch: globalThis.fetch,
    home: join(homedir(), ".doax"),
    prompt: process.stdin.isTTY ? defaultPrompt : undefined,
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
        },
        allowPositionals: true,
        strict: false,
    });

    if (values.version) return { exitCode: 0, stdout: VERSION };
    if (values.help || positionals.length === 0) return { exitCode: 0, stdout: USAGE };

    const [command, ...rest] = positionals;
    try {
        switch (command) {
            case "ref":
                return ref(rest[0]);
            case "status":
                return await status(deps);
            case "search":
                return await search(deps, rest.join(" "), values.kind as string | undefined);
            case "resolve":
                return await resolveCmd(deps, rest[0]);
            case "auth":
                return await authCmd(deps, rest, values);
            case "read":
                return await readCmd(deps, rest[0], values);
            case "execute":
                return await executeCmd(deps, rest[0], values);
            default:
                return { exitCode: 2, stderr: `doax: unknown command "${command}"\n` + USAGE };
        }
    } catch (err) {
        return { exitCode: 1, stderr: `doax ${command}: ${(err as Error).message} [${fault(err)}]` };
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

async function status({ config, fetch }: CliDeps): Promise<CliResult> {
    try {
        const res = await fetch(`${config.registry}/`);
        const body = (await res.json()) as Record<string, unknown>;
        return {
            exitCode: res.ok ? 0 : 1,
            stdout: JSON.stringify({ registry: config.registry, reachable: res.ok, ...body }, null, 2),
        };
    } catch (err) {
        return { exitCode: 1, stderr: `doax status: ${config.registry} is unreachable (${(err as Error).message})` };
    }
}

async function search(deps: CliDeps, query: string, kind: string | undefined): Promise<CliResult> {
    const url = new URL(`${deps.config.registry}/search`);
    url.searchParams.set("q", query);
    if (kind) url.searchParams.set("kind", kind);
    const res = await deps.fetch(url);
    const body = (await res.json()) as { results?: ResolvedResource[]; error?: string };
    if (!res.ok || !body.results) return { exitCode: 1, stderr: `doax search: ${body.error ?? res.status}` };
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
        ]);
        return entry;
    } catch (err) {
        await audit(deps, [
            baseEvent(deps, "auth", authResolved.identity, effective, { status: "failure", reasonCode: fault(err) }, { authenticator: authResolved.identity }),
        ]);
        throw err;
    }
}

/**
  * Resolve the resource's Authenticator, its cached credential, and the effective tier
  * (§9.1 steps 4-5). No pre-auth is required: when nothing is cached and the session is
  * interactive, the auth flow runs inline, in context, and the operation continues.
  */
async function credentialFor(deps: ExecutorDeps, resolved: ResolvedResource) {
    const authRef = resolved.manifest.authenticator;
    if (!authRef || authRef === "none") return { credential: null, authenticator: "none" as const, effective: effectiveTierFor(resolved, null) };
    const authResolved = await resolveResource(deps, String(authRef));
    const effective = effectiveTierFor(resolved, (authResolved.manifest.requiredTier as Tier | undefined) ?? null);
    let entry = readCredentials(deps)[credentialKey(String(authRef))];
    if (!entry) {
        if (!deps.prompt) {
            throw new ExecutorError(
                `no cached credential for ${authRef}; run interactively, or: doax auth set ${String(authRef)} --secret ...`,
                "credential-missing",
            );
        }
        const secret = (await deps.prompt(`${resolved.identity} needs ${authRef}\nsecret for ${authResolved.identity} (input is echoed): `)).trim();
        if (!secret) throw new ExecutorError("no secret entered", "credential-missing");
        entry = await acquireCredential(deps, authResolved, secret);
    }
    return { credential: entry.credential, authenticator: String(authRef), effective };
}

async function authCmd(deps: CliDeps, rest: string[], values: Record<string, unknown>): Promise<CliResult> {
    const [sub, refInput] = rest;
    const xdeps = executorDeps(deps);

    if (sub === "list") {
        const all = readCredentials(xdeps);
        const keys = Object.keys(all);
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
            return { exitCode: 0, stdout: "purged all cached credentials" };
        }
        if (!refInput) return { exitCode: 2, stderr: "doax auth purge: give an authenticator ref or --all" };
        writeCredential(xdeps, credentialKey(refInput), null);
        return { exitCode: 0, stdout: `purged ${credentialKey(refInput)}` };
    }

    if (sub !== "set" || !refInput) return { exitCode: 2, stderr: "doax auth: expected `set <ref>`, `list`, or `purge`" };

    const resolved = await resolveResource(xdeps, refInput);
    if (resolved.kind !== "authenticator") {
        return { exitCode: 1, stderr: `doax auth set: ${resolved.identity} is a ${resolved.kind}, not an authenticator` };
    }
    let secret = values.secret as string | undefined;
    if (!secret && xdeps.prompt) secret = (await xdeps.prompt(`secret for ${resolved.identity} (input is echoed): `)).trim();
    if (!secret) return { exitCode: 2, stderr: "doax auth set: provide --secret (or run interactively)" };

    const entry = await acquireCredential(xdeps, resolved, secret);
    return { exitCode: 0, stdout: `authenticated via ${resolved.identity}\nprincipal: ${JSON.stringify(entry.principal ?? {})}` };
}

async function readCmd(deps: CliDeps, refInput: string | undefined, values: Record<string, unknown>): Promise<CliResult> {
    if (!refInput) return { exitCode: 2, stderr: "doax read: missing resource reference" };
    const xdeps = executorDeps(deps);
    const resolved = await resolveResource(xdeps, refInput);
    if (resolved.kind !== "data-source") return { exitCode: 1, stderr: `doax read: ${resolved.identity} is a ${resolved.kind}, not a data-source` };

    const { credential, authenticator, effective } = await credentialFor(xdeps, resolved);
    await confirmTier(xdeps, effective, Boolean(values.yes), `read ${resolved.identity}`);
    const module = await loadPackage(xdeps, resolved);
    const operation = values.metadata ? "metadata" : "read";
    const eventClass = values.metadata ? "metadata-read" : "data-read";
    try {
        const result = (await invokeOperation(module, resolved, operation, paramsToInput(values.param), { credential })) as Record<string, unknown>;
        const freshness = (result.freshness ?? (result.metadata as { lastRefreshed?: string } | undefined)?.lastRefreshed) as string | undefined;
        await audit(xdeps, [
            baseEvent(xdeps, eventClass, resolved.identity, effective, { status: "success", reasonCode: "ok" }, { authenticator, sourceFreshness: freshness }),
        ]);
        return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
    } catch (err) {
        await audit(xdeps, [
            baseEvent(xdeps, eventClass, resolved.identity, effective, { status: "failure", reasonCode: fault(err) }, { authenticator }),
        ]);
        throw err;
    }
}

async function executeCmd(deps: CliDeps, refInput: string | undefined, values: Record<string, unknown>): Promise<CliResult> {
    if (!refInput) return { exitCode: 2, stderr: "doax execute: missing resource reference" };
    const xdeps = executorDeps(deps);
    const resolved = await resolveResource(xdeps, refInput);
    if (resolved.kind !== "action") return { exitCode: 1, stderr: `doax execute: ${resolved.identity} is a ${resolved.kind}, not an action` };

    const { credential, authenticator, effective } = await credentialFor(xdeps, resolved);
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
            ]);
            const label = dryRunMode === "predictive" ? "ESTIMATED (predictive dry-run; not guaranteed by the target)" : "native dry-run";
            return { exitCode: 0, stdout: `${label}\n${JSON.stringify(result, null, 2)}` };
        } catch (err) {
            await audit(xdeps, [
                baseEvent(xdeps, "dry-run", resolved.identity, effective, { status: "failure", reasonCode: fault(err) }, { authenticator }),
            ]);
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
        ]);
        return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
    } catch (err) {
        await audit(xdeps, [
            baseEvent(xdeps, "execute", resolved.identity, effective, { status: "failure", reasonCode: fault(err) }, { authenticator, idempotencyKey }),
        ]);
        throw err;
    }
}

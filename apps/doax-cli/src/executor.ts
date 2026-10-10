import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CliConfig } from "@doax/config";
import {
    type AuditEvent,
    computeEffectiveTier,
    type EffectiveTier,
    formatResourceRef,
    parseResourceRef,
    type Tier,
    type TierRequirement,
} from "@doax/protocol";

/**
  * The executor side of the CLI (spec §9): resolve, verify integrity, run the authorization
  * flow for the effective tier, obtain credentials through the referenced Authenticator,
  * invoke the package through its mapped Fixed Interface operations, and emit audit events.
  */

export interface ResolvedResource {
    identity: string;
    kind: string;
    manifest: Record<string, unknown> & {
        requiredTier?: Tier;
        authenticator?: string;
        interfaceMapping?: Record<string, { kind: string }>;
        dryRunMode?: string;
        idempotency?: string;
    };
    digest: string;
    visibility: string;
    verification: string;
    lifecycle: string;
    package: string;
    warning?: string;
    /** Registry origin that resolved this resource; packages and audit go back to it. */
    origin: string;
}

/* ---------- the client's registry list: namespaces route to registries (npm-scope style) ---------- */

export interface RegistryMap {
    default: string;
    /** `@namespace` -> registry origin */
    scopes: Record<string, string>;
}

const configPath = (deps: ExecutorDeps) => join(deps.home, "config.json");

export function readRegistryMap(deps: ExecutorDeps): RegistryMap {
    let registries: Record<string, string> = {};
    try {
        const file = JSON.parse(readFileSync(configPath(deps), "utf8")) as { registries?: Record<string, string> };
        registries = file.registries ?? {};
    } catch {
        /* no config yet */
    }
    const scopes: Record<string, string> = {};
    for (const [key, url] of Object.entries(registries)) {
        if (key.startsWith("@")) scopes[key] = url.replace(/\/+$/, "");
    }
    return { default: (registries.default ?? deps.config.registry).replace(/\/+$/, ""), scopes };
}

export function writeRegistryEntry(deps: ExecutorDeps, key: string, url: string | null): void {
    let file: { registries?: Record<string, string> } = {};
    try {
        file = JSON.parse(readFileSync(configPath(deps), "utf8")) as typeof file;
    } catch {
        /* new config */
    }
    file.registries ??= {};
    if (url) file.registries[key] = url.replace(/\/+$/, "");
    else delete file.registries[key];
    mkdirSync(deps.home, { recursive: true });
    writeFileSync(configPath(deps), JSON.stringify(file, null, 2));
}

/** The registry that owns a namespace: its scoped entry, else the default. */
export function registryFor(deps: ExecutorDeps, namespace: string): string {
    const map = readRegistryMap(deps);
    return map.scopes[`@${namespace}`] ?? map.default;
}

export interface ExecutorDeps {
    config: CliConfig;
    fetch: typeof fetch;
    /** Directory holding credentials, package cache, and the audit buffer. Default: ~/.doax */
    home: string;
    /** Collects a secret or confirmation from the user; absent in non-interactive runs. */
    prompt?: (question: string) => Promise<string>;
}

export class ExecutorError extends Error {
    readonly faultClass: string;
    /** Machine-actionable context for non-interactive callers: what is missing and how to proceed. */
    readonly detail: Record<string, unknown>;

    constructor(message: string, faultClass: string = "undeclared", detail: Record<string, unknown> = {}) {
        super(message);
        this.faultClass = faultClass;
        this.detail = detail;
    }
}

const fault = (err: unknown): string => (err as { faultClass?: string })?.faultClass ?? "undeclared";

export async function resolveResource(deps: ExecutorDeps, ref: string): Promise<ResolvedResource> {
    const parsed = parseResourceRef(ref);
    const canonical = formatResourceRef(parsed);
    const origin = registryFor(deps, parsed.namespace);
    const res = await deps.fetch(`${origin}/${canonical}`);
    const body = (await res.json()) as ResolvedResource & { error?: string };
    if (!res.ok) throw new ExecutorError(`resolve ${canonical} at ${origin}: ${body.error ?? res.status}`, "resolve-failed");
    return { ...body, origin };
}

/** Fetch the package, refuse on digest mismatch (§9.2), cache by digest, return the module. */
export async function loadPackage(deps: ExecutorDeps, resolved: ResolvedResource): Promise<Record<string, unknown>> {
    const cacheDir = join(deps.home, "cache");
    const cached = join(cacheDir, `${resolved.digest.replace(/[^a-z0-9-]/gi, "_")}.mjs`);
    if (!existsSync(cached)) {
        const res = await deps.fetch(`${resolved.origin}${resolved.package}`);
        if (!res.ok) throw new ExecutorError(`fetch ${resolved.package}: HTTP ${res.status}`, "fetch-failed");
        const content = Buffer.from(await res.arrayBuffer());
        const digest = `sha256-${createHash("sha256").update(content).digest("hex")}`;
        if (digest !== resolved.digest) {
            throw new ExecutorError(`integrity mismatch for ${resolved.identity}: manifest ${resolved.digest}, package ${digest}`, "integrity-mismatch");
        }
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cached, content);
        await audit(
            deps,
            [baseEvent(deps, "fetch", resolved.identity, { tier: 4, strengthenedBy: [] }, { status: "success", reasonCode: "ok" })],
            resolved.origin,
        );
    }
    return (await import(pathToFileURL(cached).href)) as Record<string, unknown>;
}

/** Invoke only operations mapped in the Manifest (§4.6, §9.2); only native bindings run on-device. */
export async function invokeOperation(
    module: Record<string, unknown>,
    resolved: ResolvedResource,
    operation: string,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
): Promise<unknown> {
    const binding = resolved.manifest.interfaceMapping?.[operation];
    if (!binding) throw new ExecutorError(`${resolved.identity} does not map operation "${operation}"`, "unmapped-operation");
    if (binding.kind !== "native") throw new ExecutorError(`binding kind "${binding.kind}" is not supported by this CLI yet`, "unsupported-binding");
    const exportName = operation === "dry-run" ? "dryRun" : operation;
    const fn = module[exportName];
    if (typeof fn !== "function") throw new ExecutorError(`package for ${resolved.identity} does not export ${exportName}()`, "broken-package");
    return await (fn as (i: unknown, c: unknown) => Promise<unknown>)(input, context);
}

/* ---------- credentials (spec §7.6: keyed by caller and Authenticator, never by resource) ---------- */

interface CredentialEntry {
    authenticator: string;
    credential: Record<string, unknown>;
    principal?: Record<string, unknown>;
    storedAt: string;
}

const credentialsPath = (deps: ExecutorDeps) => join(deps.home, "credentials.json");

/** Cache key is the versionless authenticator ref: one flow, one entry, shared by referencing resources. */
export const credentialKey = (authenticatorIdentity: string): string => {
    const ref = parseResourceRef(authenticatorIdentity);
    return `@${ref.namespace}/${ref.name}`;
};

export function readCredentials(deps: ExecutorDeps): Record<string, CredentialEntry> {
    try {
        return JSON.parse(readFileSync(credentialsPath(deps), "utf8")) as Record<string, CredentialEntry>;
    } catch {
        return {};
    }
}

export function writeCredential(deps: ExecutorDeps, key: string, entry: CredentialEntry | null): void {
    const all = readCredentials(deps);
    if (entry) all[key] = entry;
    else delete all[key];
    mkdirSync(deps.home, { recursive: true });
    writeFileSync(credentialsPath(deps), JSON.stringify(all, null, 2));
    chmodSync(credentialsPath(deps), 0o600);
}

export function purgeCredentials(deps: ExecutorDeps): void {
    rmSync(credentialsPath(deps), { force: true });
}

/* ---------- tiers (spec §7.4, §9.1 step 4) ---------- */

export function effectiveTierFor(resolved: ResolvedResource, authenticatorTier: Tier | null): EffectiveTier {
    const others: TierRequirement[] = authenticatorTier
        ? [{ source: "authenticator", tier: authenticatorTier, detail: String(resolved.manifest.authenticator) }]
        : [];
    return computeEffectiveTier(resolved.manifest.requiredTier ?? 4, others);
}

/** Tier 2 demands per-call authorization confirmation; tier 1 additionally forces interactive auth. */
export async function confirmTier(deps: ExecutorDeps, effective: EffectiveTier, assumeYes: boolean, what: string): Promise<void> {
    if (effective.tier > 2 || assumeYes) return;
    if (!deps.prompt) {
        throw new ExecutorError(`tier ${effective.tier} requires per-call confirmation: re-run with --yes`, "authorization-required", {
            willRequireInteraction: false,
            fix: "re-run the same command with --yes to record the caller's authorization",
        });
    }
    const answer = (await deps.prompt(`Tier ${effective.tier}: authorize ${what}? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new ExecutorError("authorization declined by the caller", "authorization-declined");
}

/* ---------- audit (spec §8.3, §9.1 step 9: deliver, buffer on failure, never discard) ---------- */

const bufferPath = (deps: ExecutorDeps) => join(deps.home, "audit-buffer.jsonl");

export function baseEvent(
    deps: ExecutorDeps,
    eventClass: AuditEvent["class"],
    resource: string,
    effectiveTier: EffectiveTier,
    outcome: AuditEvent["outcome"],
    extra: Partial<AuditEvent> = {},
): AuditEvent {
    return {
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        class: eventClass,
        actor: `${userInfo().username}@${hostname()}`,
        executionLocation: { kind: "caller-device", deviceId: hostname() },
        resource,
        effectiveTier,
        outcome,
        ...extra,
    };
}

export async function audit(deps: ExecutorDeps, events: AuditEvent[], origin?: string): Promise<void> {
    const destination = origin ?? readRegistryMap(deps).default;
    const pending: AuditEvent[] = [];
    try {
        const buffered = readFileSync(bufferPath(deps), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as AuditEvent);
        pending.push(...buffered);
    } catch {
        /* no buffer */
    }
    pending.push(...events);
    try {
        const res = await deps.fetch(`${destination}/audit`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ events: pending }),
        });
        if (!res.ok) throw new Error(`audit ingest HTTP ${res.status}`);
        rmSync(bufferPath(deps), { force: true });
    } catch {
        mkdirSync(deps.home, { recursive: true });
        writeFileSync(bufferPath(deps), "");
        for (const event of pending) appendFileSync(bufferPath(deps), `${JSON.stringify(event)}\n`);
    }
}

export { fault };

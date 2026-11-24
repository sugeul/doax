import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  * The executor side of the CLI (spec §9): resolve, verify integrity, relay the confirmation the
  * effective tier calls for, obtain credentials through the referenced Authenticator,
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

/* ---------- registry tokens (phase-1 PATs; §7.2 tokens replace the value, not the plumbing) ---------- */

export function readTokens(deps: ExecutorDeps): Record<string, string> {
    try {
        const file = JSON.parse(readFileSync(configPath(deps), "utf8")) as { tokens?: Record<string, string> };
        return file.tokens ?? {};
    } catch {
        return {};
    }
}

export function writeToken(deps: ExecutorDeps, origin: string, token: string | null): void {
    let file: { registries?: Record<string, string>; tokens?: Record<string, string> } = {};
    try {
        file = JSON.parse(readFileSync(configPath(deps), "utf8")) as typeof file;
    } catch {
        /* new config */
    }
    file.tokens ??= {};
    const key = origin.replace(/\/+$/, "");
    if (token) file.tokens[key] = token;
    else delete file.tokens[key];
    mkdirSync(deps.home, { recursive: true });
    writeFileSync(configPath(deps), JSON.stringify(file, null, 2));
    chmodSync(configPath(deps), 0o600);
}

export function tokenFor(deps: ExecutorDeps, origin: string): string | undefined {
    return readTokens(deps)[origin.replace(/\/+$/, "")];
}

export function authHeaders(deps: ExecutorDeps, origin: string): Record<string, string> {
    const token = tokenFor(deps, origin);
    return token ? { authorization: `Bearer ${token}` } : {};
}

export interface ExecutorDeps {
    config: CliConfig;
    fetch: typeof fetch;
    /** Directory holding credentials, package cache, and the audit buffer. Default: ~/.doax */
    home: string;
    /** Collects a secret or confirmation from the user; absent in non-interactive runs. */
    prompt?: (question: string) => Promise<string>;
    /** Opens a URL in the caller's browser (for an Authenticator's browser-login); absent leaves the printed URL. */
    openUrl?: (url: string) => void | Promise<void>;
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
    const res = await deps.fetch(`${origin}/${canonical}`, { headers: authHeaders(deps, origin) });
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
        audit(deps, [baseEvent(deps, "fetch", resolved.identity, { tier: 4, strengthenedBy: [] }, { status: "success", reasonCode: "ok" })]);
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
    // `caller` lets the Resource record which device it answered (spec §8.2a).
    return await (fn as (i: unknown, c: unknown) => Promise<unknown>)(input, { ...context, caller: { deviceId: hostname() } });
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

/* ---------- per-invocation confirmation (spec §4.7 `confirm`, §7.3, §7.8) ----------
   The Executor is not trusted (§7.3): it never authorizes anything itself. At Tier 1 and 2 it relays the
   Authenticator's `confirm` — the Authenticator service signs the person in when needed and takes their
   decision on this one invocation — and hands the confirmation to the operation for its verifier to check. */

/** Canonical JSON: keys sorted recursively, no whitespace, absent values dropped (spec §6.4). */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

/** The request hash a confirmation is bound to (spec §6.4): sha256 of the canonical `{resource, operation, input}`. */
export function requestHash(resource: string, operation: string, input: Record<string, unknown>): string {
    return createHash("sha256").update(canonicalJson({ resource, operation, input })).digest("hex");
}

/** A Tier 2 authorization token the Authenticator service granted (§7.4a). Held only; the service verifies it. */
interface HeldAuthorization {
    resource: string;
    token: unknown;
    exp: string;
}

const authorizationsPath = (deps: ExecutorDeps) => join(deps.home, "authorizations.json");

function readAuthorizations(deps: ExecutorDeps): Record<string, HeldAuthorization> {
    try {
        return JSON.parse(readFileSync(authorizationsPath(deps), "utf8")) as Record<string, HeldAuthorization>;
    } catch {
        return {};
    }
}

function holdAuthorization(deps: ExecutorDeps, resourceKey: string, held: HeldAuthorization): void {
    const all = readAuthorizations(deps);
    all[resourceKey] = held;
    mkdirSync(deps.home, { recursive: true });
    writeFileSync(authorizationsPath(deps), JSON.stringify(all, null, 2));
    chmodSync(authorizationsPath(deps), 0o600);
}

/** The pending exchange a caller carries back to complete a confirmation asynchronously (§7.8). */
export interface PendingExchange {
    handle: string;
    verifier: string;
}

interface ConfirmOutcome {
    pending?: boolean;
    entryPoint?: string;
    handle?: string;
    interval?: number;
    expiresIn?: number;
    confirmation?: unknown;
    id?: string;
    credential?: Record<string, unknown>;
    principal?: Record<string, unknown>;
    authorization?: { token: unknown; exp: string };
}

export interface Confirmed {
    confirmation?: unknown;
    credential?: Record<string, unknown>;
    authorization?: unknown;
}

/**
  * Obtain this invocation's confirmation from the Authenticator (§9.1 step 4). Tier 3/4 need none; Tier 2 presents
  * an authorization token still within its lifetime. Otherwise `confirm` runs: a terminal waits on the entry point;
  * a non-interactive caller gets the pending exchange back and completes it later with `resume`.
  */
export async function confirmInvocation(
    deps: ExecutorDeps,
    resolved: ResolvedResource,
    effective: EffectiveTier,
    authResolved: ResolvedResource | null,
    operation: string,
    input: Record<string, unknown>,
    resume?: PendingExchange,
): Promise<Confirmed> {
    if (effective.tier > 2) return {};
    const resourceKey = credentialKey(resolved.identity);
    if (effective.tier === 2 && !resume) {
        const held = readAuthorizations(deps)[resourceKey];
        if (held && Date.parse(held.exp) > Date.now()) return { authorization: held.token };
    }
    if (!authResolved?.manifest.interfaceMapping?.confirm) {
        throw new ExecutorError(
            `tier ${effective.tier} needs a confirmation, but ${authResolved?.identity ?? "no authenticator"} does not implement confirm (spec §4.7)`,
            "confirm-unsupported",
        );
    }
    const auth = authResolved;
    const module = await loadPackage(deps, auth);
    const descriptor = { resource: resourceKey, operation, requestHash: requestHash(resourceKey, operation, input) };
    const verifier = resume?.verifier ?? randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const call = (handle?: string) =>
        invokeOperation(module, auth, "confirm", handle ? { descriptor, tier: effective.tier, handle, verifier } : { descriptor, tier: effective.tier, challenge }, {}) as Promise<ConfirmOutcome>;

    const decided = (outcome: ConfirmOutcome, reasonCode: string) =>
        audit(deps, [
            baseEvent(deps, outcome.confirmation ? "approve" : "reject", resolved.identity, effective, { status: outcome.confirmation ? "success" : "failure", reasonCode }, {
                authenticator: auth.identity,
                approval: outcome.id,
            }),
        ]);

    let outcome = await call(resume?.handle);
    if (outcome.pending) {
        if (!deps.prompt) {
            throw new ExecutorError(`${operation} ${resolved.identity} awaits confirmation at ${outcome.entryPoint}`, "confirmation-pending", {
                willRequireInteraction: true,
                entryPoint: outcome.entryPoint ?? null,
                handle: outcome.handle,
                verifier,
                interval: outcome.interval ?? null,
                expiresIn: outcome.expiresIn ?? null,
                fix: `open the entry point, then re-run the same command with --handle ${outcome.handle} --verifier ${verifier}`,
            });
        }
        process.stderr.write(`confirm to continue: ${outcome.entryPoint}\n`);
        if (deps.openUrl && outcome.entryPoint) {
            try {
                await deps.openUrl(outcome.entryPoint);
            } catch {
                /* no opener — the printed URL is the fallback */
            }
        }
        const deadline = Date.now() + (outcome.expiresIn ? outcome.expiresIn * 1000 : 300_000);
        while (outcome.pending) {
            if (Date.now() > deadline) {
                decided({}, "timeout");
                throw new ExecutorError(`${operation} ${resolved.identity}: confirmation not completed in time`, "timeout");
            }
            await new Promise((r) => setTimeout(r, Math.max(1000, (outcome.interval ?? 2) * 1000)));
            outcome = await call(outcome.handle);
        }
    }
    if (!outcome.confirmation) {
        decided(outcome, "declined");
        throw new ExecutorError(`${operation} ${resolved.identity} was not confirmed`, "authorization-declined");
    }
    decided(outcome, "ok");
    if (effective.tier === 2) {
        if (outcome.authorization) holdAuthorization(deps, resourceKey, { resource: resourceKey, ...outcome.authorization });
        if (outcome.credential) {
            writeCredential(deps, credentialKey(auth.identity), {
                authenticator: auth.identity,
                credential: outcome.credential,
                principal: outcome.principal,
                storedAt: new Date().toISOString(),
            });
        }
    }
    return { confirmation: outcome.confirmation, credential: outcome.credential, authorization: outcome.authorization?.token };
}

/*
 * ---------- audit (spec §8.3): local-only ----------
 * What runs on the caller's device is recorded on the device, append-only, and never sent:
 * the registry's own audit covers only what the registry itself sees (sign-in, resolve, publish).
 */

const logPath = (deps: ExecutorDeps) => join(deps.home, "audit.jsonl");
/** Undelivered events from when the CLI posted audit to the registry; folded into the local log. */
const legacyBufferPath = (deps: ExecutorDeps) => join(deps.home, "audit-buffer.jsonl");

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

export function audit(deps: ExecutorDeps, events: AuditEvent[]): void {
    mkdirSync(deps.home, { recursive: true });
    if (existsSync(legacyBufferPath(deps))) {
        appendFileSync(logPath(deps), readFileSync(legacyBufferPath(deps), "utf8"));
        rmSync(legacyBufferPath(deps), { force: true });
    }
    for (const event of events) appendFileSync(logPath(deps), `${JSON.stringify(event)}\n`);
}

export { fault };

import type { Tier, TierRequirement } from "./tier.ts";

/** Mandatory audit event classes (spec §8.3). */
export const AUDIT_EVENT_CLASSES = [
    "resolve",
    "fetch",
    "metadata-read",
    "data-read",
    "dry-run",
    "execute",
    "dispatch",
    "recover",
    "approve",
    "reject",
    "step-up",
    "auth",
    "publish",
    "deprecate",
    "yank",
    "visibility-change",
    "verification-change",
] as const;
export type AuditEventClass = (typeof AUDIT_EVENT_CLASSES)[number];

export const ANONYMOUS_ACTOR = "anonymous";

/**
  * Where an event was observed. The CLI writes `caller-device` events to its own LOCAL log
  * only (spec §8.3). The central audit log the Registry keeps is written by whatever ran the
  * work server-side — an `executor` host (dispatched §6A work) or a `server` Resource (a
  * self-hosted service, §6.5) — each under its own resource token, plus the `registry` itself
  * for its own surface (spec §8.2).
  */
export type AuditExecutionLocation =
    | { kind: "caller-device"; deviceId: string }
    | { kind: "executor"; executor: string }
    | { kind: "server"; server: string }
    | { kind: "registry"; registry: string };

/** Mandatory event fields (spec §8.4). Events are append-only once written (spec §8.1). */
export interface AuditEvent {
    eventId: string;
    timestamp: string;
    class: AuditEventClass;
    actor: string;
    executionLocation: AuditExecutionLocation;
    executorCpuTimeMs?: number;
    resource: string;
    authenticator?: string | "none";
    target?: string;
    effectiveTier: { tier: Tier; strengthenedBy: TierRequirement[] };
    outcome: { status: "success" | "failure" | "partial"; reasonCode: string };
    idempotencyKey?: string;
    dryRun?: { mode: "predictive" | "native"; estimated: boolean };
    sourceFreshness?: string;
    linkedEvent?: string;
    upstreamOrigin?: string;
}

/** Reason code for a fault not in the Resource's declared list (spec §13.2). */
export const UNDECLARED_FAULT = "undeclared";

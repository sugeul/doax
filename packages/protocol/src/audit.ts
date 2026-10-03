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

export type AuditExecutionLocation =
    | { kind: "caller-device"; deviceId: string }
    | { kind: "executor"; executor: string };

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

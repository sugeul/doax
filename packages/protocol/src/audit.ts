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
    /**
      * Resource records (spec §8.2a): the caller the Resource answered — a device, an Executor
      * Resource, or an Application (a portal, a hosted app) — or "unknown".
      */
    caller?: { deviceId: string } | { executor: string } | { app: string } | "unknown";
    /** Set by the Registry: which credential delivered the event (spec §8.4), e.g. `@ns/name#<token id>` or a Provider identity. */
    reporter?: string;
    /** For records a Provider writes: the audience, channel and method of the token it accepted (spec §7.2, §8.4). */
    token?: { aud?: string; chn?: "executor" | "web"; ath?: string };
    /** For a confirmed invocation, including a gated Action: the confirmation id requested or consumed (spec §4.7, §6.4). */
    approval?: string;
    /** For `execute` with an out-of-band payload: its size and digest as observed (spec §6.6). */
    payload?: { size: number; digest: string };
}

/** Reason code for a fault not in the Resource's declared list (spec §13.2). */
export const UNDECLARED_FAULT = "undeclared";

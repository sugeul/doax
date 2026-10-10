#!/usr/bin/env node
/**
  * Seeds the Slack resources into a doax registry. Usage:
  *   DOAX_ADMIN_TOKEN=... node infra/seed/publish.mjs [registry-origin]
  * Publish is immutable (§4.4): re-running against existing versions reports 409 and moves on.
  */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const registry = (process.argv[2] ?? "https://registry.doax.io").replace(/\/+$/, "");
const token = process.env.DOAX_ADMIN_TOKEN;
if (!token) {
    console.error("DOAX_ADMIN_TOKEN is required");
    process.exit(2);
}

const OWNER = "doax.io operators <registry@doax.io>";
const AUTHENTICATOR = "@doax/slack-login@1.0.0";

const slackFaults = (extra = []) => [
    {
        faultClass: "invalid-auth",
        trigger: "token expired, revoked, or wrong",
        callerVisibleEffect: "operation fails, no side effect",
        expectedFrequency: "unknown",
        recommendedCallerAction: "re-authenticate (doax auth set @doax/slack-login)",
    },
    {
        faultClass: "slack-unavailable",
        trigger: "Slack API outage or network failure",
        callerVisibleEffect: "operation fails, no side effect",
        expectedFrequency: "rare",
        recommendedCallerAction: "retry after a delay",
    },
    {
        faultClass: "rate-limited",
        trigger: "Slack Web API rate limit",
        callerVisibleEffect: "operation fails, no side effect",
        expectedFrequency: "under bursts",
        recommendedCallerAction: "retry after the advertised delay",
    },
    ...extra,
];

const channelFault = {
    faultClass: "channel-not-found",
    trigger: "channel id wrong, or the principal is not a member",
    callerVisibleEffect: "operation fails, no side effect",
    expectedFrequency: "caller error",
    recommendedCallerAction: "check the channel id and membership",
};

const RESOURCES = [
    {
        identity: AUTHENTICATOR,
        file: "slack-login.mjs",
        manifest: {
            kind: "authenticator",
            summary: "Log in to the Slack Web API with a personal user or bot token",
            description:
                "Secret-entry authenticator for Slack. The Executor CLI prompts for a Slack token (xoxp-/xoxb-), verifies it with auth.test, and caches it per caller (§7.6). Every Slack resource references this authenticator, so one entry serves them all.",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            subject: "personal",
            auditScope: ["auth"],
            dependencies: [],
            interfaceMapping: { describe: { kind: "native" }, authenticate: { kind: "native" } },
            authentication: {
                targetSystem: "Slack Web API (https://slack.com/api)",
                subject: "personal",
                interactionKinds: ["secret-entry"],
                interactionDetails: {
                    "secret-entry": {
                        instruction: "paste a Slack user (xoxp-) or bot (xoxb-) token; verified via auth.test",
                        entryPoint: "https://api.slack.com/apps — open your app → OAuth & Permissions → Bot/User OAuth Token",
                        docs: "https://api.slack.com/authentication/token-types",
                    },
                },
                credentialMaterial: "bearer token",
                lifetime: { period: "unknown", refreshable: false },
                verificationMethod: "auth.test (no side effects)",
                stepUpBehavior: "same as initial",
                requiredInputs: ["secret"],
                scopeRequested: "whatever the pasted token already carries; this flow requests no new scopes",
                revocation: "revoke the token in Slack: workspace admin > installed apps, or https://api.slack.com/apps",
            },
            serviceLevel: {
                expectedFaults: slackFaults(),
                degradationBehavior: "fail fast; the caller is told which fault class occurred",
                dependencyLevels: {},
                measurement: "not measured",
                supportCommitment: "none",
                perAttemptFailureProbability: "unknown; declared assumption ~1%",
            },
        },
    },
    {
        identity: "@doax/slack-channel-history@1.0.0",
        file: "slack-channel-history.mjs",
        manifest: {
            kind: "data-source",
            summary: "Read the message history of a Slack channel the caller can see",
            description:
                "One collection: Slack messages visible to the caller's token, retrieved per channel via conversations.history. Read params: channel (required), limit (default 20), oldest, cursor (continuation). The source is caller-relative (§5.3): you read exactly what your token may read.",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            authenticator: AUTHENTICATOR,
            auditScope: ["metadata-read", "data-read"],
            dependencies: [AUTHENTICATOR],
            interfaceMapping: { describe: { kind: "native" }, metadata: { kind: "native" }, read: { kind: "native" } },
            serviceLevel: {
                expectedFaults: slackFaults([channelFault]),
                degradationBehavior: "fail fast; no partial pages are fabricated",
                dependencyLevels: { [AUTHENTICATOR]: "per-attempt failure ~1%" },
                measurement: "not measured",
                supportCommitment: "none",
                refreshCadence: "realtime",
                tolerance: "none declared",
                annualLatenessBudget: "best-effort (realtime source; lateness is Slack availability)",
                latencyTarget: "read completes in < 3s p95 under normal Slack latency",
            },
        },
    },
    {
        identity: "@doax/slack-list-channel@1.0.0",
        file: "slack-list-channel.mjs",
        manifest: {
            kind: "data-source",
            summary: "List the Slack channels the caller can see",
            description:
                "One collection: Slack channels visible to the caller's token, via conversations.list. Read params: types (public_channel, private_channel; default public), limit (default 100), cursor (continuation). The natural first read — its `id` field is the `channel` parameter of slack-channel-history and slack-post.",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            authenticator: AUTHENTICATOR,
            auditScope: ["metadata-read", "data-read"],
            dependencies: [AUTHENTICATOR],
            interfaceMapping: { describe: { kind: "native" }, metadata: { kind: "native" }, read: { kind: "native" } },
            serviceLevel: {
                expectedFaults: slackFaults(),
                degradationBehavior: "fail fast; no partial pages are fabricated",
                dependencyLevels: { [AUTHENTICATOR]: "per-attempt failure ~1%" },
                measurement: "not measured",
                supportCommitment: "none",
                refreshCadence: "realtime",
                tolerance: "none declared",
                annualLatenessBudget: "best-effort (realtime source; lateness is Slack availability)",
                latencyTarget: "read completes in < 3s p95 under normal Slack latency",
            },
        },
    },
    {
        identity: "@doax/slack-post@1.0.0",
        file: "slack-post.mjs",
        manifest: {
            kind: "action",
            summary: "Post a message to a Slack channel as the authenticated principal",
            description:
                "Posts one message via chat.postMessage. Params: channel (required), text (required), thread_ts (optional, reply in thread). Dry-run is predictive: it validates the token and echoes what would be sent without sending (§6.1).",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            authenticator: AUTHENTICATOR,
            auditScope: ["dry-run", "execute"],
            dependencies: [AUTHENTICATOR],
            interfaceMapping: { describe: { kind: "native" }, "dry-run": { kind: "native" }, execute: { kind: "native" } },
            dryRunMode: "predictive",
            idempotency: "non-idempotent",
            recoveryAction: "none",
            serviceLevel: {
                expectedFaults: slackFaults([channelFault]),
                degradationBehavior: "fail fast; a failed attempt posts nothing",
                dependencyLevels: { [AUTHENTICATOR]: "per-attempt failure ~1%" },
                measurement: "not measured",
                supportCommitment: "none",
                perAttemptFailureProbability: "unknown; declared assumption ~2% (rate limits, membership errors)",
                sideEffectOnFailure: "none for all declared fault classes: Slack either posts or errors",
                annualTarget: "best-effort",
                latencyTarget: "execute completes in < 3s p95",
            },
        },
    },
];

for (const resource of RESOURCES) {
    const pkg = await readFile(join(here, "packages", resource.file));
    const headers = { "content-type": "application/json", "x-doax-admin-token": token };
    if (process.env.DOAX_FORCE === "1") headers["x-doax-admin-force"] = "true"; // pre-public re-seed only
    const res = await fetch(`${registry}/${resource.identity}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ manifest: resource.manifest, package: pkg.toString("base64") }),
    });
    const body = await res.json().catch(() => ({}));
    console.log(`${res.status} ${resource.identity}`, res.status === 201 ? body.digest : (body.error ?? ""));
}

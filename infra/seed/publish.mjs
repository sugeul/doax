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
const bearer = process.env.DOAX_TOKEN; // a principal's PAT (owner/publisher of the namespace)
const admin = process.env.DOAX_ADMIN_TOKEN; // or the operator token
if (!bearer && !admin) {
    console.error("set DOAX_TOKEN (publisher PAT) or DOAX_ADMIN_TOKEN (operator)");
    process.exit(2);
}

const OWNER = "doax.io operators <registry@doax.io>";
const AUTHENTICATOR = "@doax/slack-login@1.0.0";
const TEAMS_AUTHENTICATOR = "@doax/teams-login@1.0.0";
const DRIVE_AUTHENTICATOR = "@doax/google-drive-login@1.0.0";

const slackFaults = (extra = []) => [
    {
        faultClass: "missing-scope",
        trigger: "the Slack app's token lacks an OAuth scope the operation needs; Slack reports which",
        callerVisibleEffect: "operation fails, no side effect; the error names the needed scope",
        expectedFrequency: "setup-time; once scopes are granted it stops",
        recommendedCallerAction:
            "add the named scope at https://api.slack.com/apps (OAuth & Permissions), reinstall the app, re-authenticate if the token rotated",
    },
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

const graphFaults = (extra = []) => [
    {
        faultClass: "missing-scope",
        trigger: "the signed-in app lacks a delegated Microsoft Graph permission the operation needs",
        callerVisibleEffect: "operation fails, no side effect; the error points to the app's API permissions",
        expectedFrequency: "setup-time; once permissions are consented it stops",
        recommendedCallerAction:
            "grant the delegated permission in Entra ID (App registrations > API permissions), admin-consent if required, then re-authenticate (doax auth set @doax/teams-login)",
    },
    {
        faultClass: "invalid-auth",
        trigger: "access token expired or revoked and the refresh token no longer works",
        callerVisibleEffect: "operation fails, no side effect",
        expectedFrequency: "access tokens expire ~hourly; normally refreshed silently",
        recommendedCallerAction: "re-authenticate (doax auth set @doax/teams-login)",
    },
    {
        faultClass: "graph-unavailable",
        trigger: "Microsoft Graph outage or network failure",
        callerVisibleEffect: "operation fails, no side effect",
        expectedFrequency: "rare",
        recommendedCallerAction: "retry after a delay",
    },
    {
        faultClass: "rate-limited",
        trigger: "Microsoft Graph throttling (HTTP 429)",
        callerVisibleEffect: "operation fails, no side effect",
        expectedFrequency: "under bursts",
        recommendedCallerAction: "retry after the Retry-After delay",
    },
    ...extra,
];

const teamsNotFound = {
    faultClass: "not-found",
    trigger: "team or channel id wrong, or the signed-in user is not a member",
    callerVisibleEffect: "operation fails, no side effect",
    expectedFrequency: "caller error",
    recommendedCallerAction: "check the ids via @doax/teams-list-team and @doax/teams-list-channel",
};

const teamsAccessDenied = {
    faultClass: "access-denied",
    trigger: "the signed-in user is not a member of the target team/channel (e.g. a private channel)",
    callerVisibleEffect: "operation fails, no side effect",
    expectedFrequency: "setup-time",
    recommendedCallerAction: "join the team/channel or ask an owner to add the user",
};

const driveFaults = (extra = []) => [
    {
        faultClass: "missing-scope",
        trigger: "the refresh token lacks the Drive OAuth scope the operation needs (drive.readonly)",
        callerVisibleEffect: "operation fails, no side effect; the error names the needed scope",
        expectedFrequency: "setup-time; once the token carries drive.readonly it stops",
        recommendedCallerAction: "re-consent at https://auth.doax.io so the token carries drive.readonly, then re-authenticate (doax auth set @doax/google-drive-login --secret <refresh-token>)",
    },
    {
        faultClass: "invalid-auth",
        trigger: "the access token expired, or the refresh token was revoked/expired and cannot be refreshed",
        callerVisibleEffect: "operation fails, no side effect",
        expectedFrequency: "access tokens expire ~hourly; normally refreshed silently from the stored refresh token",
        recommendedCallerAction: "re-mint a refresh token at https://auth.doax.io and re-authenticate (doax auth set @doax/google-drive-login)",
    },
    {
        faultClass: "access-denied",
        trigger: "the caller's token may not read the target file or shared drive",
        callerVisibleEffect: "operation fails, no side effect",
        expectedFrequency: "caller error / sharing change",
        recommendedCallerAction: "confirm the file is shared with the consenting account, or belongs to a shared drive it can access",
    },
    {
        faultClass: "drive-unavailable",
        trigger: "Google Drive outage or network failure",
        callerVisibleEffect: "operation fails, no side effect",
        expectedFrequency: "rare",
        recommendedCallerAction: "retry after a delay",
    },
    {
        faultClass: "rate-limited",
        trigger: "Google Drive API rate limit (HTTP 403 rateLimitExceeded or 429)",
        callerVisibleEffect: "operation fails, no side effect",
        expectedFrequency: "under bursts",
        recommendedCallerAction: "retry after the advertised delay with exponential backoff",
    },
    ...extra,
];

const driveNotFound = {
    faultClass: "not-found",
    trigger: "the file id or page token is wrong, or the token cannot see the resource",
    callerVisibleEffect: "operation fails, no side effect",
    expectedFrequency: "caller error",
    recommendedCallerAction: "check the id via @doax/google-drive-list; for changes, read with no cursor to get a fresh baseline token",
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
            requiredScopes: ["channels:history", "groups:history (private channels)"],
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
            requiredScopes: ["channels:read", "groups:read (private channels)"],
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
            requiredScopes: ["chat:write", "chat:write.public (public channels the app is not in)"],
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
                expectedFaults: slackFaults([
                    channelFault,
                    {
                        faultClass: "not-in-channel",
                        trigger: "the app is not a member of the target public channel and lacks chat:write.public",
                        callerVisibleEffect: "operation fails, no side effect",
                        expectedFrequency: "setup-time",
                        recommendedCallerAction: "invite the app to the channel (/invite @yourapp) or grant chat:write.public",
                    },
                ]),
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
    {
        identity: "@doax/slack-search@1.0.0",
        file: "slack-search.mjs",
        manifest: {
            kind: "data-source",
            summary: "Full-text search of Slack messages the caller can see",
            requiredScopes: ["search:read (user token only; bot tokens are rejected)"],
            description:
                "One collection: Slack messages matching a query, via search.messages. Read params: query (required), count (default 20), page (default 1; continuation is the next page number). Requires a Slack user token (xoxp-) — search.messages rejects bot tokens. The query interface the Registry leaves out (§5.4) is supplied by Slack's own search.",
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
        identity: TEAMS_AUTHENTICATOR,
        file: "teams-login.mjs",
        manifest: {
            kind: "authenticator",
            summary: "Log in to Microsoft Graph with the device-code OAuth flow",
            description:
                "Device-code authenticator for Microsoft Graph. The Executor CLI shows a user code and verification URL, the user signs in elsewhere, and the CLI polls until a delegated token is issued; refresh mode renews it silently (§7.6). Every Teams resource references this authenticator, so one login serves them all.",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            subject: "personal",
            auditScope: ["auth"],
            dependencies: [],
            interfaceMapping: { describe: { kind: "native" }, authenticate: { kind: "native" } },
            authentication: {
                targetSystem: "Microsoft Graph (https://graph.microsoft.com) via the Microsoft identity platform (https://login.microsoftonline.com)",
                subject: "personal",
                interactionKinds: ["device-code"],
                interactionDetails: {
                    "device-code": {
                        instruction: "the CLI displays a short user code and a verification URL; sign in at the URL and enter the code",
                        entryPoint: "https://microsoft.com/devicelogin (the exact verification_uri is returned at runtime)",
                        completionSignal: "the token endpoint stops returning authorization_pending and yields an access_token",
                        maxWait: "the device code's expires_in (~15 minutes)",
                        docs: "https://learn.microsoft.com/entra/identity-platform/v2-oauth2-device-code",
                    },
                },
                credentialMaterial: "OAuth 2.0 delegated bearer access token plus a refresh token",
                lifetime: {
                    period: "access token ~60-90 min",
                    refreshable: true,
                    refreshBehavior:
                        "refresh mode exchanges the cached refresh token for a new access token with no user interaction; if it is expired or revoked, refresh fails and mode initial is required",
                },
                verificationMethod: "GET /me (no side effects)",
                stepUpBehavior: "same as initial (repeat the device-code login)",
                requiredInputs: [],
                scopeRequested: "offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send",
                revocation:
                    "revoke the app's access at https://myaccount.microsoft.com (Privacy > Apps & services), or a tenant admin revokes it in Entra ID > Enterprise applications",
            },
            serviceLevel: {
                expectedFaults: graphFaults(),
                degradationBehavior: "fail fast; the caller is told which fault class occurred",
                dependencyLevels: {},
                measurement: "not measured",
                supportCommitment: "none",
                perAttemptFailureProbability: "unknown; declared assumption ~1%",
            },
        },
    },
    {
        identity: "@doax/teams-list-team@1.0.0",
        file: "teams-list-team.mjs",
        manifest: {
            kind: "data-source",
            summary: "List the Microsoft Teams the caller has joined",
            requiredScopes: ["Team.ReadBasic.All"],
            description:
                "One collection: the Teams the caller has joined, via GET /me/joinedTeams. The natural first read — its `id` field is the `team` parameter of the other Teams resources. Read params: cursor (an @odata.nextLink continuation).",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            authenticator: TEAMS_AUTHENTICATOR,
            auditScope: ["metadata-read", "data-read"],
            dependencies: [TEAMS_AUTHENTICATOR],
            interfaceMapping: { describe: { kind: "native" }, metadata: { kind: "native" }, read: { kind: "native" } },
            serviceLevel: {
                expectedFaults: graphFaults(),
                degradationBehavior: "fail fast; no partial pages are fabricated",
                dependencyLevels: { [TEAMS_AUTHENTICATOR]: "per-attempt failure ~1%" },
                measurement: "not measured",
                supportCommitment: "none",
                refreshCadence: "realtime",
                tolerance: "none declared",
                annualLatenessBudget: "best-effort (realtime source; lateness is Graph availability)",
                latencyTarget: "read completes in < 3s p95 under normal Graph latency",
            },
        },
    },
    {
        identity: "@doax/teams-list-channel@1.0.0",
        file: "teams-list-channel.mjs",
        manifest: {
            kind: "data-source",
            summary: "List the channels of a Microsoft Team the caller can see",
            requiredScopes: ["Channel.ReadBasic.All"],
            description:
                "One collection: the channels of one Team, via GET /teams/{team}/channels. Read params: team (required), membershipType (standard|private|shared, optional), cursor. Its `id` field is the `channel` parameter of teams-channel-messages and teams-post.",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            authenticator: TEAMS_AUTHENTICATOR,
            auditScope: ["metadata-read", "data-read"],
            dependencies: [TEAMS_AUTHENTICATOR],
            interfaceMapping: { describe: { kind: "native" }, metadata: { kind: "native" }, read: { kind: "native" } },
            serviceLevel: {
                expectedFaults: graphFaults([teamsNotFound, teamsAccessDenied]),
                degradationBehavior: "fail fast; no partial pages are fabricated",
                dependencyLevels: { [TEAMS_AUTHENTICATOR]: "per-attempt failure ~1%" },
                measurement: "not measured",
                supportCommitment: "none",
                refreshCadence: "realtime",
                tolerance: "none declared",
                annualLatenessBudget: "best-effort (realtime source; lateness is Graph availability)",
                latencyTarget: "read completes in < 3s p95 under normal Graph latency",
            },
        },
    },
    {
        identity: "@doax/teams-channel-messages@1.0.0",
        file: "teams-channel-messages.mjs",
        manifest: {
            kind: "data-source",
            summary: "Read the messages of a Teams channel the caller can see",
            requiredScopes: ["ChannelMessage.Read.All"],
            description:
                "One collection: top-level messages of one channel, via GET /teams/{team}/channels/{channel}/messages. Read params: team (required), channel (required), limit (default 20), cursor. Caller-relative (§5.3): you read exactly what your token and membership allow.",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            authenticator: TEAMS_AUTHENTICATOR,
            auditScope: ["metadata-read", "data-read"],
            dependencies: [TEAMS_AUTHENTICATOR],
            interfaceMapping: { describe: { kind: "native" }, metadata: { kind: "native" }, read: { kind: "native" } },
            serviceLevel: {
                expectedFaults: graphFaults([teamsNotFound, teamsAccessDenied]),
                degradationBehavior: "fail fast; no partial pages are fabricated",
                dependencyLevels: { [TEAMS_AUTHENTICATOR]: "per-attempt failure ~1%" },
                measurement: "not measured",
                supportCommitment: "none",
                refreshCadence: "realtime",
                tolerance: "none declared",
                annualLatenessBudget: "best-effort (realtime source; lateness is Graph availability)",
                latencyTarget: "read completes in < 3s p95 under normal Graph latency",
            },
        },
    },
    {
        identity: "@doax/teams-post@1.0.0",
        file: "teams-post.mjs",
        manifest: {
            kind: "action",
            summary: "Post a message to a Teams channel as the signed-in user",
            requiredScopes: ["ChannelMessage.Send"],
            description:
                "Posts one message via POST /teams/{team}/channels/{channel}/messages (or /messages/{id}/replies when replyToId is given). Params: team (required), channel (required), text (required), contentType (text|html, optional), replyToId (optional). Dry-run is predictive: it validates the token and echoes what would be sent without sending (§6.1).",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            authenticator: TEAMS_AUTHENTICATOR,
            auditScope: ["dry-run", "execute"],
            dependencies: [TEAMS_AUTHENTICATOR],
            interfaceMapping: { describe: { kind: "native" }, "dry-run": { kind: "native" }, execute: { kind: "native" } },
            dryRunMode: "predictive",
            idempotency: "non-idempotent",
            recoveryAction: "none",
            serviceLevel: {
                expectedFaults: graphFaults([teamsNotFound, teamsAccessDenied]),
                degradationBehavior: "fail fast; a failed attempt posts nothing",
                dependencyLevels: { [TEAMS_AUTHENTICATOR]: "per-attempt failure ~1%" },
                measurement: "not measured",
                supportCommitment: "none",
                perAttemptFailureProbability: "unknown; declared assumption ~2% (rate limits, membership errors)",
                sideEffectOnFailure: "none for all declared fault classes: Graph either posts or errors",
                annualTarget: "best-effort",
                latencyTarget: "execute completes in < 3s p95",
            },
        },
    },
    {
        identity: "@doax/teams-search@1.0.0",
        file: "teams-search.mjs",
        manifest: {
            kind: "data-source",
            summary: "Full-text search of Teams channel messages the caller can see",
            requiredScopes: ["ChannelMessage.Read.All"],
            description:
                "One collection: Teams channel messages matching a query, via POST /search/query (entityTypes chatMessage). Read params: query (required), limit (default 20), from (offset; continuation is the next offset). Caller-relative (§5.3): results are limited to what the signed-in user can access. The query interface the Registry leaves out (§5.4) is supplied by Microsoft Search.",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            authenticator: TEAMS_AUTHENTICATOR,
            auditScope: ["metadata-read", "data-read"],
            dependencies: [TEAMS_AUTHENTICATOR],
            interfaceMapping: { describe: { kind: "native" }, metadata: { kind: "native" }, read: { kind: "native" } },
            serviceLevel: {
                expectedFaults: graphFaults(),
                degradationBehavior: "fail fast; no partial pages are fabricated",
                dependencyLevels: { [TEAMS_AUTHENTICATOR]: "per-attempt failure ~1%" },
                measurement: "not measured",
                supportCommitment: "none",
                refreshCadence: "realtime",
                tolerance: "none declared",
                annualLatenessBudget: "best-effort (realtime source; lateness is Graph availability)",
                latencyTarget: "read completes in < 3s p95 under normal Graph latency",
            },
        },
    },
    {
        identity: DRIVE_AUTHENTICATOR,
        file: "google-drive-login.mjs",
        manifest: {
            kind: "authenticator",
            summary: "Log in to Google Drive with an OAuth refresh token",
            description:
                "Secret-entry authenticator for Google Drive. The caller mints a refresh token once at https://auth.doax.io (the consent-redirect mirror) and pastes it here; this module exchanges it for a short-lived access token using the OAuth client it reads from AWS Secrets Manager via the local aws-cli. refresh mode re-mints the access token silently (§7.6). Every @doax/google-drive-* resource references this authenticator, so one login serves them all.",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            subject: "personal",
            auditScope: ["auth"],
            dependencies: [],
            interfaceMapping: { describe: { kind: "native" }, authenticate: { kind: "native" } },
            authentication: {
                targetSystem: "Google Drive API (https://www.googleapis.com/drive/v3) via Google OAuth 2.0 (https://oauth2.googleapis.com/token)",
                subject: "personal",
                interactionKinds: ["secret-entry"],
                interactionDetails: {
                    "secret-entry": {
                        instruction: "paste the Google OAuth refresh token minted at https://auth.doax.io?appid=@doax/google-drive-login; it is exchanged for an access token and verified via drive/v3/about",
                        entryPoint: "https://auth.doax.io?appid=@doax/google-drive-login — authorize the Drive app, then copy the refresh token shown",
                        docs: "https://developers.google.com/identity/protocols/oauth2/web-server#offline",
                    },
                },
                credentialMaterial: "OAuth 2.0 access token minted from the pasted refresh token",
                lifetime: {
                    period: "access token ~60 min",
                    refreshable: true,
                    refreshBehavior: "refresh mode re-exchanges the cached refresh token for a new access token with no user interaction; if it is revoked or expired, refresh fails and a new refresh token must be minted at https://auth.doax.io",
                },
                verificationMethod: "GET drive/v3/about?fields=user (no side effects)",
                stepUpBehavior: "same as initial (re-paste the refresh token)",
                requiredInputs: ["secret"],
                scopeRequested: "whatever the pasted refresh token already carries (expected: https://www.googleapis.com/auth/drive.readonly); this flow requests no new scopes",
                revocation: "revoke the app's access at https://myaccount.google.com/permissions",
            },
            serviceLevel: {
                expectedFaults: driveFaults(),
                degradationBehavior: "fail fast; the caller is told which fault class occurred",
                dependencyLevels: {},
                measurement: "not measured",
                supportCommitment: "none",
                perAttemptFailureProbability: "unknown; declared assumption ~1%",
            },
        },
    },
    {
        identity: "@doax/google-drive-list@1.0.0",
        file: "google-drive-list.mjs",
        manifest: {
            kind: "data-source",
            summary: "List the Google Drive files the caller can see",
            requiredScopes: ["https://www.googleapis.com/auth/drive.readonly"],
            description:
                "One collection: Drive files visible to the caller's token, via GET /drive/v3/files. Read params: q (Drive query), pageSize (default 100), orderBy, driveId, corpora, includeItemsFromAllDrives (default true), fields, cursor (a nextPageToken). The natural first read — its `id` field is the `fileId` parameter of @doax/google-drive-get.",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            authenticator: DRIVE_AUTHENTICATOR,
            auditScope: ["metadata-read", "data-read"],
            dependencies: [DRIVE_AUTHENTICATOR],
            interfaceMapping: { describe: { kind: "native" }, metadata: { kind: "native" }, read: { kind: "native" } },
            serviceLevel: {
                expectedFaults: driveFaults(),
                degradationBehavior: "fail fast; no partial pages are fabricated",
                dependencyLevels: { [DRIVE_AUTHENTICATOR]: "per-attempt failure ~1%" },
                measurement: "not measured",
                supportCommitment: "none",
                refreshCadence: "realtime",
                tolerance: "none declared",
                annualLatenessBudget: "best-effort (realtime source; lateness is Drive availability)",
                latencyTarget: "read completes in < 3s p95 under normal Drive latency",
            },
        },
    },
    {
        identity: "@doax/google-drive-changes@1.0.0",
        file: "google-drive-changes.mjs",
        manifest: {
            kind: "data-source",
            summary: "Read the change feed (delta) for the caller's Google Drive",
            requiredScopes: ["https://www.googleapis.com/auth/drive.readonly"],
            description:
                "One collection: the Drive change feed, via GET /drive/v3/changes. With no cursor, read() bootstraps a baseline token (GET /changes/startPageToken) and lists from it; thereafter the caller polls with the `nextDeltaToken` the read returns. Read params: cursor, driveId, includeRemoved (default true), includeItemsFromAllDrives (default true), pageSize (default 100), restrictToMyDrive. The read returns both `continuation` (more pages now) and `nextDeltaToken` (poll again later).",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            authenticator: DRIVE_AUTHENTICATOR,
            auditScope: ["metadata-read", "data-read"],
            dependencies: [DRIVE_AUTHENTICATOR],
            interfaceMapping: { describe: { kind: "native" }, metadata: { kind: "native" }, read: { kind: "native" } },
            serviceLevel: {
                expectedFaults: driveFaults([driveNotFound]),
                degradationBehavior: "fail fast; no partial pages are fabricated",
                dependencyLevels: { [DRIVE_AUTHENTICATOR]: "per-attempt failure ~1%" },
                measurement: "not measured",
                supportCommitment: "none",
                refreshCadence: "realtime",
                tolerance: "none declared",
                annualLatenessBudget: "best-effort (realtime source; lateness is Drive availability)",
                latencyTarget: "read completes in < 3s p95 under normal Drive latency",
            },
        },
    },
    {
        identity: "@doax/google-drive-get@1.0.0",
        file: "google-drive-get.mjs",
        manifest: {
            kind: "data-source",
            summary: "Read the metadata of a single Google Drive file",
            requiredScopes: ["https://www.googleapis.com/auth/drive.readonly"],
            description:
                "One collection of one record: the metadata of a single Drive file, via GET /drive/v3/files/{fileId}. Read params: fileId (required), fields (optional override). The fileId comes from @doax/google-drive-list (its `id`) or @doax/google-drive-changes (its `fileId`).",
            owner: OWNER,
            requiredTier: 3,
            executionLocation: "caller-device",
            authenticator: DRIVE_AUTHENTICATOR,
            auditScope: ["metadata-read", "data-read"],
            dependencies: [DRIVE_AUTHENTICATOR],
            interfaceMapping: { describe: { kind: "native" }, metadata: { kind: "native" }, read: { kind: "native" } },
            serviceLevel: {
                expectedFaults: driveFaults([driveNotFound]),
                degradationBehavior: "fail fast; a missing or invisible file is a not-found fault",
                dependencyLevels: { [DRIVE_AUTHENTICATOR]: "per-attempt failure ~1%" },
                measurement: "not measured",
                supportCommitment: "none",
                refreshCadence: "realtime",
                tolerance: "none declared",
                annualLatenessBudget: "best-effort (realtime source; lateness is Drive availability)",
                latencyTarget: "read completes in < 2s p95 under normal Drive latency",
            },
        },
    },
];

for (const resource of RESOURCES) {
    const pkg = await readFile(join(here, "packages", resource.file));
    const headers = { "content-type": "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    else headers["x-doax-admin-token"] = admin;
    if (process.env.DOAX_FORCE === "1") headers["x-doax-admin-force"] = "true"; // pre-public re-seed, operator only
    const res = await fetch(`${registry}/${resource.identity}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ manifest: resource.manifest, package: pkg.toString("base64") }),
    });
    const body = await res.json().catch(() => ({}));
    console.log(`${res.status} ${resource.identity}`, res.status === 201 ? body.digest : (body.error ?? ""));
}

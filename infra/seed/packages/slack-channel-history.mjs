/**
  * @doax/slack-channel-history — data-source (spec §5).
  * One collection: the Slack messages visible to the caller's token, retrieved per channel.
  * The source decides what the caller sees (§5.1): Slack returns only what the token may read.
  */

const API = "https://slack.com/api";

async function slack(method, token, params = {}) {
    const query = new URLSearchParams(params).toString();
    const res = await fetch(`${API}/${method}?${query}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw Object.assign(new Error(`slack-unavailable: HTTP ${res.status}`), { faultClass: "slack-unavailable" });
    const body = await res.json();
    if (!body.ok) {
        if (body.error === "missing_scope") {
            throw Object.assign(new Error(`missing-scope: the Slack token lacks a required permission (needed: ${body.needed ?? "?"})`), {
                faultClass: "missing-scope",
                detail: {
                    neededScope: body.needed ?? null,
                    providedScopes: body.provided ?? null,
                    fix: "add the scope at https://api.slack.com/apps → your app → OAuth & Permissions → Bot Token Scopes, reinstall the app, then retry (doax auth set @doax/slack-login --secret ... if the token rotated)",
                },
            });
        }
        const faultClass = body.error === "invalid_auth" || body.error === "token_revoked" ? "invalid-auth"
            : body.error === "ratelimited" ? "rate-limited"
            : body.error === "channel_not_found" || body.error === "not_in_channel" ? "channel-not-found" : "slack-error";
        throw Object.assign(new Error(`${faultClass}: ${body.error}`), { faultClass, slackError: body.error });
    }
    return body;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        ts: { type: "string", description: "Slack message timestamp id" },
        user: { type: ["string", "null"], description: "Posting user id; null for app/system messages" },
        text: { type: "string" },
        type: { type: "string" },
        thread_ts: { type: ["string", "null"], description: "Parent thread id when the message is a reply" },
    },
    required: ["ts", "text", "type"],
};

export function describe() {
    return {
        identity: "@doax/slack-channel-history",
        kind: "data-source",
        collection: "slack messages visible to the caller, per channel",
        readParams: { channel: "channel id (required)", limit: "max records, default 20", oldest: "ts lower bound" },
    };
}

/** Caller-relative metadata (spec §5.2a, §5.3). */
export async function metadata(input, context) {
    const token = context?.credential?.token;
    const who = await slack("auth.test", token);
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: { note: "per-channel; bounded by Slack retention visible to this caller" },
            recordCount: { estimate: true, note: "unknown until a channel is read" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerTeam: who.team,
        },
    };
}

/** read -> { data, freshness, continuation } (spec §5.7). */
export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.channel) {
        throw Object.assign(new Error("channel-not-found: read requires a channel parameter"), { faultClass: "channel-not-found" });
    }
    const params = { channel: input.channel, limit: String(input.limit ?? 20) };
    if (input.oldest) params.oldest = String(input.oldest);
    if (input.cursor) params.cursor = String(input.cursor);
    const body = await slack("conversations.history", token, params);
    return {
        data: (body.messages ?? []).map((m) => ({
            ts: m.ts,
            user: m.user ?? null,
            text: m.text ?? "",
            type: m.subtype ? `message/${m.subtype}` : m.type,
            thread_ts: m.thread_ts ?? null,
        })),
        freshness: new Date().toISOString(),
        continuation: body.response_metadata?.next_cursor || null,
    };
}

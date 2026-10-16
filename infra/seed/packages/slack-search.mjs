/**
  * @doax/slack-search — data-source (spec §5).
  * One collection: Slack messages matching a full-text query, via search.messages.
  * Unlike the other Slack resources, search.messages requires a *user* token (xoxp-):
  * a bot token (xoxb-) is rejected by Slack with not_allowed_token_type. The query
  * interface the Registry leaves out (§5.4) is supplied here by Slack's own search.
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
                    fix: "search.messages needs the search:read scope on a user token; add it at https://api.slack.com/apps → OAuth & Permissions → User Token Scopes, reinstall, then re-authenticate (doax auth set @doax/slack-login)",
                },
            });
        }
        if (body.error === "not_allowed_token_type") {
            throw Object.assign(new Error("invalid-auth: search.messages requires a Slack user token (xoxp-), not a bot token (xoxb-)"), {
                faultClass: "invalid-auth",
                detail: { fix: "authenticate with a user token: doax auth set @doax/slack-login --secret xoxp-..." },
            });
        }
        const faultClass = body.error === "invalid_auth" || body.error === "token_revoked" ? "invalid-auth"
            : body.error === "ratelimited" ? "rate-limited" : "slack-error";
        throw Object.assign(new Error(`${faultClass}: ${body.error}`), { faultClass, slackError: body.error });
    }
    return body;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        ts: { type: "string", description: "Slack message timestamp id" },
        channel: { type: "string", description: "channel id the match is in" },
        channelName: { type: ["string", "null"] },
        user: { type: ["string", "null"] },
        text: { type: "string" },
        permalink: { type: ["string", "null"] },
        type: { type: "string" },
    },
    required: ["ts", "channel", "text", "type"],
};

export function describe() {
    return {
        identity: "@doax/slack-search",
        kind: "data-source",
        collection: "slack messages matching a full-text query, visible to the caller",
        readParams: { query: "search query (required)", count: "max records per page, default 20", page: "1-based page number, default 1" },
    };
}

/** Caller-relative metadata (spec §5.2a, §5.3). */
export async function metadata(input, context) {
    const token = context?.credential?.token;
    const who = await slack("auth.test", token);
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: { note: "spans all history the caller's token may search" },
            recordCount: { estimate: true, note: "unknown until a query is run" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerTeam: who.team,
        },
    };
}

/** read -> { data, freshness, continuation } (spec §5.7); continuation is the next page number. */
export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.query) {
        throw Object.assign(new Error("slack-error: read requires a query parameter"), { faultClass: "slack-error" });
    }
    const params = { query: String(input.query), count: String(input.count ?? 20), page: String(input.page ?? input.cursor ?? 1) };
    const body = await slack("search.messages", token, params);
    const matches = body.messages?.matches ?? [];
    const paging = body.messages?.paging ?? {};
    const next = paging.page && paging.pages && paging.page < paging.pages ? String(paging.page + 1) : null;
    return {
        data: matches.map((m) => ({
            ts: m.ts,
            channel: m.channel?.id ?? "",
            channelName: m.channel?.name ?? null,
            user: m.user ?? null,
            text: m.text ?? "",
            permalink: m.permalink ?? null,
            type: m.type ?? "message",
        })),
        freshness: new Date().toISOString(),
        continuation: next,
    };
}

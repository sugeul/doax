/**
  * @doax/slack-list-channel — data-source (spec §5).
  * One collection: the Slack channels visible to the caller's token, via conversations.list.
  * The natural first read: it yields the channel ids that slack-channel-history and
  * slack-post take as their `channel` parameter.
  */

const API = "https://slack.com/api";

async function slack(method, token, params = {}) {
    const query = new URLSearchParams(params).toString();
    const res = await fetch(`${API}/${method}?${query}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw Object.assign(new Error(`slack-unavailable: HTTP ${res.status}`), { faultClass: "slack-unavailable" });
    const body = await res.json();
    if (!body.ok) {
        const faultClass = body.error === "invalid_auth" || body.error === "token_revoked" ? "invalid-auth"
            : body.error === "ratelimited" ? "rate-limited" : "slack-error";
        throw Object.assign(new Error(`${faultClass}: ${body.error}`), { faultClass, slackError: body.error });
    }
    return body;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "channel id — the `channel` parameter of other Slack resources" },
        name: { type: "string" },
        is_private: { type: "boolean" },
        is_member: { type: "boolean", description: "whether the calling principal is a member" },
        num_members: { type: ["number", "null"] },
        topic: { type: ["string", "null"] },
    },
    required: ["id", "name", "is_private"],
};

export function describe() {
    return {
        identity: "@doax/slack-list-channel",
        kind: "data-source",
        collection: "slack channels visible to the caller",
        readParams: {
            types: "comma list of public_channel,private_channel (default public_channel)",
            limit: "max records, default 100",
            cursor: "continuation cursor",
        },
    };
}

/** Caller-relative metadata (spec §5.2a, §5.3). */
export async function metadata(input, context) {
    const token = context?.credential?.token;
    const who = await slack("auth.test", token);
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed",
            recordCount: { estimate: true, note: "bounded by the channels this caller may see" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerTeam: who.team,
        },
    };
}

/** read -> { data, freshness, continuation } (spec §5.7). */
export async function read(input, context) {
    const token = context?.credential?.token;
    const params = {
        types: String(input?.types ?? "public_channel"),
        limit: String(input?.limit ?? 100),
        exclude_archived: "true",
    };
    if (input?.cursor) params.cursor = String(input.cursor);
    const body = await slack("conversations.list", token, params);
    return {
        data: (body.channels ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            is_private: Boolean(c.is_private),
            is_member: Boolean(c.is_member),
            num_members: c.num_members ?? null,
            topic: c.topic?.value || null,
        })),
        freshness: new Date().toISOString(),
        continuation: body.response_metadata?.next_cursor || null,
    };
}

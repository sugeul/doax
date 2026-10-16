/**
  * @doax/teams-channel-messages — data-source (spec §5).
  * One collection: the top-level messages of one Teams channel, via
  * GET /teams/{team}/channels/{channel}/messages. Caller-relative (§5.3): you read
  * exactly what your token and membership allow.
  */

const GRAPH = "https://graph.microsoft.com/v1.0";

function graphFault(status, body, retryAfter) {
    const code = body?.error?.code ?? null;
    const message = body?.error?.message ?? "";
    if (status === 401) return Object.assign(new Error(`invalid-auth: ${code ?? "token rejected"}`), { faultClass: "invalid-auth", graphError: code });
    if (status === 403) {
        if (code === "Authorization_RequestDenied" || /scope|permission|consent/i.test(message)) {
            return Object.assign(new Error("missing-scope: the signed-in app lacks a required Microsoft Graph permission"), {
                faultClass: "missing-scope",
                detail: {
                    neededScope: null,
                    graphMessage: message || null,
                    fix: "grant the delegated permission at https://portal.azure.com → Entra ID → App registrations → your app → API permissions (admin-consent if required), then re-authenticate (doax auth set @doax/teams-login)",
                },
            });
        }
        return Object.assign(new Error(`access-denied: ${code ?? "forbidden"}`), {
            faultClass: "access-denied",
            graphError: code,
            detail: { fix: "the signed-in user is not a member of the target team/channel; join it or ask an owner to add you" },
        });
    }
    if (status === 429) return Object.assign(new Error("rate-limited: Microsoft Graph throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
    if (status === 404) {
        return Object.assign(new Error(`not-found: ${code ?? "team or channel id not found"}`), {
            faultClass: "not-found",
            graphError: code,
            detail: { fix: "check the team and channel ids (@doax/teams-list-team, @doax/teams-list-channel)" },
        });
    }
    if (status >= 500) return Object.assign(new Error(`graph-unavailable: HTTP ${status}`), { faultClass: "graph-unavailable" });
    return Object.assign(new Error(`graph-error: ${code ?? status}`), { faultClass: "graph-error", graphError: code });
}

/** Graph GET; `pathOrUrl` may be a continuation (@odata.nextLink) absolute url. */
async function graph(pathOrUrl, token, params) {
    const base = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    const url = params ? `${base}?${new URLSearchParams(params)}` : base;
    let res;
    try {
        res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw Object.assign(new Error("graph-unavailable: network failure reaching Microsoft Graph"), { faultClass: "graph-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw graphFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "Teams message id" },
        createdDateTime: { type: "string" },
        from: { type: ["string", "null"], description: "posting user display name; null for app/system messages" },
        text: { type: "string", description: "message body content (see contentType)" },
        contentType: { type: "string", description: "text | html" },
        type: { type: "string", description: "Graph messageType, e.g. message | systemEventMessage" },
    },
    required: ["id", "createdDateTime", "text", "type"],
};

export function describe() {
    return {
        identity: "@doax/teams-channel-messages",
        kind: "data-source",
        collection: "top-level messages of one Teams channel, visible to the caller",
        readParams: {
            team: "team id (required)",
            channel: "channel id (required)",
            limit: "max records, default 20",
            cursor: "continuation (an @odata.nextLink url)",
        },
    };
}

/** Caller-relative metadata (spec §5.2a, §5.3). */
export async function metadata(input, context) {
    const token = context?.credential?.token;
    const who = await graph("/me", token);
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: { note: "per-channel; bounded by the message retention visible to this caller" },
            recordCount: { estimate: true, note: "unknown until a channel is read" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerUpn: who.userPrincipalName ?? null,
        },
    };
}

/** read -> { data, freshness, continuation } (spec §5.7). */
export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.team || !input?.channel) {
        throw Object.assign(new Error("not-found: read requires team and channel parameters"), { faultClass: "not-found" });
    }
    const body = input.cursor
        ? await graph(String(input.cursor), token)
        : await graph(`/teams/${encodeURIComponent(input.team)}/channels/${encodeURIComponent(input.channel)}/messages`, token, { $top: String(input.limit ?? 20) });
    return {
        data: (body.value ?? []).map((m) => ({
            id: m.id,
            createdDateTime: m.createdDateTime ?? "",
            from: m.from?.user?.displayName ?? null,
            text: m.body?.content ?? "",
            contentType: m.body?.contentType ?? "text",
            type: m.messageType ?? "message",
        })),
        freshness: new Date().toISOString(),
        continuation: body["@odata.nextLink"] || null,
    };
}

/**
  * @doax/teams-search — data-source (spec §5).
  * One collection: Teams channel messages matching a query, via POST /search/query with
  * entityTypes ["chatMessage"]. The query interface the Registry leaves out (§5.4) is
  * supplied here by Microsoft Search. Caller-relative (§5.3): results are limited to
  * messages the signed-in user can access.
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

async function graph(path, token, { method = "GET", body } = {}) {
    let res;
    try {
        res = await fetch(`${GRAPH}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw Object.assign(new Error("graph-unavailable: network failure reaching Microsoft Graph"), { faultClass: "graph-unavailable" });
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw graphFault(res.status, payload, res.headers.get("retry-after"));
    return payload;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "Teams message id" },
        createdDateTime: { type: ["string", "null"] },
        from: { type: ["string", "null"], description: "posting user display name" },
        text: { type: "string", description: "message body content, or the search summary when the body is withheld" },
        teamId: { type: ["string", "null"], description: "the `team` parameter for reading the full message" },
        channelId: { type: ["string", "null"], description: "the `channel` parameter for reading the full message" },
        webUrl: { type: ["string", "null"] },
    },
    required: ["id", "text"],
};

export function describe() {
    return {
        identity: "@doax/teams-search",
        kind: "data-source",
        collection: "Teams channel messages matching a query, visible to the caller",
        readParams: { query: "search query (required)", limit: "max records per page, default 20", from: "offset for the next page, default 0" },
    };
}

/** Caller-relative metadata (spec §5.2a, §5.3). */
export async function metadata(input, context) {
    const token = context?.credential?.token;
    const who = await graph("/me", token);
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: { note: "spans the message history this caller may search" },
            recordCount: { estimate: true, note: "unknown until a query is run" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerUpn: who.userPrincipalName ?? null,
        },
    };
}

/** read -> { data, freshness, continuation } (spec §5.7); continuation is the next `from` offset. */
export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.query) {
        throw Object.assign(new Error("graph-error: read requires a query parameter"), { faultClass: "graph-error" });
    }
    const size = Number(input.limit ?? 20);
    const from = Number(input.from ?? input.cursor ?? 0);
    const request = { requests: [{ entityTypes: ["chatMessage"], query: { queryString: String(input.query) }, from, size }] };
    const body = await graph("/search/query", token, { method: "POST", body: request });
    const container = body.value?.[0]?.hitsContainers?.[0] ?? {};
    const hits = container.hits ?? [];
    return {
        data: hits.map((h) => {
            const r = h.resource ?? {};
            return {
                id: r.id ?? h.hitId ?? "",
                createdDateTime: r.createdDateTime ?? null,
                from: r.from?.user?.displayName ?? null,
                text: r.body?.content ?? h.summary ?? "",
                teamId: r.channelIdentity?.teamId ?? null,
                channelId: r.channelIdentity?.channelId ?? null,
                webUrl: r.webUrl ?? null,
            };
        }),
        freshness: new Date().toISOString(),
        continuation: container.moreResultsAvailable ? String(from + size) : null,
    };
}

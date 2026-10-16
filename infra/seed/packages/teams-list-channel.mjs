/**
  * @doax/teams-list-channel — data-source (spec §5).
  * One collection: the channels of one Microsoft Team, via GET /teams/{team}/channels.
  * Its `id` field is the `channel` parameter of teams-channel-messages and teams-post;
  * the `team` it reads is an id from teams-list-team.
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
        id: { type: "string", description: "channel id — the `channel` parameter of other Teams resources" },
        displayName: { type: "string" },
        description: { type: ["string", "null"] },
        membershipType: { type: "string", description: "standard | private | shared" },
        webUrl: { type: ["string", "null"] },
    },
    required: ["id", "displayName", "membershipType"],
};

export function describe() {
    return {
        identity: "@doax/teams-list-channel",
        kind: "data-source",
        collection: "channels of one Microsoft Team visible to the caller",
        readParams: {
            team: "team id (required)",
            membershipType: "filter: standard | private | shared (optional)",
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
            timeRange: "not time-indexed",
            recordCount: { estimate: true, note: "bounded by the channels this caller may see in the team" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerUpn: who.userPrincipalName ?? null,
        },
    };
}

/** read -> { data, freshness, continuation } (spec §5.7). */
export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.team) {
        throw Object.assign(new Error("not-found: read requires a team parameter"), { faultClass: "not-found" });
    }
    let body;
    if (input.cursor) {
        body = await graph(String(input.cursor), token);
    } else {
        const params = input.membershipType ? { $filter: `membershipType eq '${input.membershipType}'` } : undefined;
        body = await graph(`/teams/${encodeURIComponent(input.team)}/channels`, token, params);
    }
    return {
        data: (body.value ?? []).map((c) => ({
            id: c.id,
            displayName: c.displayName ?? "",
            description: c.description ?? null,
            membershipType: c.membershipType ?? "standard",
            webUrl: c.webUrl ?? null,
        })),
        freshness: new Date().toISOString(),
        continuation: body["@odata.nextLink"] || null,
    };
}

/**
  * @doax/tasklists-list — data-source (spec §5).
  * One collection: the caller's task lists, via Tasks API tasklists.list. A list's `id` is the
  * `tasklist` parameter of @doax/tasks-list and @doax/task-get. Caller-relative (§5.3).
  */

const BASE = "https://tasks.googleapis.com/tasks/v1";
const AUTH_URL = "https://auth.doax.io?appid=@doax/gmail-login";

function googleFault(status, body, retryAfter) {
    const err = body?.error;
    const reason = Array.isArray(err?.errors) ? err.errors[0]?.reason : null;
    const message = (typeof err === "string" ? err : err?.message) ?? "";
    if (status === 401) return Object.assign(new Error(`invalid-auth: ${reason ?? "token rejected"}`), { faultClass: "invalid-auth", googleError: reason });
    if (status === 403) {
        if (reason === "accessNotConfigured" || /accessNotConfigured|has not been used in project|is disabled/i.test(message)) return Object.assign(new Error("access-denied: the Tasks API is not enabled for this OAuth client's project"), { faultClass: "access-denied", googleError: reason, detail: { fix: "enable the Tasks API in the doax-adapter-gmail project, then retry" } });
        if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return Object.assign(new Error("rate-limited: Tasks throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
        if (reason === "insufficientPermissions" || /insufficient.*scope/i.test(message)) return Object.assign(new Error("missing-scope: the token lacks tasks.readonly"), { faultClass: "missing-scope", detail: { neededScope: "https://www.googleapis.com/auth/tasks.readonly", fix: `re-consent at ${AUTH_URL}, then re-authenticate (doax auth set @doax/gmail-login)` } });
        return Object.assign(new Error(`access-denied: ${reason ?? "forbidden"}`), { faultClass: "access-denied", googleError: reason });
    }
    if (status === 429) return Object.assign(new Error("rate-limited: Tasks throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
    if (status >= 500) return Object.assign(new Error(`google-unavailable: HTTP ${status}`), { faultClass: "google-unavailable" });
    return Object.assign(new Error(`google-error: ${reason ?? status}`), { faultClass: "google-error", googleError: reason });
}

async function google(path, token, params) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") query.set(k, String(v));
    const qs = query.toString();
    let res;
    try {
        res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw Object.assign(new Error("google-unavailable: network failure reaching Tasks"), { faultClass: "google-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw googleFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "task list id — the `tasklist` parameter of @doax/tasks-list" },
        title: { type: "string" },
        updated: { type: ["string", "null"] },
    },
    required: ["id", "title"],
};

export function describe() {
    return {
        identity: "@doax/tasklists-list",
        kind: "data-source",
        collection: "the caller's task lists",
        readParams: { maxResults: "max lists per page (default 100)", cursor: "continuation (a Tasks pageToken)" },
    };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    await google("/users/@me/lists", token, { maxResults: "1" });
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed",
            recordCount: { estimate: true, note: "bounded by the caller's task lists" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
        },
    };
}

export async function read(input, context) {
    const token = context?.credential?.token;
    const body = await google("/users/@me/lists", token, { maxResults: String(input?.maxResults ?? 100), pageToken: input?.cursor });
    return {
        data: (body.items ?? []).map((l) => ({ id: l.id, title: l.title ?? "", updated: l.updated ?? null })),
        freshness: new Date().toISOString(),
        continuation: body.nextPageToken || null,
    };
}

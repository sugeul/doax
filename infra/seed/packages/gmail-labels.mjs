/**
  * @doax/gmail-labels — data-source (spec §5).
  * One collection: the caller's Gmail labels, via users.labels.list. The natural lookup for the
  * `labelIds` parameter of @doax/gmail-messages. Caller-relative (§5.3).
  */

const BASE = "https://gmail.googleapis.com/gmail/v1";
const AUTH_URL = "https://auth.doax.io?appid=@doax/gmail-login";

function googleFault(status, body, retryAfter) {
    const err = body?.error;
    const reason = Array.isArray(err?.errors) ? err.errors[0]?.reason : null;
    const message = (typeof err === "string" ? err : err?.message) ?? "";
    if (status === 401) return Object.assign(new Error(`invalid-auth: ${reason ?? "token rejected"}`), { faultClass: "invalid-auth", googleError: reason });
    if (status === 403) {
        if (reason === "accessNotConfigured" || /accessNotConfigured|has not been used in project|is disabled/i.test(message)) return Object.assign(new Error("access-denied: the Gmail API is not enabled for this OAuth client's project"), { faultClass: "access-denied", googleError: reason, detail: { fix: "enable the Gmail API in the doax-adapter-gmail project, then retry" } });
        if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return Object.assign(new Error("rate-limited: Gmail throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
        if (reason === "insufficientPermissions" || /insufficient.*scope/i.test(message)) return Object.assign(new Error("missing-scope: the token lacks gmail.readonly"), { faultClass: "missing-scope", detail: { neededScope: "https://www.googleapis.com/auth/gmail.readonly", fix: `re-consent at ${AUTH_URL}, then re-authenticate (doax auth set @doax/gmail-login)` } });
        return Object.assign(new Error(`access-denied: ${reason ?? "forbidden"}`), { faultClass: "access-denied", googleError: reason });
    }
    if (status === 429) return Object.assign(new Error("rate-limited: Gmail throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
    if (status >= 500) return Object.assign(new Error(`google-unavailable: HTTP ${status}`), { faultClass: "google-unavailable" });
    return Object.assign(new Error(`google-error: ${reason ?? status}`), { faultClass: "google-error", googleError: reason });
}

async function google(path, token) {
    let res;
    try {
        res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw Object.assign(new Error("google-unavailable: network failure reaching Gmail"), { faultClass: "google-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw googleFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "label id — a value for the `labelIds` parameter of @doax/gmail-messages" },
        name: { type: "string" },
        type: { type: "string", description: "system | user" },
        messageListVisibility: { type: ["string", "null"] },
        labelListVisibility: { type: ["string", "null"] },
    },
    required: ["id", "name", "type"],
};

export function describe() {
    return { identity: "@doax/gmail-labels", kind: "data-source", collection: "the caller's Gmail labels", readParams: {} };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    const profile = await google("/users/me/profile", token);
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed",
            recordCount: { estimate: true, note: "bounded by the caller's label set" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerEmail: profile.emailAddress ?? null,
        },
    };
}

export async function read(input, context) {
    const token = context?.credential?.token;
    const body = await google("/users/me/labels", token);
    return {
        data: (body.labels ?? []).map((l) => ({
            id: l.id,
            name: l.name ?? "",
            type: l.type ?? "user",
            messageListVisibility: l.messageListVisibility ?? null,
            labelListVisibility: l.labelListVisibility ?? null,
        })),
        freshness: new Date().toISOString(),
        continuation: null,
    };
}

/**
  * @doax/gmail-get — data-source (spec §5).
  * One collection of one record: a single Gmail message, via users.messages.get (format=full),
  * with the plain-text body decoded. The `messageId` comes from @doax/gmail-messages (its `id`).
  * Caller-relative (§5.3): resolves only if the gmail.readonly token may see the message.
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
    if (status === 404) return Object.assign(new Error(`not-found: ${reason ?? "message id not found"}`), { faultClass: "not-found", googleError: reason, detail: { fix: "check the messageId (@doax/gmail-messages)" } });
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
        throw Object.assign(new Error("google-unavailable: network failure reaching Gmail"), { faultClass: "google-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw googleFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

const header = (payload, name) => (payload?.headers ?? []).find((h) => h.name?.toLowerCase() === name)?.value ?? null;

/** Walk the MIME tree for the first part of `mime`, returning its decoded (base64url) text. */
function findBody(payload, mime) {
    if (!payload) return null;
    if (payload.mimeType === mime && payload.body?.data) return Buffer.from(payload.body.data, "base64url").toString("utf8");
    for (const part of payload.parts ?? []) {
        const found = findBody(part, mime);
        if (found) return found;
    }
    return null;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string" },
        threadId: { type: "string" },
        snippet: { type: ["string", "null"] },
        subject: { type: ["string", "null"] },
        from: { type: ["string", "null"] },
        to: { type: ["string", "null"] },
        cc: { type: ["string", "null"] },
        date: { type: ["string", "null"] },
        internalDate: { type: ["string", "null"] },
        labelIds: { type: "array", items: { type: "string" } },
        bodyText: { type: ["string", "null"], description: "decoded text/plain body, if present" },
        bodyHtml: { type: ["string", "null"], description: "decoded text/html body, if present" },
        sizeEstimate: { type: ["integer", "null"] },
    },
    required: ["id", "threadId"],
};

export function describe() {
    return {
        identity: "@doax/gmail-get",
        kind: "data-source",
        collection: "a single Gmail message",
        readParams: { messageId: "the Gmail message id (required)", format: "full | metadata | minimal (default full)" },
    };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    const profile = await google("/users/me/profile", token);
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed; a point lookup by messageId",
            recordCount: { estimate: false, exact: 1, note: "one message, or a not-found fault" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerEmail: profile.emailAddress ?? null,
        },
    };
}

export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.messageId) throw Object.assign(new Error("not-found: read requires a messageId parameter"), { faultClass: "not-found" });
    const m = await google(`/users/me/messages/${encodeURIComponent(input.messageId)}`, token, { format: input?.format ?? "full" });
    return {
        data: [
            {
                id: m.id,
                threadId: m.threadId,
                snippet: m.snippet ?? null,
                subject: header(m.payload, "subject"),
                from: header(m.payload, "from"),
                to: header(m.payload, "to"),
                cc: header(m.payload, "cc"),
                date: header(m.payload, "date"),
                internalDate: m.internalDate ?? null,
                labelIds: m.labelIds ?? [],
                bodyText: findBody(m.payload, "text/plain"),
                bodyHtml: findBody(m.payload, "text/html"),
                sizeEstimate: m.sizeEstimate ?? null,
            },
        ],
        freshness: new Date().toISOString(),
        continuation: null,
    };
}

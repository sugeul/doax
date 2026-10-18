/**
  * @doax/gmail-messages — data-source (spec §5).
  * One collection: the caller's Gmail messages matching a query, via users.messages.list, each
  * enriched with its header metadata (users.messages.get, format=metadata). Caller-relative
  * (§5.3). An `id` is the `messageId` parameter of @doax/gmail-get.
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
    if (status === 404) return Object.assign(new Error(`not-found: ${reason ?? "resource not found"}`), { faultClass: "not-found", googleError: reason });
    if (status >= 500) return Object.assign(new Error(`google-unavailable: HTTP ${status}`), { faultClass: "google-unavailable" });
    return Object.assign(new Error(`google-error: ${reason ?? status}`), { faultClass: "google-error", googleError: reason });
}

async function google(path, token, params) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
        if (v === undefined || v === null || v === "") continue;
        if (Array.isArray(v)) for (const item of v) query.append(k, String(item));
        else query.set(k, String(v));
    }
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

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "message id — the `messageId` parameter of @doax/gmail-get" },
        threadId: { type: "string" },
        snippet: { type: ["string", "null"] },
        subject: { type: ["string", "null"] },
        from: { type: ["string", "null"] },
        to: { type: ["string", "null"] },
        date: { type: ["string", "null"] },
        internalDate: { type: ["string", "null"], description: "epoch ms as a string" },
        labelIds: { type: "array", items: { type: "string" } },
    },
    required: ["id", "threadId"],
};

export function describe() {
    return {
        identity: "@doax/gmail-messages",
        kind: "data-source",
        collection: "the caller's Gmail messages matching a query",
        readParams: {
            q: "a Gmail search query, e.g. 'from:boss is:unread newer_than:7d'",
            labelIds: "restrict to label ids (array); e.g. ['INBOX']",
            maxResults: "max messages per page (default 20; each is enriched with header metadata)",
            includeSpamTrash: "include SPAM and TRASH (default false)",
            cursor: "continuation (a Gmail pageToken)",
        },
    };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    const profile = await google("/users/me/profile", token);
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "ordered newest-first; narrow with the `q` query (e.g. newer_than:)",
            recordCount: { estimate: true, note: `mailbox has ~${profile.messagesTotal ?? "?"} messages; this reads the query's matches` },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerEmail: profile.emailAddress ?? null,
        },
    };
}

export async function read(input, context) {
    const token = context?.credential?.token;
    const list = await google("/users/me/messages", token, {
        q: input?.q,
        labelIds: input?.labelIds,
        maxResults: input?.maxResults ?? 20,
        includeSpamTrash: input?.includeSpamTrash ? "true" : undefined,
        pageToken: input?.cursor,
    });
    const refs = list.messages ?? [];
    // Enrich each ref with header metadata (list itself returns only id/threadId).
    const full = await Promise.all(
        refs.map((m) =>
            google(`/users/me/messages/${encodeURIComponent(m.id)}`, token, { format: "metadata", metadataHeaders: ["Subject", "From", "To", "Date"] }).catch(() => null),
        ),
    );
    return {
        data: refs.map((m, idx) => {
            const msg = full[idx];
            return {
                id: m.id,
                threadId: m.threadId,
                snippet: msg?.snippet ?? null,
                subject: header(msg?.payload, "subject"),
                from: header(msg?.payload, "from"),
                to: header(msg?.payload, "to"),
                date: header(msg?.payload, "date"),
                internalDate: msg?.internalDate ?? null,
                labelIds: msg?.labelIds ?? [],
            };
        }),
        freshness: new Date().toISOString(),
        continuation: list.nextPageToken || null,
    };
}

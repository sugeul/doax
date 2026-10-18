/**
  * @doax/gmail-history — data-source (spec §5).
  * One collection: the caller's Gmail change feed (delta), via users.history.list. With no cursor,
  * read() establishes a baseline (the mailbox's current historyId) and returns it as the token to
  * poll from; thereafter the caller polls with `nextDeltaToken`. Caller-relative (§5.3).
  *
  *   continuation   — a Gmail pageToken: MORE pages of the current delta exist now.
  *   nextDeltaToken — the latest historyId: this delta is drained; poll again later with it.
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
    // 404 on history.list means the startHistoryId is too old (expired); the caller must resync.
    if (status === 404) return Object.assign(new Error("not-found: the history cursor is too old (resync required)"), { faultClass: "not-found", googleError: reason, detail: { fix: "read with no cursor to get a fresh baseline historyId, then re-list messages via @doax/gmail-messages" } });
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

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        historyId: { type: "string", description: "the history record's id" },
        messageId: { type: ["string", "null"] },
        threadId: { type: ["string", "null"] },
        changeType: { type: "string", description: "messageAdded | messageDeleted | labelAdded | labelRemoved" },
        labelIds: { type: "array", items: { type: "string" }, description: "labels added/removed, when changeType is label*" },
    },
    required: ["historyId", "changeType"],
};

export function describe() {
    return {
        identity: "@doax/gmail-history",
        kind: "data-source",
        collection: "the caller's Gmail change feed (delta)",
        readParams: {
            cursor: "a historyId to list changes since; omit for a fresh baseline (nextDeltaToken from a prior read)",
            pageToken: "continuation within one delta: keep `cursor` the same and pass the prior read's `continuation` here",
            historyTypes: "restrict to change types (array): messageAdded, messageDeleted, labelAdded, labelRemoved",
            labelId: "only history affecting this label id",
        },
    };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    const profile = await google("/users/me/profile", token);
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "changes since the supplied cursor; Gmail retains history for a limited window",
            recordCount: { estimate: true, note: "unknown until a delta is read; zero when nothing changed" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerEmail: profile.emailAddress ?? null,
            currentHistoryId: profile.historyId ?? null,
        },
    };
}

/** Flatten Gmail's per-record change groups into one row per (record, change). */
function flatten(history) {
    const rows = [];
    for (const h of history ?? []) {
        for (const a of h.messagesAdded ?? []) rows.push({ historyId: h.id, messageId: a.message?.id ?? null, threadId: a.message?.threadId ?? null, changeType: "messageAdded", labelIds: [] });
        for (const d of h.messagesDeleted ?? []) rows.push({ historyId: h.id, messageId: d.message?.id ?? null, threadId: d.message?.threadId ?? null, changeType: "messageDeleted", labelIds: [] });
        for (const l of h.labelsAdded ?? []) rows.push({ historyId: h.id, messageId: l.message?.id ?? null, threadId: l.message?.threadId ?? null, changeType: "labelAdded", labelIds: l.labelIds ?? [] });
        for (const l of h.labelsRemoved ?? []) rows.push({ historyId: h.id, messageId: l.message?.id ?? null, threadId: l.message?.threadId ?? null, changeType: "labelRemoved", labelIds: l.labelIds ?? [] });
    }
    return rows;
}

export async function read(input, context) {
    const token = context?.credential?.token;
    // No cursor: establish a baseline historyId (empty delta) to poll from.
    if (!input?.cursor) {
        const profile = await google("/users/me/profile", token);
        return { data: [], freshness: new Date().toISOString(), continuation: null, nextDeltaToken: profile.historyId ?? null };
    }
    const body = await google("/users/me/history", token, {
        startHistoryId: String(input.cursor),
        historyType: input?.historyTypes,
        labelId: input?.labelId,
        pageToken: input?.pageToken,
    });
    return {
        data: flatten(body.history),
        freshness: new Date().toISOString(),
        continuation: body.nextPageToken || null,
        // The mailbox's latest historyId — poll the NEXT delta from here (pass back as `cursor`).
        nextDeltaToken: body.historyId || String(input.cursor),
    };
}

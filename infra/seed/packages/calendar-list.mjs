/**
  * @doax/calendar-list — data-source (spec §5).
  * One collection: the calendars on the caller's calendar list, via calendarList.list. The natural
  * first read — an entry's `id` is the `calendarId` parameter of @doax/calendar-events and
  * @doax/calendar-event-get. Caller-relative (§5.3).
  */

const BASE = "https://www.googleapis.com/calendar/v3";
const AUTH_URL = "https://auth.doax.io?appid=@doax/gmail-login";

function googleFault(status, body, retryAfter) {
    const err = body?.error;
    const reason = Array.isArray(err?.errors) ? err.errors[0]?.reason : null;
    const message = (typeof err === "string" ? err : err?.message) ?? "";
    if (status === 401) return Object.assign(new Error(`invalid-auth: ${reason ?? "token rejected"}`), { faultClass: "invalid-auth", googleError: reason });
    if (status === 403) {
        if (reason === "accessNotConfigured" || /accessNotConfigured|has not been used in project|is disabled/i.test(message)) return Object.assign(new Error("access-denied: the Calendar API is not enabled for this OAuth client's project"), { faultClass: "access-denied", googleError: reason, detail: { fix: "enable the Calendar API in the doax-adapter-gmail project, then retry" } });
        if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return Object.assign(new Error("rate-limited: Calendar throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
        if (reason === "insufficientPermissions" || /insufficient.*scope/i.test(message)) return Object.assign(new Error("missing-scope: the token lacks calendar.readonly"), { faultClass: "missing-scope", detail: { neededScope: "https://www.googleapis.com/auth/calendar.readonly", fix: `re-consent at ${AUTH_URL}, then re-authenticate (doax auth set @doax/gmail-login)` } });
        return Object.assign(new Error(`access-denied: ${reason ?? "forbidden"}`), { faultClass: "access-denied", googleError: reason });
    }
    if (status === 429) return Object.assign(new Error("rate-limited: Calendar throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
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
        throw Object.assign(new Error("google-unavailable: network failure reaching Calendar"), { faultClass: "google-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw googleFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "calendar id — the `calendarId` parameter of @doax/calendar-events" },
        summary: { type: "string" },
        description: { type: ["string", "null"] },
        primary: { type: ["boolean", "null"] },
        accessRole: { type: ["string", "null"], description: "owner | writer | reader | freeBusyReader" },
        timeZone: { type: ["string", "null"] },
        backgroundColor: { type: ["string", "null"] },
    },
    required: ["id", "summary"],
};

export function describe() {
    return {
        identity: "@doax/calendar-list",
        kind: "data-source",
        collection: "the calendars on the caller's calendar list",
        readParams: { showHidden: "include hidden calendars (default false)", cursor: "continuation (a Calendar pageToken)" },
    };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    const settings = await google("/users/me/settings/timezone", token).catch(() => ({}));
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed",
            recordCount: { estimate: true, note: "bounded by the caller's calendar list" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerTimeZone: settings.value ?? null,
        },
    };
}

export async function read(input, context) {
    const token = context?.credential?.token;
    const body = await google("/users/me/calendarList", token, { showHidden: input?.showHidden ? "true" : undefined, pageToken: input?.cursor });
    return {
        data: (body.items ?? []).map((c) => ({
            id: c.id,
            summary: c.summary ?? "",
            description: c.description ?? null,
            primary: c.primary ?? null,
            accessRole: c.accessRole ?? null,
            timeZone: c.timeZone ?? null,
            backgroundColor: c.backgroundColor ?? null,
        })),
        freshness: new Date().toISOString(),
        continuation: body.nextPageToken || null,
    };
}

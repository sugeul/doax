/**
  * @doax/calendar-event-get — data-source (spec §5).
  * One collection of one record: a single calendar event, via events.get. The `eventId` comes from
  * @doax/calendar-events (its `id`). Caller-relative (§5.3).
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
    if (status === 404) return Object.assign(new Error(`not-found: ${reason ?? "calendar or event not found"}`), { faultClass: "not-found", googleError: reason, detail: { fix: "check the calendarId (@doax/calendar-list) and eventId (@doax/calendar-events)" } });
    if (status >= 500) return Object.assign(new Error(`google-unavailable: HTTP ${status}`), { faultClass: "google-unavailable" });
    return Object.assign(new Error(`google-error: ${reason ?? status}`), { faultClass: "google-error", googleError: reason });
}

async function google(path, token) {
    let res;
    try {
        res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
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
        id: { type: "string" },
        status: { type: ["string", "null"] },
        summary: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
        location: { type: ["string", "null"] },
        start: { type: ["object", "null"] },
        end: { type: ["object", "null"] },
        organizer: { type: ["object", "null"] },
        attendees: { type: "array" },
        hangoutLink: { type: ["string", "null"] },
        htmlLink: { type: ["string", "null"] },
        recurringEventId: { type: ["string", "null"] },
        recurrence: { type: "array", items: { type: "string" } },
        created: { type: ["string", "null"] },
        updated: { type: ["string", "null"] },
    },
    required: ["id"],
};

export function describe() {
    return {
        identity: "@doax/calendar-event-get",
        kind: "data-source",
        collection: "a single calendar event",
        readParams: { calendarId: "the calendar id (default 'primary')", eventId: "the event id (required)" },
    };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    await google("/users/me/calendarList", token).catch(() => ({})); // caller-relative check
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed; a point lookup by eventId",
            recordCount: { estimate: false, exact: 1, note: "one event, or a not-found fault" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
        },
    };
}

export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.eventId) throw Object.assign(new Error("not-found: read requires an eventId parameter"), { faultClass: "not-found" });
    const calendarId = encodeURIComponent(input?.calendarId ?? "primary");
    const e = await google(`/calendars/${calendarId}/events/${encodeURIComponent(input.eventId)}`, token);
    return {
        data: [
            {
                id: e.id,
                status: e.status ?? null,
                summary: e.summary ?? null,
                description: e.description ?? null,
                location: e.location ?? null,
                start: e.start ?? null,
                end: e.end ?? null,
                organizer: e.organizer ?? null,
                attendees: e.attendees ?? [],
                hangoutLink: e.hangoutLink ?? null,
                htmlLink: e.htmlLink ?? null,
                recurringEventId: e.recurringEventId ?? null,
                recurrence: e.recurrence ?? [],
                created: e.created ?? null,
                updated: e.updated ?? null,
            },
        ],
        freshness: new Date().toISOString(),
        continuation: null,
    };
}

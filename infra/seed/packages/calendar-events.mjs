/**
  * @doax/calendar-events — data-source (spec §5).
  * One collection: the events of one calendar, via events.list — list AND delta in one resource.
  * A first read (optionally windowed by timeMin/timeMax) returns a page of events and, at the end,
  * a sync token; thereafter the caller polls with that token via `cursor` for incremental changes.
  * Caller-relative (§5.3): you read exactly what the calendar.readonly token may read.
  *
  *   continuation   — a Calendar pageToken: MORE pages of the current result set exist now.
  *   nextDeltaToken — a Calendar syncToken: this set is drained; poll changes later with it (as `cursor`).
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
    // 410 Gone: the syncToken is no longer valid; a full resync is required.
    if (status === 410) return Object.assign(new Error("not-found: the sync token is no longer valid (resync required)"), { faultClass: "not-found", googleError: reason, detail: { fix: "read with no cursor (optionally timeMin/timeMax) to resync, then poll with the new nextDeltaToken" } });
    if (status === 404) return Object.assign(new Error(`not-found: ${reason ?? "calendar not found"}`), { faultClass: "not-found", googleError: reason, detail: { fix: "check the calendarId (@doax/calendar-list)" } });
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
        id: { type: "string", description: "event id — the `eventId` parameter of @doax/calendar-event-get" },
        status: { type: ["string", "null"], description: "confirmed | tentative | cancelled (cancelled appears in delta reads)" },
        summary: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
        location: { type: ["string", "null"] },
        start: { type: ["object", "null"], description: "{ dateTime | date, timeZone }" },
        end: { type: ["object", "null"] },
        organizer: { type: ["object", "null"] },
        attendees: { type: "array" },
        htmlLink: { type: ["string", "null"] },
        recurringEventId: { type: ["string", "null"] },
        updated: { type: ["string", "null"] },
    },
    required: ["id"],
};

export function describe() {
    return {
        identity: "@doax/calendar-events",
        kind: "data-source",
        collection: "the events of one calendar",
        readParams: {
            calendarId: "the calendar id (default 'primary')",
            timeMin: "RFC3339 lower bound on event end (ignored when a sync cursor is used)",
            timeMax: "RFC3339 upper bound on event start (ignored when a sync cursor is used)",
            q: "free-text search (ignored when a sync cursor is used)",
            singleEvents: "expand recurring events into instances (default true)",
            maxResults: "max events per page (default 100)",
            cursor: "a pageToken (same result set) or a syncToken (next delta); omit for a fresh read",
        },
    };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    const cal = await google(`/calendars/${encodeURIComponent(input?.calendarId ?? "primary")}`, token).catch(() => ({}));
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "windowed by timeMin/timeMax on a fresh read; a sync cursor returns changes since it was issued",
            recordCount: { estimate: true, note: "unknown until read; bounded by the window or the delta" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            calendarTimeZone: cal.timeZone ?? null,
        },
    };
}

export async function read(input, context) {
    const token = context?.credential?.token;
    const calendarId = encodeURIComponent(input?.calendarId ?? "primary");
    // A sync cursor forbids timeMin/timeMax/q/orderBy; a page cursor keeps the original window
    // (Calendar bakes the window into the pageToken), so we only send the token when a cursor is given.
    const params = input?.cursor
        ? { singleEvents: String(input?.singleEvents ?? true), maxResults: String(input?.maxResults ?? 100) }
        : {
              timeMin: input?.timeMin,
              timeMax: input?.timeMax,
              q: input?.q,
              singleEvents: String(input?.singleEvents ?? true),
              orderBy: input?.timeMin || input?.timeMax ? "startTime" : undefined,
              maxResults: String(input?.maxResults ?? 100),
          };
    // Decide whether the cursor is a page token or a sync token. Heuristic: callers pass the prior
    // read's `continuation` (page) back as cursor, or its `nextDeltaToken` (sync). Both are opaque,
    // so try pageToken first and fall back to syncToken on the 400 Calendar returns for a wrong slot.
    let body;
    if (input?.cursor) {
        try {
            body = await google(`/calendars/${calendarId}/events`, token, { ...params, pageToken: String(input.cursor) });
        } catch (e) {
            if (e.faultClass === "google-error") body = await google(`/calendars/${calendarId}/events`, token, { ...params, syncToken: String(input.cursor) });
            else throw e;
        }
    } else {
        body = await google(`/calendars/${calendarId}/events`, token, params);
    }
    return {
        data: (body.items ?? []).map((e) => ({
            id: e.id,
            status: e.status ?? null,
            summary: e.summary ?? null,
            description: e.description ?? null,
            location: e.location ?? null,
            start: e.start ?? null,
            end: e.end ?? null,
            organizer: e.organizer ?? null,
            attendees: e.attendees ?? [],
            htmlLink: e.htmlLink ?? null,
            recurringEventId: e.recurringEventId ?? null,
            updated: e.updated ?? null,
        })),
        freshness: new Date().toISOString(),
        continuation: body.nextPageToken || null,
        // Present on the final page: the token to poll the NEXT delta with (pass back as `cursor`).
        nextDeltaToken: body.nextSyncToken || null,
    };
}

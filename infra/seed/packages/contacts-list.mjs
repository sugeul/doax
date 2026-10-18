/**
  * @doax/contacts-list — data-source (spec §5).
  * One collection: the caller's contacts, via People API people.connections.list — list AND delta.
  * A first read returns a page of connections and, at the end, a sync token; thereafter the caller
  * polls with that token via `cursor` for incremental changes. A `resourceName` is the parameter of
  * @doax/contacts-get. Caller-relative (§5.3).
  *
  *   continuation   — a People pageToken: MORE pages of the current set exist now.
  *   nextDeltaToken — a People syncToken: this set is drained; poll changes later with it (as `cursor`).
  */

const BASE = "https://people.googleapis.com/v1";
const AUTH_URL = "https://auth.doax.io?appid=@doax/gmail-login";
const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,metadata";

function googleFault(status, body, retryAfter) {
    const err = body?.error;
    const reason = Array.isArray(err?.errors) ? err.errors[0]?.reason : null;
    const message = (typeof err === "string" ? err : err?.message) ?? "";
    if (status === 401) return Object.assign(new Error(`invalid-auth: ${reason ?? "token rejected"}`), { faultClass: "invalid-auth", googleError: reason });
    if (status === 403) {
        if (reason === "accessNotConfigured" || /accessNotConfigured|has not been used in project|is disabled/i.test(message)) return Object.assign(new Error("access-denied: the People API is not enabled for this OAuth client's project"), { faultClass: "access-denied", googleError: reason, detail: { fix: "enable the People API in the doax-adapter-gmail project, then retry" } });
        if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return Object.assign(new Error("rate-limited: People throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
        if (reason === "insufficientPermissions" || /insufficient.*scope/i.test(message)) return Object.assign(new Error("missing-scope: the token lacks contacts.readonly"), { faultClass: "missing-scope", detail: { neededScope: "https://www.googleapis.com/auth/contacts.readonly", fix: `re-consent at ${AUTH_URL}, then re-authenticate (doax auth set @doax/gmail-login)` } });
        return Object.assign(new Error(`access-denied: ${reason ?? "forbidden"}`), { faultClass: "access-denied", googleError: reason });
    }
    if (status === 429) return Object.assign(new Error("rate-limited: People throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
    // 400 with EXPIRED_SYNC_TOKEN: the syncToken is stale; a full resync is required.
    if (status === 400 && /sync token/i.test(message)) return Object.assign(new Error("not-found: the sync token is no longer valid (resync required)"), { faultClass: "not-found", detail: { fix: "read with no cursor to resync, then poll with the new nextDeltaToken" } });
    if (status === 404) return Object.assign(new Error(`not-found: ${reason ?? "resource not found"}`), { faultClass: "not-found", googleError: reason });
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
        throw Object.assign(new Error("google-unavailable: network failure reaching People"), { faultClass: "google-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw googleFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

const primary = (arr, field) => (arr ?? []).map((x) => x[field]).filter(Boolean);

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        resourceName: { type: "string", description: "people/* id — the `resourceName` parameter of @doax/contacts-get" },
        displayName: { type: ["string", "null"] },
        emails: { type: "array", items: { type: "string" } },
        phones: { type: "array", items: { type: "string" } },
        organizations: { type: "array", items: { type: "string" } },
        deleted: { type: "boolean", description: "true for a contact removed since the sync token (delta reads)" },
    },
    required: ["resourceName"],
};

export function describe() {
    return {
        identity: "@doax/contacts-list",
        kind: "data-source",
        collection: "the caller's contacts (connections)",
        readParams: {
            pageSize: "max contacts per page (default 100, max 1000)",
            personFields: `fields to return (default ${PERSON_FIELDS})`,
            cursor: "a pageToken (same set) or a syncToken (next delta); omit for a fresh read",
        },
    };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    const me = await google("/people/me", token, { personFields: "names,emailAddresses" }).catch(() => ({}));
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed; a sync cursor returns changes since it was issued",
            recordCount: { estimate: true, note: "bounded by the caller's contacts" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerName: me.names?.[0]?.displayName ?? null,
        },
    };
}

export async function read(input, context) {
    const token = context?.credential?.token;
    const personFields = input?.personFields ?? PERSON_FIELDS;
    // A sync cursor and a page cursor occupy different slots; try pageToken, fall back to syncToken.
    const baseParams = { personFields, pageSize: String(input?.pageSize ?? 100), requestSyncToken: "true" };
    let body;
    if (input?.cursor) {
        try {
            body = await google("/people/me/connections", token, { ...baseParams, pageToken: String(input.cursor) });
        } catch (e) {
            if (e.faultClass === "google-error") body = await google("/people/me/connections", token, { ...baseParams, syncToken: String(input.cursor) });
            else throw e;
        }
    } else {
        body = await google("/people/me/connections", token, baseParams);
    }
    return {
        data: (body.connections ?? []).map((p) => ({
            resourceName: p.resourceName,
            displayName: p.names?.[0]?.displayName ?? null,
            emails: primary(p.emailAddresses, "value"),
            phones: primary(p.phoneNumbers, "value"),
            organizations: primary(p.organizations, "name"),
            deleted: Boolean(p.metadata?.deleted),
        })),
        freshness: new Date().toISOString(),
        continuation: body.nextPageToken || null,
        // Present on the final page: the token to poll the NEXT delta with (pass back as `cursor`).
        nextDeltaToken: body.nextSyncToken || null,
    };
}

/**
  * @doax/contacts-get — data-source (spec §5).
  * One collection of one record: a single contact, via People API people.get. The `resourceName`
  * comes from @doax/contacts-list (its `resourceName`). Caller-relative (§5.3).
  */

const BASE = "https://people.googleapis.com/v1";
const AUTH_URL = "https://auth.doax.io?appid=@doax/gmail-login";
const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,addresses,birthdays,biographies,urls,photos,metadata";

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
    if (status === 404) return Object.assign(new Error(`not-found: ${reason ?? "contact not found"}`), { faultClass: "not-found", googleError: reason, detail: { fix: "check the resourceName (@doax/contacts-list)" } });
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

const vals = (arr, field) => (arr ?? []).map((x) => x[field]).filter(Boolean);

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        resourceName: { type: "string" },
        displayName: { type: ["string", "null"] },
        emails: { type: "array", items: { type: "string" } },
        phones: { type: "array", items: { type: "string" } },
        organizations: { type: "array", items: { type: "string" } },
        addresses: { type: "array", items: { type: "string" } },
        urls: { type: "array", items: { type: "string" } },
        biography: { type: ["string", "null"] },
        photoUrl: { type: ["string", "null"] },
    },
    required: ["resourceName"],
};

export function describe() {
    return {
        identity: "@doax/contacts-get",
        kind: "data-source",
        collection: "a single contact",
        readParams: { resourceName: "the people/* resource name (required)", personFields: `fields to return (default ${PERSON_FIELDS})` },
    };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    await google("/people/me", token, { personFields: "names" }).catch(() => ({}));
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed; a point lookup by resourceName",
            recordCount: { estimate: false, exact: 1, note: "one contact, or a not-found fault" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
        },
    };
}

export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.resourceName) throw Object.assign(new Error("not-found: read requires a resourceName parameter"), { faultClass: "not-found" });
    // People resourceNames are like "people/c123"; pass through as the path segment.
    const p = await google(`/${input.resourceName}`, token, { personFields: input?.personFields ?? PERSON_FIELDS });
    return {
        data: [
            {
                resourceName: p.resourceName,
                displayName: p.names?.[0]?.displayName ?? null,
                emails: vals(p.emailAddresses, "value"),
                phones: vals(p.phoneNumbers, "value"),
                organizations: vals(p.organizations, "name"),
                addresses: vals(p.addresses, "formattedValue"),
                urls: vals(p.urls, "value"),
                biography: p.biographies?.[0]?.value ?? null,
                photoUrl: p.photos?.[0]?.url ?? null,
            },
        ],
        freshness: new Date().toISOString(),
        continuation: null,
    };
}

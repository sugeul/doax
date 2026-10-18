/**
  * @doax/task-get — data-source (spec §5).
  * One collection of one record: a single task, via Tasks API tasks.get. The `tasklist` comes from
  * @doax/tasklists-list and the `task` from @doax/tasks-list. Caller-relative (§5.3).
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
    if (status === 404) return Object.assign(new Error(`not-found: ${reason ?? "task list or task not found"}`), { faultClass: "not-found", googleError: reason, detail: { fix: "check the tasklist id (@doax/tasklists-list) and task id (@doax/tasks-list)" } });
    if (status >= 500) return Object.assign(new Error(`google-unavailable: HTTP ${status}`), { faultClass: "google-unavailable" });
    return Object.assign(new Error(`google-error: ${reason ?? status}`), { faultClass: "google-error", googleError: reason });
}

async function google(path, token) {
    let res;
    try {
        res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
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
        id: { type: "string" },
        title: { type: ["string", "null"] },
        status: { type: ["string", "null"] },
        due: { type: ["string", "null"] },
        completed: { type: ["string", "null"] },
        notes: { type: ["string", "null"] },
        parent: { type: ["string", "null"] },
        position: { type: ["string", "null"] },
        updated: { type: ["string", "null"] },
        webViewLink: { type: ["string", "null"] },
    },
    required: ["id"],
};

export function describe() {
    return {
        identity: "@doax/task-get",
        kind: "data-source",
        collection: "a single task",
        readParams: { tasklist: "the task list id (required)", task: "the task id (required)" },
    };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    if (!input?.tasklist) throw Object.assign(new Error("not-found: metadata requires a tasklist parameter"), { faultClass: "not-found" });
    await google(`/users/@me/lists/${encodeURIComponent(input.tasklist)}`, token).catch(() => ({}));
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed; a point lookup by task id",
            recordCount: { estimate: false, exact: 1, note: "one task, or a not-found fault" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
        },
    };
}

export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.tasklist || !input?.task) throw Object.assign(new Error("not-found: read requires tasklist and task parameters"), { faultClass: "not-found" });
    const t = await google(`/lists/${encodeURIComponent(input.tasklist)}/tasks/${encodeURIComponent(input.task)}`, token);
    return {
        data: [
            {
                id: t.id,
                title: t.title ?? null,
                status: t.status ?? null,
                due: t.due ?? null,
                completed: t.completed ?? null,
                notes: t.notes ?? null,
                parent: t.parent ?? null,
                position: t.position ?? null,
                updated: t.updated ?? null,
                webViewLink: t.webViewLink ?? null,
            },
        ],
        freshness: new Date().toISOString(),
        continuation: null,
    };
}

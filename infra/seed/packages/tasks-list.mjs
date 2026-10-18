/**
  * @doax/tasks-list — data-source (spec §5).
  * One collection: the tasks in one task list, via Tasks API tasks.list. The `tasklist` comes from
  * @doax/tasklists-list (its `id`); a task's `id` is the `task` parameter of @doax/task-get.
  * `updatedMin` gives an incremental read. Caller-relative (§5.3).
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
    if (status === 404) return Object.assign(new Error(`not-found: ${reason ?? "task list not found"}`), { faultClass: "not-found", googleError: reason, detail: { fix: "check the tasklist id (@doax/tasklists-list)" } });
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
        throw Object.assign(new Error("google-unavailable: network failure reaching Tasks"), { faultClass: "google-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw googleFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "task id — the `task` parameter of @doax/task-get" },
        title: { type: ["string", "null"] },
        status: { type: ["string", "null"], description: "needsAction | completed" },
        due: { type: ["string", "null"] },
        completed: { type: ["string", "null"] },
        notes: { type: ["string", "null"] },
        parent: { type: ["string", "null"], description: "parent task id (subtasks)" },
        position: { type: ["string", "null"] },
        updated: { type: ["string", "null"] },
    },
    required: ["id"],
};

export function describe() {
    return {
        identity: "@doax/tasks-list",
        kind: "data-source",
        collection: "the tasks in one task list",
        readParams: {
            tasklist: "the task list id (required)",
            showCompleted: "include completed tasks (default true)",
            showHidden: "include hidden tasks (default false)",
            updatedMin: "RFC3339 lower bound on last-modified time (incremental read)",
            maxResults: "max tasks per page (default 100)",
            cursor: "continuation (a Tasks pageToken)",
        },
    };
}

export async function metadata(input, context) {
    const token = context?.credential?.token;
    if (!input?.tasklist) throw Object.assign(new Error("not-found: metadata requires a tasklist parameter"), { faultClass: "not-found" });
    const list = await google(`/users/@me/lists/${encodeURIComponent(input.tasklist)}`, token).catch(() => ({}));
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "ordered by position; narrow recent changes with updatedMin",
            recordCount: { estimate: true, note: "bounded by the tasks in this list" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            listTitle: list.title ?? null,
        },
    };
}

export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.tasklist) throw Object.assign(new Error("not-found: read requires a tasklist parameter"), { faultClass: "not-found" });
    const body = await google(`/lists/${encodeURIComponent(input.tasklist)}/tasks`, token, {
        showCompleted: String(input?.showCompleted ?? true),
        showHidden: input?.showHidden ? "true" : undefined,
        updatedMin: input?.updatedMin,
        maxResults: String(input?.maxResults ?? 100),
        pageToken: input?.cursor,
    });
    return {
        data: (body.items ?? []).map((t) => ({
            id: t.id,
            title: t.title ?? null,
            status: t.status ?? null,
            due: t.due ?? null,
            completed: t.completed ?? null,
            notes: t.notes ?? null,
            parent: t.parent ?? null,
            position: t.position ?? null,
            updated: t.updated ?? null,
        })),
        freshness: new Date().toISOString(),
        continuation: body.nextPageToken || null,
    };
}

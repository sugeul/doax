/**
  * @doax/google-drive-changes — data-source (spec §5).
  * One collection: the change feed for the caller's Drive, via GET /drive/v3/changes — the
  * "delta list". With no cursor, read() bootstraps a baseline token (GET /changes/startPageToken)
  * and lists from it; thereafter the caller polls with the `cursor` returned as `nextDeltaToken`.
  * Caller-relative (§5.3): the feed reflects exactly what the drive.readonly token can see.
  *
  * Pagination vs. polling, both carried in the return:
  *   continuation   — a Drive nextPageToken: MORE pages of the current delta exist now.
  *   nextDeltaToken — a Drive newStartPageToken: this delta is drained; poll again later with it.
  */

const DRIVE = "https://www.googleapis.com/drive/v3";
const FILE_FIELDS = "id,name,mimeType,modifiedTime,trashed,parents,driveId";

function driveFault(status, body, retryAfter) {
    const err = body?.error;
    const reason = Array.isArray(err?.errors) ? err.errors[0]?.reason : null;
    const message = (typeof err === "string" ? err : err?.message) ?? "";
    if (status === 401) return Object.assign(new Error(`invalid-auth: ${reason ?? "token rejected"}`), { faultClass: "invalid-auth", driveError: reason });
    if (status === 403) {
        if (reason === "accessNotConfigured" || /accessNotConfigured|has not been used in project|is disabled/i.test(message)) {
            return Object.assign(new Error("access-denied: the Google Drive API is not enabled for this OAuth client's project"), {
                faultClass: "access-denied",
                driveError: reason,
                detail: { fix: "enable the Drive API at https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=doax-drive-adapter (one-time; wait ~1-2 min to propagate)" },
            });
        }
        if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return Object.assign(new Error("rate-limited: Google Drive throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
        if (reason === "insufficientPermissions" || /insufficient.*scope/i.test(message)) {
            return Object.assign(new Error("missing-scope: the token lacks the Drive scope this operation needs"), {
                faultClass: "missing-scope",
                detail: { neededScope: "https://www.googleapis.com/auth/drive.readonly", driveMessage: message || null, fix: "re-consent at https://auth.doax.io?appid=@doax/google-drive-login, then re-authenticate (doax auth set @doax/google-drive-login)" },
            });
        }
        return Object.assign(new Error(`access-denied: ${reason ?? "forbidden"}`), { faultClass: "access-denied", driveError: reason });
    }
    if (status === 429) return Object.assign(new Error("rate-limited: Google Drive throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
    if (status === 404) return Object.assign(new Error(`not-found: ${reason ?? "page token or drive not found"}`), { faultClass: "not-found", driveError: reason, detail: { fix: "the delta cursor may have expired; read with no cursor to get a fresh baseline token" } });
    if (status >= 500) return Object.assign(new Error(`drive-unavailable: HTTP ${status}`), { faultClass: "drive-unavailable" });
    return Object.assign(new Error(`drive-error: ${reason ?? status}`), { faultClass: "drive-error", driveError: reason });
}

/** Drive GET; drops undefined params so they are omitted from the query string. */
async function drive(path, token, params) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    const qs = query.toString();
    let res;
    try {
        res = await fetch(`${DRIVE}${path}${qs ? `?${qs}` : ""}`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw Object.assign(new Error("drive-unavailable: network failure reaching Google Drive"), { faultClass: "drive-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw driveFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        fileId: { type: ["string", "null"], description: "the changed file's id (null for drive-level changes)" },
        removed: { type: "boolean", description: "the file left the caller's view (deleted or unshared)" },
        time: { type: "string", description: "when the change was recorded" },
        changeType: { type: "string", description: "file | drive" },
        name: { type: ["string", "null"] },
        mimeType: { type: ["string", "null"] },
        modifiedTime: { type: ["string", "null"] },
        trashed: { type: ["boolean", "null"] },
        driveId: { type: ["string", "null"] },
    },
    required: ["removed", "time", "changeType"],
};

export function describe() {
    return {
        identity: "@doax/google-drive-changes",
        kind: "data-source",
        collection: "the change feed (delta) for the caller's Drive",
        readParams: {
            cursor: "a delta token to list from; omit for a fresh baseline (nextDeltaToken from a prior read, or a Drive startPageToken)",
            driveId: "restrict the feed to one shared drive id",
            includeRemoved: "include changes that removed items from view (default true)",
            includeItemsFromAllDrives: "include shared-drive changes (default true)",
            pageSize: "max changes per page, 1-1000 (default 100)",
            restrictToMyDrive: "ignore changes outside My Drive hierarchy (default false)",
        },
    };
}

/** Caller-relative metadata (spec §5.2a, §5.3). */
export async function metadata(input, context) {
    const token = context?.credential?.token;
    const [who, start] = await Promise.all([
        drive("/about", token, { fields: "user" }),
        drive("/changes/startPageToken", token, { supportsAllDrives: true, driveId: input?.driveId || undefined }),
    ]);
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "a delta since the supplied cursor; unbounded history is not available",
            recordCount: { estimate: true, note: "unknown until a delta is read; zero when nothing changed" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerEmail: who.user?.emailAddress ?? null,
            currentStartPageToken: start.startPageToken ?? null,
        },
    };
}

/** read -> { data, freshness, continuation, nextDeltaToken } (spec §5.7). */
export async function read(input, context) {
    const token = context?.credential?.token;
    const driveId = input?.driveId || undefined;
    // No cursor: establish a baseline token now, then list from it (an empty-ish first delta).
    let pageToken = input?.cursor;
    if (!pageToken) {
        const start = await drive("/changes/startPageToken", token, { supportsAllDrives: true, driveId });
        pageToken = start.startPageToken;
    }
    const body = await drive("/changes", token, {
        pageToken,
        pageSize: input?.pageSize ?? 100,
        includeRemoved: input?.includeRemoved ?? true,
        restrictToMyDrive: input?.restrictToMyDrive,
        driveId,
        includeItemsFromAllDrives: input?.includeItemsFromAllDrives ?? true,
        supportsAllDrives: true,
        fields: `nextPageToken, newStartPageToken, changes(removed,time,changeType,fileId,driveId,file(${FILE_FIELDS}))`,
    });
    return {
        data: (body.changes ?? []).map((c) => ({
            fileId: c.fileId ?? null,
            removed: Boolean(c.removed),
            time: c.time ?? "",
            changeType: c.changeType ?? "file",
            name: c.file?.name ?? null,
            mimeType: c.file?.mimeType ?? null,
            modifiedTime: c.file?.modifiedTime ?? null,
            trashed: c.file ? Boolean(c.file.trashed) : null,
            driveId: c.driveId ?? c.file?.driveId ?? null,
        })),
        freshness: new Date().toISOString(),
        continuation: body.nextPageToken || null,
        // Present on the final page: the token to poll the NEXT delta with (pass back as `cursor`).
        nextDeltaToken: body.newStartPageToken || null,
    };
}

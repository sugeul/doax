/**
  * @doax/google-drive-list — data-source (spec §5).
  * One collection: the Drive files visible to the caller's token, via GET /drive/v3/files.
  * Caller-relative (§5.3): you read exactly what the drive.readonly token may read. Its `id`
  * field is the `fileId` parameter of @doax/google-drive-get.
  */

const DRIVE = "https://www.googleapis.com/drive/v3";
const FILE_FIELDS = "id,name,mimeType,modifiedTime,createdTime,size,parents,trashed,webViewLink,owners(displayName,emailAddress),driveId";

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
    if (status === 404) return Object.assign(new Error(`not-found: ${reason ?? "resource not found"}`), { faultClass: "not-found", driveError: reason });
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
        id: { type: "string", description: "file id — the `fileId` parameter of @doax/google-drive-get" },
        name: { type: "string" },
        mimeType: { type: "string", description: "e.g. application/vnd.google-apps.folder for a folder" },
        modifiedTime: { type: ["string", "null"] },
        createdTime: { type: ["string", "null"] },
        size: { type: ["string", "null"], description: "bytes as a string; absent for folders and Google-native files" },
        parents: { type: "array", items: { type: "string" } },
        trashed: { type: "boolean" },
        webViewLink: { type: ["string", "null"] },
        owners: { type: "array" },
        driveId: { type: ["string", "null"], description: "the shared drive this file lives in, if any" },
    },
    required: ["id", "name", "mimeType"],
};

export function describe() {
    return {
        identity: "@doax/google-drive-list",
        kind: "data-source",
        collection: "Drive files visible to the caller",
        readParams: {
            q: "Drive query string, e.g. \"'<folderId>' in parents and trashed=false\" (see Drive files.list `q`)",
            pageSize: "max records per page, 1-1000 (default 100)",
            orderBy: "e.g. 'modifiedTime desc', 'name' (Drive files.list `orderBy`)",
            driveId: "restrict to one shared drive id (sets corpora=drive)",
            corpora: "user | drive | allDrives (default: drive when driveId is given, else user)",
            includeItemsFromAllDrives: "include shared-drive items (default true)",
            fields: "override the files() field selection",
            cursor: "continuation (a Drive nextPageToken)",
        },
    };
}

/** Caller-relative metadata (spec §5.2a, §5.3). */
export async function metadata(input, context) {
    const token = context?.credential?.token;
    const who = await drive("/about", token, { fields: "user,storageQuota" });
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed; ordered by the `orderBy` parameter",
            recordCount: { estimate: true, note: "bounded by the files this caller's token can see" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerEmail: who.user?.emailAddress ?? null,
        },
    };
}

/** read -> { data, freshness, continuation } (spec §5.7). */
export async function read(input, context) {
    const token = context?.credential?.token;
    const driveId = input?.driveId || undefined;
    const body = await drive("/files", token, {
        q: input?.q,
        pageSize: input?.pageSize ?? 100,
        orderBy: input?.orderBy,
        pageToken: input?.cursor,
        fields: `nextPageToken, files(${input?.fields ?? FILE_FIELDS})`,
        driveId,
        corpora: input?.corpora ?? (driveId ? "drive" : "user"),
        includeItemsFromAllDrives: input?.includeItemsFromAllDrives ?? true,
        supportsAllDrives: true,
    });
    return {
        data: (body.files ?? []).map((f) => ({
            id: f.id,
            name: f.name ?? "",
            mimeType: f.mimeType ?? "",
            modifiedTime: f.modifiedTime ?? null,
            createdTime: f.createdTime ?? null,
            size: f.size ?? null,
            parents: f.parents ?? [],
            trashed: Boolean(f.trashed),
            webViewLink: f.webViewLink ?? null,
            owners: f.owners ?? [],
            driveId: f.driveId ?? null,
        })),
        freshness: new Date().toISOString(),
        continuation: body.nextPageToken || null,
    };
}

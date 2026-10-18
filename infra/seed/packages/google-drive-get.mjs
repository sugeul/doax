/**
  * @doax/google-drive-get — data-source (spec §5).
  * One collection of one record: the metadata of a single Drive file, via GET /drive/v3/files/{fileId}.
  * The `fileId` comes from @doax/google-drive-list (its `id`) or @doax/google-drive-changes
  * (its `fileId`). Caller-relative (§5.3): resolves only if the token may see the file.
  */

const DRIVE = "https://www.googleapis.com/drive/v3";
const FILE_FIELDS = "id,name,mimeType,description,modifiedTime,createdTime,size,parents,trashed,starred,shared,webViewLink,webContentLink,iconLink,md5Checksum,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),driveId";
// media:true returns the bytes as base64 in the record. Caps payload size (base64-in-JSON is
// fine for documents and small files, not for large binaries). Google's export is also <=10MB.
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
// Default export target per Google-native type (overridable with exportMimeType). null = not downloadable.
const EXPORT_DEFAULTS = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "application/pdf",
    "application/vnd.google-apps.drawing": "image/png",
};

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
    if (status === 404) return Object.assign(new Error(`not-found: ${reason ?? "file id not found or not visible to this caller"}`), { faultClass: "not-found", driveError: reason, detail: { fix: "check the fileId (@doax/google-drive-list) and that the token may see it" } });
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

/** Drive GET returning raw bytes (alt=media download, or /export); errors carry a JSON body. */
async function driveMedia(path, token, params) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    let res;
    try {
        res = await fetch(`${DRIVE}${path}?${query}`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw Object.assign(new Error("drive-unavailable: network failure reaching Google Drive"), { faultClass: "drive-unavailable" });
    }
    if (!res.ok) throw driveFault(res.status, await res.json().catch(() => ({})), res.headers.get("retry-after"));
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_CONTENT_BYTES) {
        throw Object.assign(new Error(`content-too-large: ${buffer.length} bytes exceeds the ${MAX_CONTENT_BYTES}-byte cap`), {
            faultClass: "content-too-large",
            detail: { fix: "omit media to read metadata only, or fetch the file via webContentLink outside this adapter" },
        });
    }
    return { buffer, contentType: res.headers.get("content-type") };
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string" },
        name: { type: "string" },
        mimeType: { type: "string" },
        description: { type: ["string", "null"] },
        modifiedTime: { type: ["string", "null"] },
        createdTime: { type: ["string", "null"] },
        size: { type: ["string", "null"], description: "bytes as a string; absent for folders and Google-native files" },
        parents: { type: "array", items: { type: "string" } },
        trashed: { type: "boolean" },
        starred: { type: ["boolean", "null"] },
        shared: { type: ["boolean", "null"] },
        webViewLink: { type: ["string", "null"] },
        webContentLink: { type: ["string", "null"], description: "direct download link (binary files only)" },
        md5Checksum: { type: ["string", "null"] },
        owners: { type: "array" },
        lastModifyingUser: { type: ["object", "null"] },
        driveId: { type: ["string", "null"] },
        content: { type: ["string", "null"], description: "base64 file bytes when media:true was requested, else null" },
        contentEncoding: { type: ["string", "null"], description: "base64 when content is present" },
        contentMimeType: { type: ["string", "null"], description: "the mime type of the returned content (the export type for Google-native files)" },
        contentBytes: { type: ["integer", "null"], description: "decoded byte length of content" },
    },
    required: ["id", "name", "mimeType"],
};

export function describe() {
    return {
        identity: "@doax/google-drive-get",
        kind: "data-source",
        collection: "the metadata of a single Drive file",
        readParams: {
            fileId: "the Drive file id (required)",
            fields: "override the field selection (a Drive files.get `fields` list)",
            media: "when true, also return the file bytes as base64 in `content` (<=10MB)",
            exportMimeType: "for Google-native files (Docs/Sheets/Slides), the export target mime type; defaults by type",
        },
    };
}

/** Caller-relative metadata (spec §5.2a, §5.3). */
export async function metadata(input, context) {
    const token = context?.credential?.token;
    const who = await drive("/about", token, { fields: "user" });
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed; a point lookup by fileId",
            recordCount: { estimate: false, exact: 1, note: "one file, or a not-found fault" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerEmail: who.user?.emailAddress ?? null,
        },
    };
}

/** read -> { data, freshness, continuation } (spec §5.7). A single-record collection. */
export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.fileId) throw Object.assign(new Error("not-found: read requires a fileId parameter"), { faultClass: "not-found" });
    const id = encodeURIComponent(input.fileId);
    const f = await drive(`/files/${id}`, token, {
        fields: input?.fields ?? FILE_FIELDS,
        supportsAllDrives: true,
    });

    // media:true -> also fetch the bytes. Google-native files have no bytes; they must be exported.
    let content = null;
    let contentEncoding = null;
    let contentMimeType = null;
    let contentBytes = null;
    if (input?.media) {
        const isNative = (f.mimeType ?? "").startsWith("application/vnd.google-apps.");
        let got;
        if (isNative) {
            const exportMime = input?.exportMimeType || EXPORT_DEFAULTS[f.mimeType];
            if (!exportMime) {
                throw Object.assign(new Error(`drive-error: ${f.mimeType} cannot be downloaded as-is`), {
                    faultClass: "drive-error",
                    detail: { fix: "pass exportMimeType for this Google-native file, or drop media (folders and unknown native types are not exportable)" },
                });
            }
            got = await driveMedia(`/files/${id}/export`, token, { mimeType: exportMime, supportsAllDrives: true });
            contentMimeType = exportMime;
        } else {
            if (f.size && Number(f.size) > MAX_CONTENT_BYTES) {
                throw Object.assign(new Error(`content-too-large: ${f.size} bytes exceeds the ${MAX_CONTENT_BYTES}-byte cap`), {
                    faultClass: "content-too-large",
                    detail: { fix: "omit media to read metadata only, or fetch the file via webContentLink outside this adapter" },
                });
            }
            got = await driveMedia(`/files/${id}`, token, { alt: "media", supportsAllDrives: true });
            contentMimeType = got.contentType ?? f.mimeType ?? null;
        }
        content = got.buffer.toString("base64");
        contentEncoding = "base64";
        contentBytes = got.buffer.length;
    }

    return {
        data: [
            {
                id: f.id,
                name: f.name ?? "",
                mimeType: f.mimeType ?? "",
                description: f.description ?? null,
                modifiedTime: f.modifiedTime ?? null,
                createdTime: f.createdTime ?? null,
                size: f.size ?? null,
                parents: f.parents ?? [],
                trashed: Boolean(f.trashed),
                starred: f.starred ?? null,
                shared: f.shared ?? null,
                webViewLink: f.webViewLink ?? null,
                webContentLink: f.webContentLink ?? null,
                md5Checksum: f.md5Checksum ?? null,
                owners: f.owners ?? [],
                lastModifyingUser: f.lastModifyingUser ?? null,
                driveId: f.driveId ?? null,
                content,
                contentEncoding,
                contentMimeType,
                contentBytes,
            },
        ],
        freshness: new Date().toISOString(),
        continuation: null,
    };
}

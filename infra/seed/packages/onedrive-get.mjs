/**
  * @doax/onedrive-get — data-source (spec §5).
  * One collection of one record: a single OneDrive item, via GET /me/drive/items/{itemId}.
  * With media:true it also returns the file bytes (base64), via /items/{itemId}/content.
  * The `itemId` comes from @doax/onedrive-list (its `id`) or @doax/onedrive-changes (its `id`).
  * Caller-relative (§5.3): resolves only if the Files.Read token may see the item.
  */

const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "id,name,size,file,folder,description,webUrl,createdDateTime,lastModifiedDateTime,parentReference,createdBy,lastModifiedBy";
// media:true returns the bytes as base64 in the record. Caps payload size (base64-in-JSON is
// fine for documents and small files, not for large binaries).
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

function graphFault(status, body, retryAfter) {
    const code = body?.error?.code ?? null;
    const message = body?.error?.message ?? "";
    if (status === 401) return Object.assign(new Error(`invalid-auth: ${code ?? "token rejected"}`), { faultClass: "invalid-auth", graphError: code });
    if (status === 403) {
        if (code === "Authorization_RequestDenied" || /scope|permission|consent/i.test(message)) {
            return Object.assign(new Error("missing-scope: the signed-in app lacks a required Microsoft Graph permission"), {
                faultClass: "missing-scope",
                detail: { neededScope: "Files.Read", graphMessage: message || null, fix: "re-consent at https://auth.doax.io?appid=@doax/onedrive-login, then re-authenticate (doax auth set @doax/onedrive-login)" },
            });
        }
        return Object.assign(new Error(`access-denied: ${code ?? "forbidden"}`), { faultClass: "access-denied", graphError: code });
    }
    if (status === 429) return Object.assign(new Error("rate-limited: Microsoft Graph throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
    if (status === 404) return Object.assign(new Error(`not-found: ${code ?? "item not found or not visible to this caller"}`), { faultClass: "not-found", graphError: code, detail: { fix: "check the itemId (@doax/onedrive-list) and that the token may see it" } });
    if (status >= 500) return Object.assign(new Error(`graph-unavailable: HTTP ${status}`), { faultClass: "graph-unavailable" });
    return Object.assign(new Error(`graph-error: ${code ?? status}`), { faultClass: "graph-error", graphError: code });
}

/** Graph GET returning JSON. */
async function graph(path, token, params) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    const qs = query.toString();
    let res;
    try {
        res = await fetch(`${GRAPH}${path}${qs ? `?${qs}` : ""}`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw Object.assign(new Error("graph-unavailable: network failure reaching Microsoft Graph"), { faultClass: "graph-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw graphFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

/** Download an item's bytes. /content 302-redirects to a pre-authed URL; fetch it without the bearer. */
async function graphContent(path, token) {
    let res;
    try {
        res = await fetch(`${GRAPH}${path}`, { headers: { authorization: `Bearer ${token}` }, redirect: "manual" });
    } catch {
        throw Object.assign(new Error("graph-unavailable: network failure reaching Microsoft Graph"), { faultClass: "graph-unavailable" });
    }
    if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw Object.assign(new Error("graph-error: content redirect had no location"), { faultClass: "graph-error" });
        try {
            res = await fetch(location); // pre-authed storage URL — no Authorization header
        } catch {
            throw Object.assign(new Error("graph-unavailable: network failure fetching the content url"), { faultClass: "graph-unavailable" });
        }
    }
    if (!res.ok) throw graphFault(res.status, await res.json().catch(() => ({})), res.headers.get("retry-after"));
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_CONTENT_BYTES) {
        throw Object.assign(new Error(`content-too-large: ${buffer.length} bytes exceeds the ${MAX_CONTENT_BYTES}-byte cap`), {
            faultClass: "content-too-large",
            detail: { fix: "omit media to read metadata only, or fetch the file via webUrl outside this adapter" },
        });
    }
    return { buffer, contentType: res.headers.get("content-type") };
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string" },
        name: { type: "string" },
        isFolder: { type: "boolean" },
        mimeType: { type: ["string", "null"] },
        size: { type: ["integer", "null"] },
        description: { type: ["string", "null"] },
        webUrl: { type: ["string", "null"] },
        createdDateTime: { type: ["string", "null"] },
        lastModifiedDateTime: { type: ["string", "null"] },
        parentPath: { type: ["string", "null"] },
        driveId: { type: ["string", "null"] },
        lastModifiedBy: { type: ["object", "null"] },
        content: { type: ["string", "null"], description: "base64 file bytes when media:true was requested, else null" },
        contentEncoding: { type: ["string", "null"], description: "base64 when content is present" },
        contentMimeType: { type: ["string", "null"] },
        contentBytes: { type: ["integer", "null"], description: "decoded byte length of content" },
    },
    required: ["id", "name", "isFolder"],
};

export function describe() {
    return {
        identity: "@doax/onedrive-get",
        kind: "data-source",
        collection: "a single OneDrive item",
        readParams: {
            itemId: "the OneDrive item id (required)",
            driveId: "a specific drive id; omit for the caller's own OneDrive (/me/drive)",
            media: "when true, also return the file bytes as base64 in `content` (<=10MB; not valid for folders)",
        },
    };
}

/** Caller-relative metadata (spec §5.2a, §5.3). */
export async function metadata(input, context) {
    const token = context?.credential?.token;
    const who = await graph("/me", token, { $select: "displayName,userPrincipalName,mail" });
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed; a point lookup by itemId",
            recordCount: { estimate: false, exact: 1, note: "one item, or a not-found fault" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerUpn: who.userPrincipalName ?? who.mail ?? null,
        },
    };
}

/** read -> { data, freshness, continuation } (spec §5.7). A single-record collection. */
export async function read(input, context) {
    const token = context?.credential?.token;
    if (!input?.itemId) throw Object.assign(new Error("not-found: read requires an itemId parameter"), { faultClass: "not-found" });
    const drive = input?.driveId ? `/drives/${encodeURIComponent(input.driveId)}` : "/me/drive";
    const base = `${drive}/items/${encodeURIComponent(input.itemId)}`;
    const i = await graph(base, token, { $select: SELECT });

    let content = null;
    let contentEncoding = null;
    let contentMimeType = null;
    let contentBytes = null;
    if (input?.media) {
        if (i.folder) {
            throw Object.assign(new Error("access-denied: a folder has no downloadable content"), {
                faultClass: "access-denied",
                detail: { fix: "list a folder's children with @doax/onedrive-list; media is for files only" },
            });
        }
        if (i.size && Number(i.size) > MAX_CONTENT_BYTES) {
            throw Object.assign(new Error(`content-too-large: ${i.size} bytes exceeds the ${MAX_CONTENT_BYTES}-byte cap`), {
                faultClass: "content-too-large",
                detail: { fix: "omit media to read metadata only, or fetch the file via webUrl outside this adapter" },
            });
        }
        const got = await graphContent(`${base}/content`, token);
        content = got.buffer.toString("base64");
        contentEncoding = "base64";
        contentMimeType = got.contentType ?? i.file?.mimeType ?? null;
        contentBytes = got.buffer.length;
    }

    return {
        data: [
            {
                id: i.id,
                name: i.name ?? "",
                isFolder: Boolean(i.folder),
                mimeType: i.file?.mimeType ?? null,
                size: i.size ?? null,
                description: i.description ?? null,
                webUrl: i.webUrl ?? null,
                createdDateTime: i.createdDateTime ?? null,
                lastModifiedDateTime: i.lastModifiedDateTime ?? null,
                parentPath: i.parentReference?.path ?? null,
                driveId: i.parentReference?.driveId ?? null,
                lastModifiedBy: i.lastModifiedBy ?? null,
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

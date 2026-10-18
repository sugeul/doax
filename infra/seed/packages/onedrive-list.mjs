/**
  * @doax/onedrive-list — data-source (spec §5).
  * One collection: the items (files and folders) in one OneDrive folder, via
  * GET /me/drive/root/children (or /items/{id}/children). Caller-relative (§5.3): you read
  * exactly what the Files.Read token may read. An item's `id` is the `itemId` parameter of
  * @doax/onedrive-get, and a folder's `id` is the `itemId` parameter of this resource.
  */

const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "id,name,size,file,folder,webUrl,createdDateTime,lastModifiedDateTime,parentReference";

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
    if (status === 404) return Object.assign(new Error(`not-found: ${code ?? "drive, folder, or item not found"}`), { faultClass: "not-found", graphError: code, detail: { fix: "check the itemId/driveId (@doax/onedrive-list of the parent folder)" } });
    if (status >= 500) return Object.assign(new Error(`graph-unavailable: HTTP ${status}`), { faultClass: "graph-unavailable" });
    return Object.assign(new Error(`graph-error: ${code ?? status}`), { faultClass: "graph-error", graphError: code });
}

/** Graph GET; `pathOrUrl` may be a continuation (@odata.nextLink) absolute url. */
async function graph(pathOrUrl, token, params) {
    const base = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    const qs = query.toString();
    let res;
    try {
        res = await fetch(`${base}${qs ? (base.includes("?") ? "&" : "?") + qs : ""}`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw Object.assign(new Error("graph-unavailable: network failure reaching Microsoft Graph"), { faultClass: "graph-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw graphFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

/** The drive root or a specific drive; a folder itemId scopes to that folder's children. */
function childrenPath(input) {
    const drive = input?.driveId ? `/drives/${encodeURIComponent(input.driveId)}` : "/me/drive";
    return input?.itemId ? `${drive}/items/${encodeURIComponent(input.itemId)}/children` : `${drive}/root/children`;
}

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "item id — the `itemId` parameter of @doax/onedrive-get (or this resource, for a folder)" },
        name: { type: "string" },
        isFolder: { type: "boolean" },
        mimeType: { type: ["string", "null"], description: "the file's mime type; null for folders" },
        size: { type: ["integer", "null"] },
        webUrl: { type: ["string", "null"] },
        createdDateTime: { type: ["string", "null"] },
        lastModifiedDateTime: { type: ["string", "null"] },
        parentPath: { type: ["string", "null"], description: "parentReference.path, e.g. /drive/root:/Documents" },
        driveId: { type: ["string", "null"] },
    },
    required: ["id", "name", "isFolder"],
};

export function describe() {
    return {
        identity: "@doax/onedrive-list",
        kind: "data-source",
        collection: "items in one OneDrive folder, visible to the caller",
        readParams: {
            itemId: "folder item id to list; omit for the drive root",
            driveId: "a specific drive id; omit for the caller's own OneDrive (/me/drive)",
            top: "max items per page (default 100; Graph $top)",
            orderBy: "e.g. 'name', 'lastModifiedDateTime desc' (Graph $orderby)",
            cursor: "continuation (an @odata.nextLink url)",
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
            timeRange: "not time-indexed; ordered by the `orderBy` parameter",
            recordCount: { estimate: true, note: "bounded by the items in this folder visible to the caller" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerUpn: who.userPrincipalName ?? who.mail ?? null,
        },
    };
}

/** read -> { data, freshness, continuation } (spec §5.7). */
export async function read(input, context) {
    const token = context?.credential?.token;
    const body = input?.cursor
        ? await graph(String(input.cursor), token)
        : await graph(childrenPath(input), token, { $select: SELECT, $top: String(input?.top ?? 100), $orderby: input?.orderBy });
    return {
        data: (body.value ?? []).map((i) => ({
            id: i.id,
            name: i.name ?? "",
            isFolder: Boolean(i.folder),
            mimeType: i.file?.mimeType ?? null,
            size: i.size ?? null,
            webUrl: i.webUrl ?? null,
            createdDateTime: i.createdDateTime ?? null,
            lastModifiedDateTime: i.lastModifiedDateTime ?? null,
            parentPath: i.parentReference?.path ?? null,
            driveId: i.parentReference?.driveId ?? null,
        })),
        freshness: new Date().toISOString(),
        continuation: body["@odata.nextLink"] || null,
    };
}

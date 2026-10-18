/**
  * @doax/onedrive-changes — data-source (spec §5).
  * One collection: the change feed (delta) for the caller's OneDrive, via GET /me/drive/root/delta
  * — the "delta list". With no cursor, read() establishes a baseline (delta?token=latest) and
  * returns the deltaLink to poll from; thereafter the caller polls with the `cursor` it returned
  * as `nextDeltaToken`. Caller-relative (§5.3): the feed reflects what the Files.Read token sees.
  *
  * Pagination vs. polling, both carried in the return:
  *   continuation   — an @odata.nextLink: MORE pages of the current delta exist now.
  *   nextDeltaToken — an @odata.deltaLink: this delta is drained; poll again later with it.
  */

const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "id,name,size,file,folder,deleted,webUrl,lastModifiedDateTime,parentReference";

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
    if (status === 404) return Object.assign(new Error(`not-found: ${code ?? "drive or delta token not found"}`), { faultClass: "not-found", graphError: code, detail: { fix: "the delta token may have expired; read with no cursor to get a fresh baseline" } });
    if (status === 410) return Object.assign(new Error("not-found: the delta token is no longer valid (resync required)"), { faultClass: "not-found", graphError: code, detail: { fix: "read with no cursor to resync from a fresh baseline" } });
    if (status >= 500) return Object.assign(new Error(`graph-unavailable: HTTP ${status}`), { faultClass: "graph-unavailable" });
    return Object.assign(new Error(`graph-error: ${code ?? status}`), { faultClass: "graph-error", graphError: code });
}

/** Graph GET; `pathOrUrl` may be a continuation (@odata.nextLink/deltaLink) absolute url. */
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

const deltaRoot = (input) => (input?.driveId ? `/drives/${encodeURIComponent(input.driveId)}/root/delta` : "/me/drive/root/delta");

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "the changed item's id" },
        name: { type: ["string", "null"] },
        removed: { type: "boolean", description: "the item left the caller's view (deleted or unshared)" },
        isFolder: { type: "boolean" },
        mimeType: { type: ["string", "null"] },
        size: { type: ["integer", "null"] },
        lastModifiedDateTime: { type: ["string", "null"] },
        parentPath: { type: ["string", "null"] },
        driveId: { type: ["string", "null"] },
    },
    required: ["id", "removed", "isFolder"],
};

export function describe() {
    return {
        identity: "@doax/onedrive-changes",
        kind: "data-source",
        collection: "the change feed (delta) for the caller's OneDrive",
        readParams: {
            cursor: "a delta token url to list from; omit for a fresh baseline (nextDeltaToken from a prior read, or an @odata.deltaLink)",
            driveId: "a specific drive id; omit for the caller's own OneDrive (/me/drive)",
            top: "max changes per page (Graph $top)",
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
            timeRange: "a delta since the supplied cursor; a baseline read establishes 'now'",
            recordCount: { estimate: true, note: "unknown until a delta is read; zero when nothing changed" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "realtime",
            callerUpn: who.userPrincipalName ?? who.mail ?? null,
        },
    };
}

/** read -> { data, freshness, continuation, nextDeltaToken } (spec §5.7). */
export async function read(input, context) {
    const token = context?.credential?.token;
    // No cursor: establish a baseline 'now' token (token=latest returns no items + a deltaLink).
    const body = input?.cursor
        ? await graph(String(input.cursor), token)
        : await graph(deltaRoot(input), token, { token: "latest", $select: SELECT, $top: input?.top });
    return {
        data: (body.value ?? []).map((i) => ({
            id: i.id,
            name: i.name ?? null,
            removed: Boolean(i.deleted),
            isFolder: Boolean(i.folder),
            mimeType: i.file?.mimeType ?? null,
            size: i.size ?? null,
            lastModifiedDateTime: i.lastModifiedDateTime ?? null,
            parentPath: i.parentReference?.path ?? null,
            driveId: i.parentReference?.driveId ?? null,
        })),
        freshness: new Date().toISOString(),
        continuation: body["@odata.nextLink"] || null,
        // Present on the final page: the token to poll the NEXT delta with (pass back as `cursor`).
        nextDeltaToken: body["@odata.deltaLink"] || null,
    };
}

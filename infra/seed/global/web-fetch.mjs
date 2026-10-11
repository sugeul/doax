/**
  * @global/web-fetch — data-source (spec §5), tier 4 (unauthenticated, still audited).
  * One collection: public web documents, one record per fetched URL.
  */

const RECORD_SCHEMA = {
    type: "object",
    properties: {
        url: { type: "string" },
        status: { type: "number" },
        contentType: { type: ["string", "null"] },
        bytes: { type: "number" },
        bodyPreview: { type: "string", description: "first 2000 characters of the body" },
    },
    required: ["url", "status", "bytes"],
};

export function describe() {
    return {
        identity: "@global/web-fetch",
        kind: "data-source",
        collection: "public web documents, one record per fetched URL",
        readParams: { url: "http(s) URL to fetch (required)", maxBytes: "body preview cap, default 2000 chars" },
    };
}

export async function metadata() {
    return {
        schema: RECORD_SCHEMA,
        metadata: {
            timeRange: "not time-indexed",
            recordCount: { estimate: true, note: "one record per requested URL" },
            lastRefreshed: new Date().toISOString(),
            refreshCadence: "on demand",
        },
    };
}

export async function read(input) {
    const url = String(input?.url ?? "");
    if (!/^https?:\/\//.test(url)) {
        throw Object.assign(new Error("bad-url: read requires an http(s) url parameter"), { faultClass: "bad-url" });
    }
    const cap = Math.min(Number(input?.maxBytes ?? 2000) || 2000, 20000);
    let res;
    try {
        res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    } catch (error) {
        throw Object.assign(new Error(`target-unreachable: ${error.message}`), { faultClass: "target-unreachable" });
    }
    const body = await res.text();
    return {
        data: [
            {
                url,
                status: res.status,
                contentType: res.headers.get("content-type"),
                bytes: body.length,
                bodyPreview: body.slice(0, cap),
            },
        ],
        freshness: new Date().toISOString(),
        continuation: null,
    };
}

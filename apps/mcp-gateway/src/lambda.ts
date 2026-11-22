import { bearer, handleRpc, type JsonRpcMessage, parseCookies, rpcError, setCookieHeader } from "./gateway.ts";

/**
 * API Gateway HTTP API (payload v2.0) handler for mcp.doax.io. The gateway is a stateless proxy to the
 * registry, so unlike the registry Lambda it needs no VPC. One POST carries one JSON-RPC message; incoming
 * cookies carry the caller's minted tokens, and the response's `cookies` carry back any mints (Set-Cookie).
 */

interface ApiEvent {
    requestContext?: { http?: { method?: string } };
    headers?: Record<string, string | undefined>;
    cookies?: string[];
    body?: string;
    isBase64Encoded?: boolean;
}

export async function handler(event: ApiEvent) {
    const method = event.requestContext?.http?.method;
    if (method === "GET") return { statusCode: 200, headers: { "content-type": "text/plain" }, body: "ok" };
    if (method !== "POST") return { statusCode: 405, body: "" };

    const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : (event.body ?? "");
    let msg: JsonRpcMessage;
    try {
        msg = JSON.parse(raw) as JsonRpcMessage;
    } catch {
        return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify(rpcError(null, -32700, "parse error")) };
    }

    const token = bearer(event.headers?.authorization ?? event.headers?.Authorization);
    const cookies = parseCookies((event.cookies ?? []).join("; "));
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
        const { result, setCookies } = await handleRpc({ token, cookies }, msg);
        const out = setCookies.map(setCookieHeader);
        if (!isRequest) return { statusCode: 202, cookies: out, body: "" };
        return { statusCode: 200, headers: { "content-type": "application/json" }, cookies: out, body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) };
    } catch (err) {
        const e = err as { code?: number; message?: string };
        if (!isRequest) return { statusCode: 202, body: "" };
        return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(rpcError(msg.id, e.code ?? -32603, e.message ?? String(err))) };
    }
}

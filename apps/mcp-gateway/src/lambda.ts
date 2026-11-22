import { bearer, handleRpc, type JsonRpcMessage, rpcError } from "./gateway.ts";

/**
 * API Gateway HTTP API (payload v2.0) handler for mcp.doax.io. The gateway is a stateless proxy to the
 * registry, so unlike the registry Lambda it needs no VPC: it reaches registry.doax.io over the internet
 * and forwards the caller's bearer. One POST carries one JSON-RPC message; the response carries one back.
 */

interface ApiEvent {
    requestContext?: { http?: { method?: string } };
    headers?: Record<string, string | undefined>;
    body?: string;
    isBase64Encoded?: boolean;
}

const JSON_RESPONSE = { statusCode: 200, headers: { "content-type": "application/json" } };
const json = (statusCode: number, value: unknown) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

export async function handler(event: ApiEvent) {
    const method = event.requestContext?.http?.method;
    if (method === "GET") return { statusCode: 200, headers: { "content-type": "text/plain" }, body: "ok" };
    if (method !== "POST") return { statusCode: 405, body: "" };

    const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : (event.body ?? "");
    let msg: JsonRpcMessage;
    try {
        msg = JSON.parse(raw) as JsonRpcMessage;
    } catch {
        return json(400, rpcError(null, -32700, "parse error"));
    }

    const token = bearer(event.headers?.authorization ?? event.headers?.Authorization);
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
        const result = await handleRpc(token, msg);
        if (!isRequest) return { statusCode: 202, body: "" };
        return { ...JSON_RESPONSE, body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) };
    } catch (err) {
        const e = err as { code?: number; message?: string };
        if (!isRequest) return { statusCode: 202, body: "" };
        return json(200, rpcError(msg.id, e.code ?? -32603, e.message ?? String(err)));
    }
}

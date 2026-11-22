import { bearer, challenge, gatewayOrigin, handleRpc, type JsonRpcMessage, parseCookies, PROTECTED_RESOURCE_PATH, protectedResource, REQUIRE_LOGIN, rpcError, setCookieHeader } from "./gateway.ts";

interface ApiEvent {
    requestContext?: { http?: { method?: string } };
    rawPath?: string;
    headers?: Record<string, string | undefined>;
    cookies?: string[];
    body?: string;
    isBase64Encoded?: boolean;
}

const JSON_CT = { "content-type": "application/json" };

export async function handler(event: ApiEvent) {
    const method = event.requestContext?.http?.method;
    const host = event.headers?.host;

    if (method === "GET") {
        if (event.rawPath === PROTECTED_RESOURCE_PATH) return { statusCode: 200, headers: JSON_CT, body: JSON.stringify(protectedResource(gatewayOrigin(host))) };
        return { statusCode: 200, headers: { "content-type": "text/plain" }, body: "ok" };
    }
    if (method !== "POST") return { statusCode: 405, body: "" };

    const token = bearer(event.headers?.authorization ?? event.headers?.Authorization);
    if (!token && REQUIRE_LOGIN) return { statusCode: 401, headers: { "www-authenticate": challenge(gatewayOrigin(host)) }, body: "" };

    const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : (event.body ?? "");
    let msg: JsonRpcMessage;
    try {
        msg = JSON.parse(raw) as JsonRpcMessage;
    } catch {
        return { statusCode: 400, headers: JSON_CT, body: JSON.stringify(rpcError(null, -32700, "parse error")) };
    }

    const cookies = parseCookies((event.cookies ?? []).join("; "));
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
        const { result, setCookies } = await handleRpc({ token, cookies }, msg);
        const out = setCookies.map(setCookieHeader);
        if (!isRequest) return { statusCode: 202, cookies: out, body: "" };
        return { statusCode: 200, headers: JSON_CT, cookies: out, body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) };
    } catch (err) {
        const e = err as { code?: number; message?: string };
        if (!isRequest) return { statusCode: 202, body: "" };
        return { statusCode: 200, headers: JSON_CT, body: JSON.stringify(rpcError(msg.id, e.code ?? -32603, e.message ?? String(err))) };
    }
}

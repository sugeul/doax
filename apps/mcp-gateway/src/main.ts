#!/usr/bin/env node
import { createServer } from "node:http";
import { bearer, handleRpc, type JsonRpcMessage, REGISTRY, rpcError } from "./gateway.ts";

/** Local/stdio-less HTTP transport for the gateway (on-prem, or `dev`). The Lambda handler is lambda.ts. */

const PORT = Number(process.env.PORT ?? 8080);
const JSON_CT = { "content-type": "application/json" } as const;

const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200).end("ok");
        return;
    }
    if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
    }
    let body = "";
    req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", async () => {
        let msg: JsonRpcMessage;
        try {
            msg = JSON.parse(body) as JsonRpcMessage;
        } catch {
            res.writeHead(400, JSON_CT).end(JSON.stringify(rpcError(null, -32700, "parse error")));
            return;
        }
        const isRequest = msg.id !== undefined && msg.id !== null;
        try {
            const result = await handleRpc(bearer(req.headers.authorization), msg);
            if (!isRequest) {
                res.writeHead(202).end();
                return;
            }
            res.writeHead(200, JSON_CT).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        } catch (err) {
            const e = err as { code?: number; message?: string };
            if (!isRequest) {
                res.writeHead(202).end();
                return;
            }
            res.writeHead(200, JSON_CT).end(JSON.stringify(rpcError(msg.id, e.code ?? -32603, e.message ?? String(err))));
        }
    });
});

server.listen(PORT, () => process.stderr.write(`doax mcp-gateway on :${PORT} -> ${REGISTRY}\n`));

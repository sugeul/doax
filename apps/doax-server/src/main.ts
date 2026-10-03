#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { readServerConfig } from "@doax/config";
import { createServer } from "./server.ts";

const config = await readServerConfig();
const server = createServer(config);

const listener = serve({ fetch: server.app.fetch, port: config.port }, (info) => {
    console.log(`doax server listening on :${info.port} as ${config.domain} (storage: ${config.storage.kind}, data: ${config.dataDir})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        listener.close();
        server.close();
        process.exit(0);
    });
}

import { join } from "node:path";
import { serve } from "@hono/node-server";
import { readServerConfig } from "@doax/config";
import { createRegistryApp } from "./app.ts";

const config = await readServerConfig();
const { app } = createRegistryApp({
    domain: config.domain,
    operator: config.operator,
    databasePath: join(config.dataDir, "registry.sqlite"),
    upstream: config.upstream,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Registry Server listening on :${info.port}`);
});

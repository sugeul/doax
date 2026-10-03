import { join } from "node:path";
import { serve } from "@hono/node-server";
import { readServerConfig } from "@doax/config";
import { createCodeRepositoryApp } from "./app.ts";

const config = await readServerConfig();
const app = createCodeRepositoryApp({
    domain: config.domain,
    operator: config.operator,
    packagesDir: join(config.dataDir, "packages"),
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Code Repository listening on :${info.port}`);
});

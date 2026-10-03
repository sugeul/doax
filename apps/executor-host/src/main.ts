import { serve } from "@hono/node-server";
import { readServerConfig } from "@doax/config";
import { createApp } from "./app.ts";

const config = await readServerConfig({ ...process.env, PORT: process.env.PORT ?? "8083" });
const app = createApp({ domain: config.domain, operator: config.operator });

serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Executor Resource listening on :${info.port}`);
});

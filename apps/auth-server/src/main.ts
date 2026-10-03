import { serve } from "@hono/node-server";
import { readServerConfig } from "@doax/config";
import { createAuthApp } from "./app.ts";

const config = await readServerConfig();
const app = createAuthApp({
    domain: config.domain,
    operator: config.operator,
    oidcIssuer: config.auth.oidcIssuer,
    clientId: config.auth.clientId,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Auth Server listening on :${info.port}`);
});

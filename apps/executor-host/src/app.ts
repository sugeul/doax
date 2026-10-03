import { Hono } from "hono";
import { buildManifesto, withManifesto } from "@doax/protocol";

export const COMPONENT = "Executor Resource";

export interface AppConfig {
    domain: string;
    operator: string;
}

export function createApp(config: AppConfig): Hono {
    const app = new Hono();
    const manifesto = buildManifesto(
        `${COMPONENT} — organization-operated machine that runs dispatched trusted-executor work`,
        config.operator,
    );

    app.get("/manifesto.json", (c) => c.json(manifesto));
    app.get("/", (c) => c.json(withManifesto(config.domain, { component: COMPONENT, status: "ok" })));
    app.notFound((c) => c.json(withManifesto(config.domain, { error: "not-found" }), 404));

    return app;
}

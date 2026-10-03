import { Hono } from "hono";
import { buildManifesto, withManifesto } from "@doax/protocol";
import { PackageStore } from "./store.ts";

export const COMPONENT = "Code Repository";

export interface CodeRepositoryAppConfig {
    domain: string;
    operator: string;
    /** Directory where package contents are stored. */
    packagesDir: string;
}

export function createCodeRepositoryApp(config: CodeRepositoryAppConfig): Hono {
    new PackageStore(config.packagesDir);
    const app = new Hono();
    const manifesto = buildManifesto(`${COMPONENT} — immutable package storage by @namespace/name@version`, config.operator);

    app.get("/manifesto.json", (c) => c.json(manifesto));
    app.get("/", (c) => c.json(withManifesto(config.domain, { component: COMPONENT, status: "ok", storage: "filesystem" })));
    app.notFound((c) => c.json(withManifesto(config.domain, { error: "not-found" }), 404));

    return app;
}

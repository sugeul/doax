import { Hono } from "hono";
import { buildManifesto, withManifesto } from "@doax/protocol";
import { RegistryDatabase } from "./storage/sqlite.ts";

export const COMPONENT = "Registry Server";

export interface RegistryAppConfig {
    /** Domain this component serves under; used for the `manifesto` field (spec §10A). */
    domain: string;
    operator: string;
    /** SQLite file path, or `:memory:`. */
    databasePath: string;
    /** Upstream public registry, or null when this instance stands alone (spec §12.2). */
    upstream: string | null;
}

export interface RegistryApp {
    app: Hono;
    close(): void;
}

export function createRegistryApp(config: RegistryAppConfig): RegistryApp {
    const database = new RegistryDatabase(config.databasePath);
    const app = new Hono();
    const manifesto = buildManifesto(
        `${COMPONENT} — manifest storage, search, resolution, namespace policy, audit ingest and query`,
        config.operator,
    );

    app.get("/manifesto.json", (c) => c.json(manifesto));

    app.get("/", (c) =>
        c.json(
            withManifesto(config.domain, {
                component: COMPONENT,
                status: "ok",
                storage: "sqlite",
                upstream: config.upstream,
            }),
        ),
    );

    app.notFound((c) => c.json(withManifesto(config.domain, { error: "not-found" }), 404));

    return { app, close: () => database.close() };
}

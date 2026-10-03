import { join } from "node:path";
import { Hono } from "hono";
import { createAuthApp } from "@doax/auth-server";
import { createCodeRepositoryApp } from "@doax/code-repository";
import { MOUNTS, type ServerConfig } from "@doax/config";
import { buildManifesto, withManifesto } from "@doax/protocol";
import { createRegistryApp } from "@doax/registry-server";

export interface DoaxServer {
    app: Hono;
    close(): void;
}

/**
  * Composes the three server components (spec §3.1) into one Hono app under one hostname.
  * Path layout comes from MOUNTS: the registry owns the root, packages and auth hang off it.
  */
export function createServer(config: ServerConfig): DoaxServer {
    if (config.storage.kind !== "sqlite") {
        throw new Error(`Storage backend "${config.storage.kind}" is not implemented yet; use sqlite`);
    }

    const registry = createRegistryApp({
        domain: config.domain,
        operator: config.operator,
        databasePath: join(config.dataDir, "registry.sqlite"),
        upstream: config.upstream,
    });
    const codeRepository = createCodeRepositoryApp({
        domain: config.domain,
        operator: config.operator,
        packagesDir: join(config.dataDir, "packages"),
    });
    const auth = createAuthApp({
        domain: config.domain,
        operator: config.operator,
        oidcIssuer: config.auth.oidcIssuer,
        clientId: config.auth.clientId,
    });

    const app = new Hono();
    const manifesto = buildManifesto(
        "doax server — Registry Server, Code Repository and Auth Server in one process",
        config.operator,
        {
            components: {
                registry: MOUNTS.registry,
                codeRepository: MOUNTS.codeRepository,
                auth: MOUNTS.auth,
            },
            signIn: { protocol: "oidc", issuer: config.auth.oidcIssuer },
        },
    );

    // The composed server speaks for all components: one manifesto, one health endpoint.
    app.get("/manifesto.json", (c) => c.json(manifesto));
    app.get("/healthz", (c) => c.json(withManifesto(config.domain, { status: "ok", storage: config.storage.kind })));
    app.get("/", (c) =>
        c.json(
            withManifesto(config.domain, {
                component: "doax server",
                status: "ok",
                components: manifesto.components,
                storage: config.storage.kind,
                upstream: config.upstream,
            }),
        ),
    );

    app.route(MOUNTS.codeRepository, codeRepository);
    app.route(MOUNTS.auth, auth);
    app.route(MOUNTS.registry, registry.app);

    app.notFound((c) => c.json(withManifesto(config.domain, { error: "not-found" }), 404));

    return { app, close: () => registry.close() };
}

import { Hono } from "hono";
import { buildManifesto, withManifesto } from "@doax/protocol";
import { RegistryDatabase } from "./storage/sqlite.ts";
import { hasRole, isAdmin, issueToken, NAMESPACE_NAME, PRINCIPAL_ID, principalFrom, ROLES, SHARED_NAMESPACES } from "./auth.ts";

export const COMPONENT = "Registry Server";

export interface RegistryAppConfig {
    /** Domain this component serves under; used for the `manifesto` field (spec §10A). */
    domain: string;
    operator: string;
    /** SQLite file path, or `:memory:`. */
    databasePath: string;
    /** Upstream public registry, or null when this instance stands alone (spec §12.2). */
    upstream: string | null;
    /** Out-of-band operator token that may mint PATs and override namespace authority; null disables it. */
    adminToken: string | null;
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

    const db = database.db;
    const admin = (c: { req: { header(name: string): string | undefined } }) =>
        isAdmin(config.adminToken, c.req.header("x-doax-admin-token"));

    // Phase-1 PAT issuance (spec §7.2 OIDC swaps in later): the operator mints a token for a
    // principal so the Registry can identify callers before a login flow exists.
    app.post("/tokens", async (c) => {
        if (!admin(c)) return c.json(withManifesto(config.domain, { error: "admin token required" }), 403);
        const body = (await c.req.json().catch(() => null)) as { principalId?: string } | null;
        if (!body?.principalId || !PRINCIPAL_ID.test(body.principalId)) {
            return c.json(withManifesto(config.domain, { error: "body needs { principalId }" }), 400);
        }
        const token = issueToken(db, body.principalId);
        return c.json(withManifesto(config.domain, { principalId: body.principalId, token }), 201);
    });

    // Claim a free namespace (spec §4.1, §10): self-serve, first come becomes the owner.
    app.post("/namespaces", async (c) => {
        const principal = principalFrom(db, c.req.header("authorization"));
        if (!principal) return c.json(withManifesto(config.domain, { error: "namespace creation requires a Bearer token" }), 401);
        const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
        if (!body?.name || !NAMESPACE_NAME.test(body.name)) {
            return c.json(withManifesto(config.domain, { error: "body needs name matching @namespace" }), 400);
        }
        if (SHARED_NAMESPACES.has(body.name)) {
            return c.json(withManifesto(config.domain, { error: `${body.name} is the shared namespace — publish directly into it` }), 409);
        }
        if (db.prepare("SELECT 1 FROM namespaces WHERE name = ?").get(body.name)) {
            return c.json(withManifesto(config.domain, { error: `${body.name} is already owned` }), 409);
        }
        db.prepare("INSERT OR IGNORE INTO principals (principal_id) VALUES (?)").run(principal);
        db.prepare("INSERT INTO namespaces (name, owner) VALUES (?, ?)").run(body.name, principal);
        db.prepare("INSERT INTO namespace_members (namespace, principal_id, role) VALUES (?, ?, 'owner')").run(body.name, principal);
        return c.json(withManifesto(config.domain, { namespace: body.name, owner: principal }), 201);
    });

    // View a namespace; its member list is visible only to members and the operator (spec §8.5).
    app.get("/namespaces/:ns{@[a-z0-9._-]+}", (c) => {
        const name = c.req.param("ns");
        const ns = db.prepare("SELECT name, owner FROM namespaces WHERE name = ?").get(name) as { name: string; owner: string } | undefined;
        if (!ns) return c.json(withManifesto(config.domain, { error: `not found: ${name}` }), 404);
        const principal = principalFrom(db, c.req.header("authorization"));
        const visible = admin(c) || (principal !== null && hasRole(db, principal, name, [...ROLES]));
        const members = visible
            ? (db.prepare("SELECT principal_id, role FROM namespace_members WHERE namespace = ?").all(name) as { principal_id: string; role: string }[])
            : undefined;
        return c.json(withManifesto(config.domain, { namespace: ns.name, owner: ns.owner, members }));
    });

    // Owner (or operator) manages members: role owner|publisher|reader, or "none" to remove (spec §8.2a).
    app.put("/namespaces/:ns{@[a-z0-9._-]+}/members", async (c) => {
        const name = c.req.param("ns");
        if (SHARED_NAMESPACES.has(name)) return c.json(withManifesto(config.domain, { error: `${name} is shared and has no members` }), 409);
        if (!db.prepare("SELECT 1 FROM namespaces WHERE name = ?").get(name)) {
            return c.json(withManifesto(config.domain, { error: `not found: ${name}` }), 404);
        }
        const principal = principalFrom(db, c.req.header("authorization"));
        if (!admin(c) && (!principal || !hasRole(db, principal, name, ["owner"]))) {
            return c.json(withManifesto(config.domain, { error: `only the owner of ${name} may manage members` }), 403);
        }
        const body = (await c.req.json().catch(() => null)) as { principalId?: string; role?: string } | null;
        if (!body?.principalId || !PRINCIPAL_ID.test(body.principalId) || !["owner", "publisher", "reader", "none"].includes(body.role ?? "")) {
            return c.json(withManifesto(config.domain, { error: "body needs { principalId, role: owner|publisher|reader|none }" }), 400);
        }
        if (body.role === "none") {
            db.prepare("DELETE FROM namespace_members WHERE namespace = ? AND principal_id = ?").run(name, body.principalId);
        } else {
            db.prepare("INSERT OR IGNORE INTO principals (principal_id) VALUES (?)").run(body.principalId);
            db.prepare(
                "INSERT INTO namespace_members (namespace, principal_id, role) VALUES (?, ?, ?) ON CONFLICT (namespace, principal_id) DO UPDATE SET role = excluded.role",
            ).run(name, body.principalId, body.role!);
        }
        return c.json(withManifesto(config.domain, { namespace: name, principalId: body.principalId, role: body.role }));
    });

    app.notFound((c) => c.json(withManifesto(config.domain, { error: "not-found" }), 404));

    return { app, close: () => database.close() };
}

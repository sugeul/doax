import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { handle } from "hono/aws-lambda";
import { HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { MOUNTS } from "@doax/config";
import { buildManifesto, withManifesto } from "@doax/protocol";

/**
  * The global registry's registry-API service (one of its professional services): the first
  * real slice of the spec §10 Fixed Interface over Aurora PostgreSQL (manifests, append-only
  * audit) and S3 (immutable packages, served to clients via CloudFront at /packages/*).
  *
  * Implemented: resolve, search, publish (admin-token-gated until the Auth Server lands),
  * audit ingest. Deliberately absent until §7 auth exists: tokens, namespace management,
  * visibility enforcement beyond `public`, verification review.
  */

const DOMAIN = process.env.DOAX_DOMAIN ?? "https://registry.doax.io";
const OPERATOR = process.env.DOAX_OPERATOR ?? "unconfigured";
const PACKAGES_BUCKET = process.env.DOAX_PACKAGES_BUCKET ?? "";
const ADMIN_TOKEN = process.env.DOAX_ADMIN_TOKEN ?? "";

const s3 = new S3Client({});
const db = process.env.DOAX_DB_HOST
    ? new pg.Pool({
          host: process.env.DOAX_DB_HOST,
          port: Number(process.env.DOAX_DB_PORT ?? "5432"),
          database: process.env.DOAX_DB_NAME ?? "doax",
          user: process.env.DOAX_DB_USER ?? "doax",
          password: process.env.DOAX_DB_PASSWORD ?? "",
          ssl: { rejectUnauthorized: false },
          max: 1,
          connectionTimeoutMillis: 4000,
      })
    : null;

let schemaReady: Promise<void> | null = null;

/** Audit append-only at the database level (spec §8.1), matching the SQLite storage's triggers. */
function ensureSchema(): Promise<void> {
    if (!db) return Promise.reject(new Error("database not configured"));
    schemaReady ??= (async () => {
        await db.query(`
            CREATE TABLE IF NOT EXISTS manifests (
                namespace    TEXT NOT NULL,
                name         TEXT NOT NULL,
                version      TEXT NOT NULL,
                kind         TEXT NOT NULL,
                manifest     JSONB NOT NULL,
                digest       TEXT NOT NULL,
                visibility   TEXT NOT NULL DEFAULT 'public',
                verification TEXT NOT NULL DEFAULT 'unverified',
                lifecycle    TEXT NOT NULL DEFAULT 'active',
                published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (namespace, name, version)
            );
            CREATE TABLE IF NOT EXISTS audit_events (
                event_id  TEXT PRIMARY KEY,
                timestamp TIMESTAMPTZ NOT NULL,
                class     TEXT NOT NULL,
                actor     TEXT NOT NULL,
                resource  TEXT NOT NULL,
                body      JSONB NOT NULL
            );
            CREATE INDEX IF NOT EXISTS audit_events_by_time ON audit_events (timestamp);
            CREATE INDEX IF NOT EXISTS audit_events_by_resource ON audit_events (resource, timestamp);
            CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS
                $$ BEGIN RAISE EXCEPTION 'audit events are append-only'; END $$ LANGUAGE plpgsql;
            DROP TRIGGER IF EXISTS audit_append_only ON audit_events;
            CREATE TRIGGER audit_append_only
                BEFORE UPDATE OR DELETE ON audit_events
                FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
        `);
    })();
    return schemaReady;
}

async function appendAudit(event: {
    eventId?: string;
    timestamp?: string;
    class: string;
    actor: string;
    resource: string;
    [extra: string]: unknown;
}): Promise<string> {
    const eventId = typeof event.eventId === "string" && event.eventId ? event.eventId : randomUUID();
    const timestamp = typeof event.timestamp === "string" && event.timestamp ? event.timestamp : new Date().toISOString();
    await db!.query(
        `INSERT INTO audit_events (event_id, timestamp, class, actor, resource, body)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING`,
        [eventId, timestamp, event.class, event.actor, event.resource, JSON.stringify(event)],
    );
    return eventId;
}

const IDENTITY = /^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)(?:@([^@\s/]+))?$/;

interface ManifestRow {
    namespace: string;
    name: string;
    version: string;
    kind: string;
    manifest: Record<string, unknown>;
    digest: string;
    visibility: string;
    verification: string;
    lifecycle: string;
}

function packageKey(identity: string): string {
    return `packages/${identity}.mjs`;
}

function resolveBody(row: ManifestRow) {
    const identity = `@${row.namespace}/${row.name}@${row.version}`;
    return {
        identity,
        kind: row.kind,
        manifest: row.manifest,
        digest: row.digest,
        visibility: row.visibility,
        verification: row.verification,
        lifecycle: row.lifecycle,
        package: `/${packageKey(identity)}`,
    };
}

const manifesto = buildManifesto(
    "Registry Server — manifest storage, search, resolution, publish, audit ingest (global instance)",
    OPERATOR,
    { components: { registry: MOUNTS.registry, codeRepository: MOUNTS.codeRepository, auth: MOUNTS.auth } },
);

const app = new Hono();

app.use(
    "*",
    cors({
        origin: (origin) =>
            origin === "https://doax.io" || origin === "https://www.doax.io" || /^http:\/\/localhost(:\d+)?$/.test(origin)
                ? origin
                : "https://doax.io",
        allowHeaders: ["content-type", "authorization", "x-doax-admin-token"],
        allowMethods: ["GET", "HEAD", "POST", "PUT", "OPTIONS"],
    }),
);

app.get("/manifesto.json", (c) => c.json(manifesto));

app.get("/", (c) =>
    c.json(
        withManifesto(DOMAIN, {
            component: "doax server",
            status: "ok",
            deployment: "aws",
            components: manifesto.components,
            capabilities: ["resolve", "search", "publish", "audit-ingest"],
        }),
    ),
);

app.get("/healthz", (c) => c.json(withManifesto(DOMAIN, { status: "ok", deployment: "aws" })));

app.get("/healthz/deep", async (c) => {
    const [database, storage] = await Promise.all([
        db
            ? db
                  .query("SELECT 1 AS ok")
                  .then((r) => ({ ok: r.rows[0]?.ok === 1 }))
                  .catch((error: Error) => ({ ok: false, detail: error.message }))
            : Promise.resolve({ ok: false, detail: "DOAX_DB_HOST not set" }),
        PACKAGES_BUCKET
            ? s3
                  .send(new HeadBucketCommand({ Bucket: PACKAGES_BUCKET }))
                  .then(() => ({ ok: true }))
                  .catch((error: Error) => ({ ok: false, detail: error.message }))
            : Promise.resolve({ ok: false, detail: "DOAX_PACKAGES_BUCKET not set" }),
    ]);
    const status = database.ok && storage.ok ? "ok" : "degraded";
    return c.json(withManifesto(DOMAIN, { status, database, storage }), status === "ok" ? 200 : 503);
});

/** Search (spec §10). Also feeds the doax.io website's Search tab, hence the flat result fields. */
app.get("/search", async (c) => {
    await ensureSchema();
    const q = (c.req.query("q") ?? "").trim();
    const kind = c.req.query("kind");
    const like = `%${q}%`;
    const { rows } = await db!.query<ManifestRow>(
        `SELECT DISTINCT ON (namespace, name) namespace, name, version, kind, manifest, digest, visibility, verification, lifecycle
         FROM manifests
         WHERE lifecycle = 'active' AND visibility = 'public'
           AND ($1 = '' OR namespace ILIKE $2 OR name ILIKE $2 OR manifest->>'summary' ILIKE $2 OR manifest->>'description' ILIKE $2)
           AND ($3::text IS NULL OR kind = $3)
         ORDER BY namespace, name, published_at DESC
         LIMIT 50`,
        [q, like, kind ?? null],
    );
    await appendAudit({ class: "resolve", actor: "anonymous", resource: `search:${q || "*"}` });
    const results = rows.map((row) => ({
        ...resolveBody(row),
        ns: `@${row.namespace}`,
        name: row.name,
        ver: row.version,
        tier: (row.manifest as { requiredTier?: number }).requiredTier ?? 4,
        loc: (row.manifest as { executionLocation?: string }).executionLocation ?? "—",
        vok: row.verification === "verified",
        sum: (row.manifest as { summary?: string }).summary ?? "",
    }));
    return c.json(withManifesto(DOMAIN, { query: q, results }));
});

/** Audit ingest (spec §10, §8.2). Append-only; redelivery of the same eventId is a no-op. */
app.post("/audit", async (c) => {
    await ensureSchema();
    const body = (await c.req.json().catch(() => null)) as { events?: Record<string, unknown>[] } | null;
    if (!body || !Array.isArray(body.events)) {
        return c.json(withManifesto(DOMAIN, { error: "body must be { events: [...] }" }), 400);
    }
    const accepted: string[] = [];
    for (const event of body.events) {
        if (typeof event.class !== "string" || typeof event.actor !== "string" || typeof event.resource !== "string") {
            return c.json(withManifesto(DOMAIN, { error: "each event needs class, actor, resource" }), 400);
        }
        accepted.push(await appendAudit(event as Parameters<typeof appendAudit>[0]));
    }
    return c.json(withManifesto(DOMAIN, { accepted }));
});

/** Publish (spec §10, §11). Admin-token-gated until the Auth Server issues §7.2 tokens. */
app.put("/:ns{@[a-z0-9._-]+}/:namever", async (c) => {
    if (!ADMIN_TOKEN || c.req.header("x-doax-admin-token") !== ADMIN_TOKEN) {
        return c.json(withManifesto(DOMAIN, { error: "publish requires a valid x-doax-admin-token" }), 401);
    }
    const identity = `${c.req.param("ns")}/${c.req.param("namever")}`;
    const match = IDENTITY.exec(identity);
    if (!match || !match[3]) return c.json(withManifesto(DOMAIN, { error: `publish needs @ns/name@version, got ${identity}` }), 400);
    const [, namespace, name, version] = match;

    const body = (await c.req.json().catch(() => null)) as { manifest?: Record<string, unknown>; package?: string } | null;
    if (!body?.manifest || typeof body.package !== "string") {
        return c.json(withManifesto(DOMAIN, { error: "body must be { manifest, package: base64 }" }), 400);
    }
    for (const field of ["kind", "summary", "description", "owner", "requiredTier", "interfaceMapping", "serviceLevel"]) {
        if (!(field in body.manifest)) return c.json(withManifesto(DOMAIN, { error: `manifest missing mandatory field: ${field}` }), 400);
    }

    await ensureSchema();
    const content = Buffer.from(body.package, "base64");
    const digest = `sha256-${createHash("sha256").update(content).digest("hex")}`;
    const manifest: Record<string, unknown> = { ...body.manifest, identity, integrity: digest };

    // Immutability (spec §4.4): a version can be created once, never replaced. The admin-only
    // force header is a PRE-PUBLIC escape hatch for re-seeding; it is removed at public launch.
    const force = c.req.header("x-doax-admin-force") === "true";
    const inserted = await db!.query(
        force
            ? `INSERT INTO manifests (namespace, name, version, kind, manifest, digest)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (namespace, name, version)
               DO UPDATE SET kind = EXCLUDED.kind, manifest = EXCLUDED.manifest, digest = EXCLUDED.digest, published_at = now()
               RETURNING version`
            : `INSERT INTO manifests (namespace, name, version, kind, manifest, digest)
               VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING version`,
        [namespace, name, version, manifest.kind, JSON.stringify(manifest), digest],
    );
    if (inserted.rowCount === 0) return c.json(withManifesto(DOMAIN, { error: `${identity} already exists (immutable, §4.4)` }), 409);

    await s3.send(
        new PutObjectCommand({
            Bucket: PACKAGES_BUCKET,
            Key: packageKey(identity),
            Body: content,
            ContentType: "text/javascript; charset=utf-8",
        }),
    );
    await appendAudit({ class: "publish", actor: "operator", resource: identity, digest });
    return c.json(withManifesto(DOMAIN, { published: identity, digest, package: `/${packageKey(identity)}` }), 201);
});

/** Resolve (spec §10): @ns/name@version exact, or @ns/name -> newest active version. */
app.get("/:ns{@[a-z0-9._-]+}/:namever", async (c) => {
    const ref = `${c.req.param("ns")}/${c.req.param("namever")}`;
    const match = IDENTITY.exec(ref);
    if (!match) return c.json(withManifesto(DOMAIN, { error: `invalid resource reference: ${ref}` }), 400);
    const [, namespace, name, version] = match;

    await ensureSchema();
    const { rows } = await db!.query<ManifestRow>(
        version
            ? `SELECT * FROM manifests WHERE namespace=$1 AND name=$2 AND version=$3`
            : `SELECT * FROM manifests WHERE namespace=$1 AND name=$2 AND lifecycle='active' ORDER BY published_at DESC LIMIT 1`,
        version ? [namespace, name, version] : [namespace, name],
    );
    const row = rows[0];
    if (!row) return c.json(withManifesto(DOMAIN, { error: `not found: ${ref}` }), 404);

    await appendAudit({ class: "resolve", actor: "anonymous", resource: `@${row.namespace}/${row.name}@${row.version}` });
    const body = resolveBody(row);
    return c.json(
        withManifesto(DOMAIN, row.lifecycle === "deprecated" ? { ...body, warning: `${body.identity} is deprecated` } : body),
    );
});

app.notFound((c) => c.json(withManifesto(DOMAIN, { error: "not-found" }), 404));

export const handler = handle(app);

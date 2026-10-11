import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { handle } from "hono/aws-lambda";
import {
    CloudWatchLogsClient,
    CreateLogStreamCommand,
    FilterLogEventsCommand,
    PutLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
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
const AUDIT_LOG_GROUP = process.env.DOAX_AUDIT_LOG_GROUP ?? "";
const EMAIL_FROM = process.env.DOAX_EMAIL_FROM ?? "";

const s3 = new S3Client({});
const cw = new CloudWatchLogsClient({});
const ses = new SESv2Client({});
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
            CREATE TABLE IF NOT EXISTS principals (
                principal_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS access_tokens (
                token_hash   TEXT PRIMARY KEY,
                principal_id TEXT NOT NULL REFERENCES principals(principal_id),
                note         TEXT NOT NULL DEFAULT '',
                created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                expires_at   TIMESTAMPTZ
            );
            CREATE TABLE IF NOT EXISTS namespaces (
                name       TEXT PRIMARY KEY,
                owner      TEXT NOT NULL REFERENCES principals(principal_id),
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS namespace_members (
                namespace    TEXT NOT NULL REFERENCES namespaces(name),
                principal_id TEXT NOT NULL REFERENCES principals(principal_id),
                role         TEXT NOT NULL CHECK (role IN ('owner', 'publisher', 'reader')),
                PRIMARY KEY (namespace, principal_id)
            );
            CREATE TABLE IF NOT EXISTS email_logins (
                email      TEXT PRIMARY KEY,
                code_hash  TEXT NOT NULL,
                attempts   INT NOT NULL DEFAULT 0,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            -- @global: the shared namespace every authenticated principal may publish into.
            INSERT INTO principals (principal_id, display_name) VALUES ('operator', 'registry operator')
                ON CONFLICT DO NOTHING;
            INSERT INTO namespaces (name, owner) VALUES ('@global', 'operator')
                ON CONFLICT DO NOTHING;
        `);
    })();
    return schemaReady;
}

/** @global is open to every authenticated principal; it can never be claimed or member-managed. */
const SHARED_NAMESPACES = new Set(["@global"]);

/* ---------- permission control (phase 1: registry PATs; §7.2 OIDC tokens swap in later) ---------- */

const PRINCIPAL_ID = /^[a-z0-9][a-z0-9._-]*$/;
const NAMESPACE_NAME = /^@[a-z0-9][a-z0-9._-]*$/;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Resolve the Bearer principal, or null for anonymous callers. */
async function principalFrom(c: { req: { header(name: string): string | undefined } }): Promise<string | null> {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return null;
    await ensureSchema();
    const { rows } = await db!.query<{ principal_id: string }>(
        `SELECT principal_id FROM access_tokens WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > now())`,
        [hashToken(match[1]!)],
    );
    return rows[0]?.principal_id ?? null;
}

/** Namespaces where the principal holds one of the given roles. */
async function namespacesOf(principal: string, roles: string[]): Promise<string[]> {
    const { rows } = await db!.query<{ namespace: string }>(
        `SELECT namespace FROM namespace_members WHERE principal_id = $1 AND role = ANY($2)`,
        [principal, roles],
    );
    return rows.map((r) => r.namespace);
}

async function hasRole(principal: string, namespace: string, roles: string[]): Promise<boolean> {
    const { rows } = await db!.query(
        `SELECT 1 FROM namespace_members WHERE namespace = $1 AND principal_id = $2 AND role = ANY($3)`,
        [`@${namespace}`, principal, roles],
    );
    return rows.length > 0;
}

const isAdmin = (c: { req: { header(name: string): string | undefined } }) =>
    Boolean(ADMIN_TOKEN) && c.req.header("x-doax-admin-token") === ADMIN_TOKEN;

/*
 * Audit store: CloudWatch Logs (append-only by construction — log events cannot be edited or
 * deleted individually; retention is set to "never expire" in Terraform). One stream per UTC
 * day. Redelivered events may duplicate at ingest; the query side dedupes by eventId.
 */
type AuditInput = {
    eventId?: string;
    timestamp?: string;
    class: string;
    actor: string;
    resource: string;
    [extra: string]: unknown;
};

const auditStreams = new Set<string>();

async function ensureAuditStream(stream: string): Promise<void> {
    if (auditStreams.has(stream)) return;
    try {
        await cw.send(new CreateLogStreamCommand({ logGroupName: AUDIT_LOG_GROUP, logStreamName: stream }));
    } catch (error) {
        if ((error as { name?: string }).name !== "ResourceAlreadyExistsException") throw error;
    }
    auditStreams.add(stream);
}

async function appendAudit(events: AuditInput[]): Promise<string[]> {
    if (!AUDIT_LOG_GROUP) throw new Error("DOAX_AUDIT_LOG_GROUP not set");
    const now = Date.now();
    const stream = new Date().toISOString().slice(0, 10);
    await ensureAuditStream(stream);
    const prepared = events.map((event) => {
        const eventId = typeof event.eventId === "string" && event.eventId ? event.eventId : randomUUID();
        const timestamp = typeof event.timestamp === "string" && event.timestamp ? event.timestamp : new Date(now).toISOString();
        // CloudWatch rejects far-past/future event times; clamp the LOG time, keep the true time in the body.
        const logTime = Math.min(Math.max(Date.parse(timestamp) || now, now - 13 * 86400_000), now + 60_000);
        return { logTime, message: JSON.stringify({ ...event, eventId, timestamp }) , eventId };
    });
    prepared.sort((a, b) => a.logTime - b.logTime);
    await cw.send(
        new PutLogEventsCommand({
            logGroupName: AUDIT_LOG_GROUP,
            logStreamName: stream,
            logEvents: prepared.map((p) => ({ timestamp: p.logTime, message: p.message })),
        }),
    );
    return prepared.map((p) => p.eventId);
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
            capabilities: ["resolve", "search", "publish", "audit-ingest", "audit-query"],
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Email sign-in, step 1 (pre-OIDC spec delta): send a 6-digit code. Proof of inbox = identity. */
app.post("/auth/email", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: string } | null;
    const email = body?.email?.trim().toLowerCase() ?? "";
    if (!EMAIL.test(email)) return c.json(withManifesto(DOMAIN, { error: "body needs a valid email" }), 400);
    await ensureSchema();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await db!.query(
        `INSERT INTO email_logins (email, code_hash, attempts, expires_at) VALUES ($1, $2, 0, now() + interval '10 minutes')
         ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = now()`,
        [email, hashToken(code)],
    );
    await ses.send(
        new SendEmailCommand({
            FromEmailAddress: `doax <${EMAIL_FROM}>`,
            Destination: { ToAddresses: [email] },
            Content: {
                Simple: {
                    Subject: { Data: `doax sign-in code: ${code}` },
                    Body: {
                        Text: {
                            Data: `Your doax sign-in code is ${code}\n\nIt expires in 10 minutes. If you did not request it, ignore this mail.\n\n— ${DOMAIN}`,
                        },
                    },
                },
            },
        }),
    );
    await appendAudit([{ class: "auth", actor: email, resource: "registry:email-login", mode: "code-sent" }]);
    return c.json(withManifesto(DOMAIN, { sent: true, email, expiresInMinutes: 10 }));
});

/** Email sign-in, step 2: verify the code, create the principal if new, issue a token. */
app.post("/auth/verify", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: string; code?: string } | null;
    const email = body?.email?.trim().toLowerCase() ?? "";
    const code = body?.code?.trim() ?? "";
    if (!EMAIL.test(email) || !/^\d{6}$/.test(code)) {
        return c.json(withManifesto(DOMAIN, { error: "body needs { email, code: 6 digits }" }), 400);
    }
    await ensureSchema();
    const { rows } = await db!.query<{ code_hash: string; attempts: number; expired: boolean }>(
        `UPDATE email_logins SET attempts = attempts + 1 WHERE email = $1
         RETURNING code_hash, attempts, (expires_at < now()) AS expired`,
        [email],
    );
    const row = rows[0];
    const ok = row && !row.expired && row.attempts <= 5 && row.code_hash === hashToken(code);
    if (!ok) {
        await appendAudit([{ class: "auth", actor: email, resource: "registry:email-login", mode: "verify", outcome: "failure" }]);
        return c.json(withManifesto(DOMAIN, { error: "code invalid, expired, or too many attempts — request a new one" }), 401);
    }
    await db!.query(`DELETE FROM email_logins WHERE email = $1`, [email]);
    await db!.query(`INSERT INTO principals (principal_id, display_name) VALUES ($1, $1) ON CONFLICT DO NOTHING`, [email]);
    const token = `doax_pat_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    await db!.query(`INSERT INTO access_tokens (token_hash, principal_id, note) VALUES ($1, $2, 'email login')`, [hashToken(token), email]);
    await appendAudit([{ class: "auth", actor: email, resource: "registry:email-login", mode: "verify", outcome: "success" }]);
    return c.json(withManifesto(DOMAIN, { principal: email, token, note: "store this token; it is not shown again" }), 201);
});

app.get("/whoami", async (c) => {
    const principal = await principalFrom(c);
    if (!principal) return c.json(withManifesto(DOMAIN, { error: "no valid token" }), 401);
    const namespaces = await namespacesOf(principal, ["owner", "publisher", "reader"]);
    return c.json(withManifesto(DOMAIN, { principal, namespaces }));
});

/** Create a principal and issue a PAT (operator-only bootstrap; §7.2 OIDC replaces this). */
app.post("/principals", async (c) => {
    if (!isAdmin(c)) return c.json(withManifesto(DOMAIN, { error: "requires x-doax-admin-token" }), 401);
    const body = (await c.req.json().catch(() => null)) as { principalId?: string; displayName?: string } | null;
    if (!body?.principalId || !PRINCIPAL_ID.test(body.principalId)) {
        return c.json(withManifesto(DOMAIN, { error: "body needs principalId matching [a-z0-9][a-z0-9._-]*" }), 400);
    }
    await ensureSchema();
    await db!.query(
        `INSERT INTO principals (principal_id, display_name) VALUES ($1, $2) ON CONFLICT (principal_id) DO NOTHING`,
        [body.principalId, body.displayName ?? body.principalId],
    );
    const token = `doax_pat_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    await db!.query(`INSERT INTO access_tokens (token_hash, principal_id, note) VALUES ($1, $2, $3)`, [
        hashToken(token),
        body.principalId,
        "issued by operator",
    ]);
    await appendAudit([{ class: "auth", actor: body.principalId, resource: "registry:token", mode: "issue" }]);
    return c.json(withManifesto(DOMAIN, { principal: body.principalId, token, note: "store this token; it is not shown again" }), 201);
});

/** Claim a free namespace (self-serve; first come, first owner). */
app.post("/namespaces", async (c) => {
    const principal = await principalFrom(c);
    if (!principal) return c.json(withManifesto(DOMAIN, { error: "namespace creation requires a Bearer token" }), 401);
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
    if (!body?.name || !NAMESPACE_NAME.test(body.name)) {
        return c.json(withManifesto(DOMAIN, { error: "body needs name matching @namespace" }), 400);
    }
    if (SHARED_NAMESPACES.has(body.name)) {
        return c.json(withManifesto(DOMAIN, { error: `${body.name} is the shared namespace — publish directly into it` }), 409);
    }
    const claimed = await db!.query(
        `INSERT INTO namespaces (name, owner) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING name`,
        [body.name, principal],
    );
    if (claimed.rowCount === 0) return c.json(withManifesto(DOMAIN, { error: `${body.name} is already owned` }), 409);
    await db!.query(`INSERT INTO namespace_members (namespace, principal_id, role) VALUES ($1, $2, 'owner')`, [body.name, principal]);
    return c.json(withManifesto(DOMAIN, { namespace: body.name, owner: principal }), 201);
});

app.get("/namespaces/:ns{@[a-z0-9._-]+}", async (c) => {
    await ensureSchema();
    const name = c.req.param("ns");
    const { rows } = await db!.query<{ name: string; owner: string }>(`SELECT name, owner FROM namespaces WHERE name = $1`, [name]);
    if (!rows[0]) return c.json(withManifesto(DOMAIN, { error: `not found: ${name}` }), 404);
    const principal = await principalFrom(c);
    const self = principal ? await hasRole(principal, name.slice(1), ["owner", "publisher", "reader"]) : false;
    const members =
        self || isAdmin(c)
            ? (await db!.query<{ principal_id: string; role: string }>(`SELECT principal_id, role FROM namespace_members WHERE namespace = $1`, [name])).rows
            : undefined;
    return c.json(withManifesto(DOMAIN, { namespace: rows[0].name, owner: rows[0].owner, members }));
});

/** Owner manages members: role owner|publisher|reader, or "none" to remove. */
app.put("/namespaces/:ns{@[a-z0-9._-]+}/members", async (c) => {
    const name = c.req.param("ns");
    const principal = await principalFrom(c);
    const admin = isAdmin(c);
    if (!admin && (!principal || !(await hasRole(principal, name.slice(1), ["owner"])))) {
        return c.json(withManifesto(DOMAIN, { error: `only the owner of ${name} may manage members` }), 403);
    }
    const body = (await c.req.json().catch(() => null)) as { principalId?: string; role?: string } | null;
    if (!body?.principalId || !["owner", "publisher", "reader", "none"].includes(body.role ?? "")) {
        return c.json(withManifesto(DOMAIN, { error: "body needs { principalId, role: owner|publisher|reader|none }" }), 400);
    }
    if (body.role === "none") {
        await db!.query(`DELETE FROM namespace_members WHERE namespace = $1 AND principal_id = $2`, [name, body.principalId]);
    } else {
        await db!.query(
            `INSERT INTO namespace_members (namespace, principal_id, role) VALUES ($1, $2, $3)
             ON CONFLICT (namespace, principal_id) DO UPDATE SET role = EXCLUDED.role`,
            [name, body.principalId, body.role],
        );
    }
    return c.json(withManifesto(DOMAIN, { namespace: name, principalId: body.principalId, role: body.role }));
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
    await appendAudit([{ class: "resolve", actor: "anonymous", resource: `search:${q || "*"}` }]);
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

/** Audit ingest (spec §10, §8.2). Append-only; the query side dedupes redelivered eventIds. */
app.post("/audit", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { events?: Record<string, unknown>[] } | null;
    if (!body || !Array.isArray(body.events) || body.events.length === 0) {
        return c.json(withManifesto(DOMAIN, { error: "body must be { events: [...] }" }), 400);
    }
    for (const event of body.events) {
        if (typeof event.class !== "string" || typeof event.actor !== "string" || typeof event.resource !== "string") {
            return c.json(withManifesto(DOMAIN, { error: "each event needs class, actor, resource" }), 400);
        }
    }
    const accepted = await appendAudit(body.events as AuditInput[]);
    return c.json(withManifesto(DOMAIN, { accepted }));
});

/**
  * Audit query (spec §8.5) over the CloudWatch store. The operator sees everything; a Bearer
  * principal sees exactly the events of namespaces they belong to — the owner's governance view.
  */
app.get("/audit", async (c) => {
    const admin = isAdmin(c);
    let scope: string[] | null = null; // null = unscoped (operator)
    if (!admin) {
        const principal = await principalFrom(c);
        if (!principal) return c.json(withManifesto(DOMAIN, { error: "audit query requires a Bearer token or the operator token" }), 401);
        scope = await namespacesOf(principal, ["owner", "publisher", "reader"]);
        if (scope.length === 0) return c.json(withManifesto(DOMAIN, { error: `${principal} belongs to no namespaces` }), 403);
    }
    const q = {
        class: c.req.query("class"),
        actor: c.req.query("actor"),
        resource: c.req.query("resource"),
        since: c.req.query("since"),
        until: c.req.query("until"),
        limit: Math.min(Number(c.req.query("limit") ?? 100) || 100, 1000),
    };
    if (scope && q.resource && !scope.some((ns) => q.resource!.startsWith(`${ns}/`) || q.resource === ns)) {
        return c.json(withManifesto(DOMAIN, { error: `resource filter must be inside your namespaces: ${scope.join(", ")}` }), 403);
    }
    const terms: string[] = [];
    if (q.class) terms.push(`$.class = "${q.class.replaceAll('"', "")}"`);
    if (q.actor) terms.push(`$.actor = "${q.actor.replaceAll('"', "")}"`);
    if (q.resource) terms.push(`$.resource = "${q.resource.replaceAll('"', "")}*"`);
    else if (scope) terms.push(`(${scope.map((ns) => `$.resource = "${ns}/*"`).join(" || ")})`);
    // FilterLogEvents reports scan progress: pages can be EMPTY yet carry a nextToken.
    // Follow the token until we have enough events or the scan is exhausted.
    const seen = new Set<string>();
    const events: unknown[] = [];
    let nextToken: string | undefined;
    let truncated = false;
    for (let page = 0; page < 25; page++) {
        const out = await cw.send(
            new FilterLogEventsCommand({
                logGroupName: AUDIT_LOG_GROUP,
                filterPattern: terms.length ? `{ ${terms.join(" && ")} }` : undefined,
                startTime: q.since ? Date.parse(q.since) || undefined : undefined,
                endTime: q.until ? Date.parse(q.until) || undefined : undefined,
                limit: q.limit,
                nextToken,
            }),
        );
        for (const entry of out.events ?? []) {
            try {
                const parsed = JSON.parse(entry.message ?? "") as { eventId?: string };
                if (parsed.eventId && seen.has(parsed.eventId)) continue;
                if (parsed.eventId) seen.add(parsed.eventId);
                events.push(parsed);
            } catch {
                /* non-JSON line; skip */
            }
        }
        nextToken = out.nextToken;
        if (!nextToken || events.length >= q.limit) {
            truncated = Boolean(nextToken);
            break;
        }
        truncated = true; // page budget exhausted while a token remains
    }
    return c.json(withManifesto(DOMAIN, { count: events.length, truncated, events: events.slice(0, q.limit) }));
});

/** Publish (spec §10, §11). Requires owner/publisher role in the namespace (or the operator token). */
app.put("/:ns{@[a-z0-9._-]+}/:namever", async (c) => {
    const identity = `${c.req.param("ns")}/${c.req.param("namever")}`;
    const match = IDENTITY.exec(identity);
    if (!match || !match[3]) return c.json(withManifesto(DOMAIN, { error: `publish needs @ns/name@version, got ${identity}` }), 400);
    const [, namespace, name, version] = match;

    await ensureSchema();
    const admin = isAdmin(c);
    const principal = admin ? null : await principalFrom(c);
    if (!admin) {
        if (!principal) return c.json(withManifesto(DOMAIN, { error: "publish requires a Bearer token (or operator token)" }), 401);
        // @global is open to every authenticated principal; any other namespace needs a role.
        if (!SHARED_NAMESPACES.has(`@${namespace}`) && !(await hasRole(principal, namespace!, ["owner", "publisher"]))) {
            return c.json(
                withManifesto(DOMAIN, {
                    error: `${principal} is not an owner/publisher of @${namespace}`,
                    fix: `publish to @global (open to everyone), claim @${namespace} (POST /namespaces) if free, or ask its owner to add you as a publisher`,
                }),
                403,
            );
        }
    }
    const actor = principal ?? "operator";

    const body = (await c.req.json().catch(() => null)) as { manifest?: Record<string, unknown>; package?: string } | null;
    if (!body?.manifest || typeof body.package !== "string") {
        return c.json(withManifesto(DOMAIN, { error: "body must be { manifest, package: base64 }" }), 400);
    }
    for (const field of ["kind", "summary", "description", "owner", "requiredTier", "interfaceMapping", "serviceLevel"]) {
        if (!(field in body.manifest)) return c.json(withManifesto(DOMAIN, { error: `manifest missing mandatory field: ${field}` }), 400);
    }

    const content = Buffer.from(body.package, "base64");
    const digest = `sha256-${createHash("sha256").update(content).digest("hex")}`;
    const manifest: Record<string, unknown> = { ...body.manifest, identity, integrity: digest };

    // Immutability (spec §4.4): a version can be created once, never replaced. The force
    // header is a PRE-PUBLIC escape hatch for re-seeding, OPERATOR-ONLY; removed at public launch.
    const force = admin && c.req.header("x-doax-admin-force") === "true";
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
    await appendAudit([{ class: "publish", actor, resource: identity, digest }]);
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

    // Visibility (spec §4.5): namespace-only resources resolve for members alone; hidden otherwise.
    const principal = await principalFrom(c);
    if (row.visibility !== "public" && !isAdmin(c)) {
        if (!principal || !(await hasRole(principal, row.namespace, ["owner", "publisher", "reader"]))) {
            return c.json(withManifesto(DOMAIN, { error: `not found: ${ref}` }), 404);
        }
    }

    await appendAudit([{ class: "resolve", actor: principal ?? "anonymous", resource: `@${row.namespace}/${row.name}@${row.version}` }]);
    const body = resolveBody(row);
    return c.json(
        withManifesto(DOMAIN, row.lifecycle === "deprecated" ? { ...body, warning: `${body.identity} is deprecated` } : body),
    );
});

app.notFound((c) => c.json(withManifesto(DOMAIN, { error: "not-found" }), 404));

export const handler = handle(app);

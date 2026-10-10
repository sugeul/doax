import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { MOUNTS } from "@doax/config";
import { buildManifesto, withManifesto } from "@doax/protocol";

/**
  * M3 AWS skeleton handler (infra-first). Its only job is to prove the plumbing:
  * CloudFront -> Lambda (in VPC) -> Aurora PostgreSQL + S3 are reachable.
  *
  * It deliberately does NOT import the composed server (`createServer`), because that
  * pulls in `@doax/registry-server` -> `node:sqlite`, which is a Node 24 built-in and is
  * only experimental on the newest managed Lambda runtime (nodejs22.x). Running the real
  * composed app on Lambda is deferred until either (a) the Postgres storage port exists so
  * `node:sqlite` is no longer imported, or (b) it ships as a Node 24 container image.
  * Until then this skeleton validates the deployment shape only.
  */

const DOMAIN = process.env.DOAX_DOMAIN ?? "https://doax.io";
const OPERATOR = process.env.DOAX_OPERATOR ?? "unconfigured";
const PACKAGES_BUCKET = process.env.DOAX_PACKAGES_BUCKET ?? "";

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

async function probeDatabase() {
    if (!db) return { ok: false, detail: "DOAX_DB_HOST not set" };
    try {
        const { rows } = await db.query("SELECT 1 AS ok");
        return { ok: rows[0]?.ok === 1 };
    } catch (error) {
        return { ok: false, detail: (error as Error).message };
    }
}

async function probeStorage() {
    if (!PACKAGES_BUCKET) return { ok: false, detail: "DOAX_PACKAGES_BUCKET not set" };
    try {
        await s3.send(new HeadBucketCommand({ Bucket: PACKAGES_BUCKET }));
        return { ok: true };
    } catch (error) {
        return { ok: false, detail: (error as Error).message };
    }
}

const manifesto = buildManifesto(
    "doax server (AWS skeleton) — Registry Server, Code Repository and Auth Server, SaaS deployment",
    OPERATOR,
    { components: { registry: MOUNTS.registry, codeRepository: MOUNTS.codeRepository, auth: MOUNTS.auth } },
);

const app = new Hono();

app.get("/manifesto.json", (c) => c.json(manifesto));

app.get("/", (c) =>
    c.json(
        withManifesto(DOMAIN, {
            component: "doax server",
            status: "ok",
            deployment: "aws-skeleton",
            components: manifesto.components,
        }),
    ),
);

app.get("/healthz", (c) => c.json(withManifesto(DOMAIN, { status: "ok", deployment: "aws-skeleton" })));

// Deep health: proves the Lambda can actually reach the data plane the registry will use.
app.get("/healthz/deep", async (c) => {
    const [database, storage] = await Promise.all([probeDatabase(), probeStorage()]);
    const status = database.ok && storage.ok ? "ok" : "degraded";
    return c.json(withManifesto(DOMAIN, { status, database, storage }), status === "ok" ? 200 : 503);
});

app.notFound((c) => c.json(withManifesto(DOMAIN, { error: "not-found" }), 404));

export const handler = handle(app);

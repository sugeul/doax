import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "@doax/config";
import { createServer } from "./server.ts";

const server = createServer(
    loadServerConfig({}, { domain: "https://registry.corp.internal", operator: "Corp IT", dataDir: mkdtempSync(join(tmpdir(), "doax-")) }),
);
afterAll(() => server.close());

describe("doax server", () => {
    it("mounts every component under one hostname", async () => {
        const paths = { "/": "doax server", "/packages": "Code Repository", "/auth": "Auth Server" };
        for (const [path, component] of Object.entries(paths)) {
            const body = await (await server.app.request(path)).json();
            expect(body).toMatchObject({ component, manifesto: "https://registry.corp.internal/manifesto.json" });
        }
    });

    it("answers health with the storage backend", async () => {
        expect(await (await server.app.request("/healthz")).json()).toMatchObject({ status: "ok", storage: "sqlite" });
    });

    it("serves one manifesto that lists where each component lives", async () => {
        expect(await (await server.app.request("/manifesto.json")).json()).toMatchObject({
            operator: "Corp IT",
            components: { registry: "/", codeRepository: "/packages", auth: "/auth" },
        });
    });

    it("returns a manifesto-bearing 404 for unknown paths anywhere", async () => {
        for (const path of ["/nope", "/auth/nope", "/packages/nope"]) {
            const res = await server.app.request(path);
            expect(res.status).toBe(404);
            expect((await res.json()).manifesto).toBe("https://registry.corp.internal/manifesto.json");
        }
    });

    it("refuses storage backends that are not implemented", () => {
        expect(() =>
            createServer(loadServerConfig({ DOAX_STORAGE: "postgres", DOAX_POSTGRES_URL: "postgres://x" })),
        ).toThrow(/not implemented/);
    });
});

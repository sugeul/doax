import { expect, it } from "vitest";
import { createRegistryApp } from "./app.ts";
import { IN_MEMORY } from "./storage/sqlite.ts";

const { app } = createRegistryApp({ domain: "doax.test", operator: "test", databasePath: IN_MEMORY, upstream: null });

it("includes the manifesto field in every JSON response", async () => {
    for (const path of ["/", "/no-such-path"]) {
        const body = await (await app.request(path)).json();
        expect(body.manifesto).toBe("https://doax.test/manifesto.json");
    }
});

it("reports its storage backend and upstream", async () => {
    expect(await (await app.request("/")).json()).toMatchObject({ storage: "sqlite", upstream: null });
});

it("serves a static manifesto.json", async () => {
    const res = await app.request("/manifesto.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ component: expect.stringContaining("Registry Server") });
});

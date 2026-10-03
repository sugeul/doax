import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCodeRepositoryApp } from "./app.ts";

const app = createCodeRepositoryApp({
    domain: "doax.test",
    operator: "test",
    packagesDir: join(mkdtempSync(join(tmpdir(), "doax-packages-")), "packages"),
});

it("includes the manifesto field in every JSON response", async () => {
    for (const path of ["/", "/no-such-path"]) {
        const body = await (await app.request(path)).json();
        expect(body.manifesto).toBe("https://doax.test/manifesto.json");
    }
});

it("serves a static manifesto.json", async () => {
    const res = await app.request("/manifesto.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ component: expect.stringContaining("Code Repository") });
});

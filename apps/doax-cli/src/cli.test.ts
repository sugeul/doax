import { describe, expect, it } from "vitest";
import { type CliDeps, run, VERSION } from "./cli.ts";

const deps = (fetchImpl: typeof fetch): CliDeps => ({ config: { registry: "https://registry.test" }, fetch: fetchImpl });

describe("doax cli", () => {
    it("prints the version", async () => {
        expect(await run(["--version"])).toEqual({ exitCode: 0, stdout: VERSION });
    });

    it("prints usage with no arguments", async () => {
        expect((await run([])).stdout).toContain("Usage:");
    });

    it("parses a resource reference", async () => {
        const result = await run(["ref", "@corp/orders@1.2.0"]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout!)).toEqual({
            namespace: "corp",
            name: "orders",
            version: "1.2.0",
            canonical: "@corp/orders@1.2.0",
        });
    });

    it("fails on a malformed reference", async () => {
        expect((await run(["ref", "corp/orders"])).exitCode).toBe(1);
    });

    it("reports registry status", async () => {
        const fetchImpl = (async (url: string | URL | Request) => {
            expect(String(url)).toBe("https://registry.test/");
            return Response.json({ component: "doax server", status: "ok" });
        }) as typeof fetch;
        const result = await run(["status"], deps(fetchImpl));
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout!)).toMatchObject({ registry: "https://registry.test", reachable: true, component: "doax server" });
    });

    it("reports an unreachable registry without throwing", async () => {
        const fetchImpl = (async () => {
            throw new Error("ECONNREFUSED");
        }) as typeof fetch;
        const result = await run(["status"], deps(fetchImpl));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("unreachable");
    });

    it("rejects unknown commands", async () => {
        expect((await run(["frobnicate"])).exitCode).toBe(2);
    });
});

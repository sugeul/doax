import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserCommand, type CliDeps, run, VERSION } from "./cli.ts";

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

    it("logs in via --web by catching the token on a loopback callback", async () => {
        const home = mkdtempSync(join(tmpdir(), "doax-web-"));
        try {
            const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
                const url = String(input);
                if (url.endsWith("/auth/methods")) return Response.json({ methods: ["web", "token"], web: { login: "/auth/login" } });
                if (url.endsWith("/whoami")) {
                    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer doax_pat_web");
                    return Response.json({ principal: "alice@example.com", namespaces: ["@alice"] });
                }
                throw new Error(`unexpected fetch ${url}`);
            }) as typeof fetch;
            const openUrl = async (loginUrl: string) => {
                const u = new URL(loginUrl);
                await fetch(u.searchParams.get("callback")!, {
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ token: "doax_pat_web", state: u.searchParams.get("state")! }),
                });
            };
            const result = await run(["login", "--web", "--registry", "https://registry.test", "--json"], {
                config: { registry: "https://registry.test" },
                fetch: fetchImpl,
                home,
                openUrl,
            });
            expect(result.exitCode).toBe(0);
            expect(JSON.parse(result.stdout!)).toMatchObject({ ok: true, principal: "alice@example.com", registry: "https://registry.test" });
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("reports when the registry does not offer web login", async () => {
        const fetchImpl = (async (input: string | URL | Request) => {
            if (String(input).endsWith("/auth/methods")) return new Response("not found", { status: 404 });
            throw new Error("unexpected fetch");
        }) as typeof fetch;
        const result = await run(["login", "--web", "--registry", "https://registry.test"], deps(fetchImpl));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("does not offer web login");
    });

    it("rejects --web combined with --token", async () => {
        const fetchImpl = (async () => {
            throw new Error("no fetch expected");
        }) as typeof fetch;
        const result = await run(["login", "--web", "--token", "x", "--registry", "https://registry.test"], deps(fetchImpl));
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("cannot be combined");
    });

    it("issues a resource token at the resource's tokens path with the login token", async () => {
        const home = mkdtempSync(join(tmpdir(), "doax-rt-"));
        try {
            writeFileSync(join(home, "config.json"), JSON.stringify({ tokens: { "https://registry.test": "doax_pat_t" } }));
            const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
                expect(String(input)).toBe("https://registry.test/@corp/orders/tokens");
                expect(init?.method).toBe("POST");
                expect((init?.headers as Record<string, string>).authorization).toBe("Bearer doax_pat_t");
                return Response.json({ resource: "@corp/orders", tokenId: "0123456789abcdef", token: "doax_rt_x" }, { status: 201 });
            }) as typeof fetch;
            const result = await run(["resource-token", "issue", "@corp/orders"], { config: { registry: "https://registry.test" }, fetch: fetchImpl, home });
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("doax_rt_x");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("whoami fans out to the default registry and every on-prem registry you hold a token for", async () => {
        const home = mkdtempSync(join(tmpdir(), "doax-whoami-"));
        try {
            writeFileSync(
                join(home, "config.json"),
                JSON.stringify({
                    registries: { default: "https://registry.test", "@corp": "https://registry.corp.internal" },
                    tokens: { "https://registry.test": "doax_pat_global", "https://registry.corp.internal": "doax_pat_corp" },
                }),
            );
            const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
                const url = String(input);
                const auth = (init?.headers as Record<string, string>).authorization;
                if (url === "https://registry.test/whoami" && auth === "Bearer doax_pat_global")
                    return Response.json({ principal: "alice@example.com", namespaces: ["@alice"] });
                if (url === "https://registry.corp.internal/whoami" && auth === "Bearer doax_pat_corp")
                    return Response.json({ principal: "alice@corp", namespaces: ["@corp"] });
                throw new Error(`unexpected fetch ${url} (${auth})`);
            }) as typeof fetch;
            const result = await run(["whoami", "--json"], { config: { registry: "https://registry.test" }, fetch: fetchImpl, home });
            expect(result.exitCode).toBe(0);
            expect(JSON.parse(result.stdout!)).toEqual({
                ok: true,
                registries: [
                    { registry: "https://registry.test", principal: "alice@example.com", namespaces: ["@alice"] },
                    { registry: "https://registry.corp.internal", principal: "alice@corp", namespaces: ["@corp"] },
                ],
            });
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("whoami --registry targets just that one registry", async () => {
        const home = mkdtempSync(join(tmpdir(), "doax-whoami-reg-"));
        try {
            writeFileSync(
                join(home, "config.json"),
                JSON.stringify({
                    registries: { default: "https://registry.test", "@corp": "https://registry.corp.internal" },
                    tokens: { "https://registry.test": "doax_pat_global", "https://registry.corp.internal": "doax_pat_corp" },
                }),
            );
            const fetchImpl = (async (input: string | URL | Request) => {
                expect(String(input)).toBe("https://registry.corp.internal/whoami");
                return Response.json({ principal: "alice@corp", namespaces: ["@corp"] });
            }) as typeof fetch;
            const result = await run(["whoami", "--registry", "https://registry.corp.internal", "--json"], {
                config: { registry: "https://registry.test" },
                fetch: fetchImpl,
                home,
            });
            expect(result.exitCode).toBe(0);
            expect(JSON.parse(result.stdout!)).toEqual({
                ok: true,
                registries: [{ registry: "https://registry.corp.internal", principal: "alice@corp", namespaces: ["@corp"] }],
            });
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("opens the browser without a shell, so & in the login URL survives on Windows", () => {
        const url = "https://registry.test/auth/login?callback=http%3A%2F%2F127.0.0.1%3A5%2Fx&state=abc";
        expect(browserCommand(url, "win32")).toEqual({ command: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
        expect(browserCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
        expect(browserCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
    });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_CONFIG, GOOGLE_OIDC_ISSUER, loadServerConfig } from "./server.ts";

describe("loadServerConfig", () => {
    it("defaults to embedded sqlite, Google OIDC, and no upstream", () => {
        const config = loadServerConfig();
        expect(config).toEqual(DEFAULT_SERVER_CONFIG);
        expect(config.storage).toEqual({ kind: "sqlite" });
        expect(config.upstream).toBeNull();
        expect(config.auth.oidcIssuer).toBe(GOOGLE_OIDC_ISSUER);
    });

    it("lets environment override the file, and the file override defaults", () => {
        const config = loadServerConfig(
            { DOAX_DOMAIN: "https://registry.corp.internal", DOAX_UPSTREAM: "https://doax.ai" },
            { domain: "https://ignored.example", operator: "Corp IT", auth: { oidcIssuer: "https://sso.corp.internal" } },
        );
        expect(config.domain).toBe("https://registry.corp.internal");
        expect(config.operator).toBe("Corp IT");
        expect(config.upstream).toBe("https://doax.ai");
        expect(config.auth).toEqual({ oidcIssuer: "https://sso.corp.internal", clientId: null });
    });

    it("follows the port into the default domain", () => {
        expect(loadServerConfig({ PORT: "9000" }).domain).toBe("http://localhost:9000");
    });

    it("requires a URL for postgres", () => {
        expect(() => loadServerConfig({ DOAX_STORAGE: "postgres" })).toThrow(/DOAX_POSTGRES_URL/);
        expect(loadServerConfig({ DOAX_STORAGE: "postgres", DOAX_POSTGRES_URL: "postgres://x" }).storage).toEqual({
            kind: "postgres",
            url: "postgres://x",
        });
    });

    it("rejects bad ports and unknown storage kinds", () => {
        expect(() => loadServerConfig({ PORT: "abc" })).toThrow(/PORT/);
        expect(() => loadServerConfig({ DOAX_STORAGE: "dynamo" })).toThrow(/DOAX_STORAGE/);
    });
});

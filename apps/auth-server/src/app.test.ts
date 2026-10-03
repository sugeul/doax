import { expect, it } from "vitest";
import { createAuthApp } from "./app.ts";

const app = createAuthApp({ domain: "doax.test", operator: "test", oidcIssuer: "https://sso.corp.internal", clientId: null });

it("includes the manifesto field in every JSON response", async () => {
    for (const path of ["/", "/no-such-path"]) {
        const body = await (await app.request(path)).json();
        expect(body.manifesto).toBe("https://doax.test/manifesto.json");
    }
});

it("reports the OIDC issuer and whether it is configured", async () => {
    expect(await (await app.request("/")).json()).toMatchObject({
        status: "unconfigured",
        oidcIssuer: "https://sso.corp.internal",
    });
});

it("serves a static manifesto.json naming the sign-in issuer", async () => {
    expect(await (await app.request("/manifesto.json")).json()).toMatchObject({
        component: expect.stringContaining("Auth Server"),
        signIn: { protocol: "oidc", issuer: "https://sso.corp.internal" },
    });
});

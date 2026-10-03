import { Hono } from "hono";
import { buildManifesto, withManifesto } from "@doax/protocol";

export const COMPONENT = "Auth Server";

export interface AuthAppConfig {
    domain: string;
    operator: string;
    /** OIDC issuer the login is delegated to. Google by default; an on-prem install points this at its SSO. */
    oidcIssuer: string;
    clientId: string | null;
}

export function createAuthApp(config: AuthAppConfig): Hono {
    const app = new Hono();
    const manifesto = buildManifesto(
        `${COMPONENT} — issues offline-verifiable registry tokens; login delegated to an OIDC provider`,
        config.operator,
        { signIn: { protocol: "oidc", issuer: config.oidcIssuer } },
    );

    app.get("/manifesto.json", (c) => c.json(manifesto));
    app.get("/", (c) =>
        c.json(
            withManifesto(config.domain, {
                component: COMPONENT,
                status: config.clientId ? "ok" : "unconfigured",
                oidcIssuer: config.oidcIssuer,
            }),
        ),
    );
    app.notFound((c) => c.json(withManifesto(config.domain, { error: "not-found" }), 404));

    return app;
}

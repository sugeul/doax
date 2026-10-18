/**
  * @doax/onedrive-login — authenticator for OneDrive via Microsoft Graph (spec §4.7).
  * Subject: personal. Interaction: secret-entry (a Microsoft OAuth refresh token).
  *
  * A user mints a refresh token once at https://auth.doax.io?appid=@doax/onedrive-login (the
  * consent-redirect mirror), stores it (e.g. in .env), and pastes it here. This module exchanges
  * that refresh token for a short-lived access token using the OAuth *client* (client_id/
  * client_secret) that it reads from AWS Secrets Manager via the local aws-cli. The access token
  * is what every @doax/onedrive-* data-source consumes as context.credential.token; `refresh`
  * mints a fresh one from the same refresh token.
  *
  * Scope the refresh token carries: offline_access Files.Read User.Read (read-only).
  */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GRAPH = "https://graph.microsoft.com/v1.0";
// Operator-substitutable: where the OAuth client lives and which local profile reaches it.
const SECRET_ID = "doax-adapter-onedrive";
const REGION = "ap-northeast-2";
const AWS_PROFILE = "doax";
const SCOPE = "offline_access Files.Read User.Read";
const AUTH_URL = "https://auth.doax.io?appid=@doax/onedrive-login";

function graphFault(status, body, retryAfter) {
    const code = body?.error?.code ?? null;
    const message = body?.error?.message ?? "";
    if (status === 401) return Object.assign(new Error(`invalid-auth: ${code ?? "token rejected"}`), { faultClass: "invalid-auth", graphError: code });
    if (status === 403) {
        if (code === "Authorization_RequestDenied" || /scope|permission|consent/i.test(message)) {
            return Object.assign(new Error("missing-scope: the signed-in app lacks a required Microsoft Graph permission"), {
                faultClass: "missing-scope",
                detail: { neededScope: SCOPE, graphMessage: message || null, fix: `re-consent at ${AUTH_URL} so the token carries the Files.Read scope, then re-authenticate (doax auth set @doax/onedrive-login --secret <refresh-token>)` },
            });
        }
        return Object.assign(new Error(`access-denied: ${code ?? "forbidden"}`), { faultClass: "access-denied", graphError: code });
    }
    if (status === 429) return Object.assign(new Error("rate-limited: Microsoft Graph throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
    if (status === 404) return Object.assign(new Error(`not-found: ${code ?? "resource not found"}`), { faultClass: "not-found", graphError: code });
    if (status >= 500) return Object.assign(new Error(`graph-unavailable: HTTP ${status}`), { faultClass: "graph-unavailable" });
    return Object.assign(new Error(`graph-error: ${code ?? status}`), { faultClass: "graph-error", graphError: code });
}

/** Read the OAuth client (client_id/client_secret/token_uri) from AWS Secrets Manager via aws-cli. */
async function loadClient() {
    let stdout;
    try {
        ({ stdout } = await execFileAsync(
            "aws",
            ["secretsmanager", "get-secret-value", "--secret-id", SECRET_ID, "--region", REGION, "--profile", AWS_PROFILE, "--query", "SecretString", "--output", "text"],
            { maxBuffer: 1 << 20 },
        ));
    } catch (error) {
        throw Object.assign(new Error(`invalid-auth: could not read the OAuth client from AWS Secrets Manager (${SECRET_ID})`), {
            faultClass: "invalid-auth",
            detail: {
                stderr: (error?.stderr ?? "").toString().trim() || null,
                fix: `ensure the local aws-cli can read ${SECRET_ID} in ${REGION} (profile ${AWS_PROFILE}): aws secretsmanager get-secret-value --secret-id ${SECRET_ID} --profile ${AWS_PROFILE}`,
            },
        });
    }
    let client;
    try {
        const secret = JSON.parse(stdout);
        client = secret.web ?? secret.installed ?? secret;
    } catch {
        throw Object.assign(new Error("invalid-auth: the OneDrive OAuth secret is not valid JSON"), { faultClass: "invalid-auth" });
    }
    if (!client.client_id || !client.client_secret) {
        throw Object.assign(new Error("invalid-auth: the OneDrive OAuth secret has no client_id/client_secret"), { faultClass: "invalid-auth" });
    }
    const tenant = client.tenant ?? "common";
    return { clientId: client.client_id, clientSecret: client.client_secret, tokenUri: client.token_uri ?? `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token` };
}

/** Exchange a refresh token for a short-lived access token (OAuth 2.0 refresh_token grant). */
async function exchangeRefresh(client, refreshToken) {
    let res;
    try {
        res = await fetch(client.tokenUri, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: client.clientId,
                client_secret: client.clientSecret,
                refresh_token: refreshToken,
                grant_type: "refresh_token",
                scope: SCOPE,
            }).toString(),
        });
    } catch {
        throw Object.assign(new Error("graph-unavailable: network failure reaching the Microsoft token endpoint"), { faultClass: "graph-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw Object.assign(new Error(`invalid-auth: refresh failed (${body.error ?? res.status})`), {
            faultClass: "invalid-auth",
            detail: { fix: `re-mint a refresh token at ${AUTH_URL} and re-authenticate (doax auth set @doax/onedrive-login --secret <refresh-token>)` },
        });
    }
    return body; // { access_token, expires_in, scope, token_type, refresh_token? }
}

/** verify-only Graph call; no side effects (§4.7.1 verification method). */
async function me(token) {
    let res;
    try {
        res = await fetch(`${GRAPH}/me`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw Object.assign(new Error("graph-unavailable: network failure reaching Microsoft Graph"), { faultClass: "graph-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw graphFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

function principalOf(who) {
    return { user: who.displayName ?? null, userId: who.id ?? null, upn: who.userPrincipalName ?? who.mail ?? null };
}

function lifetimeOf(cred) {
    return { period: cred?.expiresAt ? `until ${cred.expiresAt}` : "unknown", refreshable: Boolean(cred?.refreshToken) };
}

export function describe() {
    return {
        identity: "@doax/onedrive-login",
        kind: "authenticator",
        subject: "personal",
        interaction: "secret-entry",
        target: "OneDrive via Microsoft Graph (https://graph.microsoft.com) through the Microsoft identity platform",
    };
}

/**
  * modes (spec §4.7): initial | refresh | verify | step-up.
  * initial/step-up take input.secret (the refresh token) and exchange it for an access token;
  * refresh re-exchanges the cached refresh token; verify re-checks the cached access token.
  */
export async function authenticate(input, context) {
    const mode = input?.mode ?? "initial";

    if (mode === "verify") {
        const token = context?.credential?.token;
        if (!token) throw Object.assign(new Error("invalid-auth: verify has no cached credential"), { faultClass: "invalid-auth" });
        const who = await me(token);
        return { status: "complete", credential: context.credential, principal: principalOf(who), lifetime: lifetimeOf(context.credential) };
    }

    const refreshToken = mode === "initial" || mode === "step-up" ? input?.secret : context?.credential?.refreshToken;
    if (!refreshToken) {
        throw Object.assign(new Error(`invalid-auth: mode ${mode} has no refresh token to work with`), {
            faultClass: "invalid-auth",
            detail: { fix: `open ${AUTH_URL} to mint one, then: doax auth set @doax/onedrive-login --secret <refresh-token>` },
        });
    }

    const client = await loadClient();
    const tok = await exchangeRefresh(client, refreshToken);
    const who = await me(tok.access_token);
    const expiresAt = new Date(Date.now() + Number(tok.expires_in ?? 0) * 1000).toISOString();
    // Microsoft may rotate the refresh token on each exchange; keep the newest.
    const credential = { kind: "oauth-bearer", token: tok.access_token, refreshToken: tok.refresh_token ?? refreshToken, expiresAt, scope: tok.scope ?? SCOPE };
    return { status: "complete", credential, principal: principalOf(who), lifetime: lifetimeOf(credential) };
}

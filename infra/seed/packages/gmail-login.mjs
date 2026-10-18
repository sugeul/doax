/**
  * @doax/gmail-login — shared authenticator for Google user APIs (spec §4.7).
  * Subject: personal. Interaction: secret-entry (a Google OAuth refresh token).
  *
  * One login for Gmail, Calendar, Contacts (People) and Tasks: the user consents once at
  * https://auth.doax.io?appid=@doax/gmail-login and pastes the refresh token here. This module
  * exchanges it for a short-lived access token using the OAuth client it reads from AWS Secrets
  * Manager (doax-adapter-gmail) via the local aws-cli. Every @doax/{gmail,calendar,contacts,
  * tasks}-* resource references this authenticator, so one login serves them all.
  *
  * Scopes the refresh token carries (all read-only):
  *   openid email offline_access gmail.readonly calendar.readonly contacts.readonly tasks.readonly
  */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";
// Operator-substitutable: where the OAuth client lives and which local profile reaches it.
const SECRET_ID = "doax-adapter-gmail";
const REGION = "ap-northeast-2";
const AWS_PROFILE = "doax";
const SCOPE = "openid email offline_access https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/tasks.readonly";
const AUTH_URL = "https://auth.doax.io?appid=@doax/gmail-login";

function googleFault(status, body, retryAfter) {
    const err = body?.error;
    const reason = Array.isArray(err?.errors) ? err.errors[0]?.reason : null;
    const message = (typeof err === "string" ? err : err?.message) ?? "";
    if (status === 401) return Object.assign(new Error(`invalid-auth: ${reason ?? "token rejected"}`), { faultClass: "invalid-auth", googleError: reason });
    if (status === 403) {
        if (reason === "accessNotConfigured" || /accessNotConfigured|has not been used in project|is disabled/i.test(message)) {
            return Object.assign(new Error("access-denied: a required Google API is not enabled for this OAuth client's project"), {
                faultClass: "access-denied",
                googleError: reason,
                detail: { fix: "enable the Gmail/Calendar/People/Tasks APIs in the Cloud project of the doax-adapter-gmail OAuth client (console.cloud.google.com → APIs & Services), then retry" },
            });
        }
        if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") return Object.assign(new Error("rate-limited: Google throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
        if (reason === "insufficientPermissions" || /insufficient.*scope/i.test(message)) {
            return Object.assign(new Error("missing-scope: the refresh token lacks a required scope"), {
                faultClass: "missing-scope",
                detail: { neededScope: SCOPE, googleMessage: message || null, fix: `re-consent at ${AUTH_URL}, then re-authenticate (doax auth set @doax/gmail-login --secret <refresh-token>)` },
            });
        }
        return Object.assign(new Error(`access-denied: ${reason ?? "forbidden"}`), { faultClass: "access-denied", googleError: reason });
    }
    if (status === 429) return Object.assign(new Error("rate-limited: Google throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
    if (status >= 500) return Object.assign(new Error(`google-unavailable: HTTP ${status}`), { faultClass: "google-unavailable" });
    return Object.assign(new Error(`google-error: ${reason ?? status}`), { faultClass: "google-error", googleError: reason });
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
        throw Object.assign(new Error("invalid-auth: the Google OAuth secret is not valid JSON"), { faultClass: "invalid-auth" });
    }
    if (!client.client_id || !client.client_secret) {
        throw Object.assign(new Error("invalid-auth: the Google OAuth secret has no client_id/client_secret"), { faultClass: "invalid-auth" });
    }
    return { clientId: client.client_id, clientSecret: client.client_secret, tokenUri: client.token_uri ?? "https://oauth2.googleapis.com/token" };
}

/** Exchange a refresh token for a short-lived access token (OAuth 2.0 refresh_token grant). */
async function exchangeRefresh(client, refreshToken) {
    let res;
    try {
        res = await fetch(client.tokenUri, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
        });
    } catch {
        throw Object.assign(new Error("google-unavailable: network failure reaching the Google token endpoint"), { faultClass: "google-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw Object.assign(new Error(`invalid-auth: refresh failed (${body.error ?? res.status})`), {
            faultClass: "invalid-auth",
            detail: { fix: `re-mint a refresh token at ${AUTH_URL} and re-authenticate (doax auth set @doax/gmail-login --secret <refresh-token>)` },
        });
    }
    return body; // { access_token, expires_in, scope, token_type }
}

/** verify-only call; no side effects (§4.7.1). Returns the signed-in identity. */
async function userinfo(token) {
    let res;
    try {
        res = await fetch(USERINFO, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw Object.assign(new Error("google-unavailable: network failure reaching Google"), { faultClass: "google-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw googleFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

function principalOf(who) {
    return { user: who.name ?? null, emailAddress: who.email ?? null, sub: who.sub ?? null };
}

function lifetimeOf(cred) {
    return { period: cred?.expiresAt ? `until ${cred.expiresAt}` : "unknown", refreshable: Boolean(cred?.refreshToken) };
}

export function describe() {
    return {
        identity: "@doax/gmail-login",
        kind: "authenticator",
        subject: "personal",
        interaction: "secret-entry",
        target: "Google user APIs (Gmail, Calendar, People, Tasks) via Google OAuth 2.0",
    };
}

/** modes (spec §4.7): initial | refresh | verify | step-up. */
export async function authenticate(input, context) {
    const mode = input?.mode ?? "initial";

    if (mode === "verify") {
        const token = context?.credential?.token;
        if (!token) throw Object.assign(new Error("invalid-auth: verify has no cached credential"), { faultClass: "invalid-auth" });
        const who = await userinfo(token);
        return { status: "complete", credential: context.credential, principal: principalOf(who), lifetime: lifetimeOf(context.credential) };
    }

    const refreshToken = mode === "initial" || mode === "step-up" ? input?.secret : context?.credential?.refreshToken;
    if (!refreshToken) {
        throw Object.assign(new Error(`invalid-auth: mode ${mode} has no refresh token to work with`), {
            faultClass: "invalid-auth",
            detail: { fix: `open ${AUTH_URL} to mint one, then: doax auth set @doax/gmail-login --secret <refresh-token>` },
        });
    }

    const client = await loadClient();
    const tok = await exchangeRefresh(client, refreshToken);
    const who = await userinfo(tok.access_token);
    const expiresAt = new Date(Date.now() + Number(tok.expires_in ?? 0) * 1000).toISOString();
    const credential = { kind: "oauth-bearer", token: tok.access_token, refreshToken, expiresAt, scope: tok.scope ?? SCOPE };
    return { status: "complete", credential, principal: principalOf(who), lifetime: lifetimeOf(credential) };
}

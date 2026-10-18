/**
  * @doax/google-drive-login — authenticator for the Google Drive API (spec §4.7).
  * Subject: personal. Interaction: secret-entry (a Google OAuth refresh token).
  *
  * A user mints a refresh token once at https://auth.doax.io (the consent-redirect mirror),
  * stores it (e.g. in .env), and pastes it here. This module exchanges that refresh token for
  * a short-lived access token using the OAuth *client* (client_id/client_secret) that it reads
  * from AWS Secrets Manager via the local aws-cli — the client is operator-held and never the
  * caller's to enter. The access token is what every @doax/google-drive-* data-source consumes
  * as context.credential.token; `refresh` mints a fresh one from the same refresh token.
  *
  * The scope the refresh token already carries is https://www.googleapis.com/auth/drive.readonly;
  * this flow requests no new scopes.
  */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DRIVE = "https://www.googleapis.com/drive/v3";
// Operator-substitutable: where the OAuth client lives and which local profile reaches it.
const SECRET_ID = "doax-adapter-google-drive";
const REGION = "ap-northeast-2";
const AWS_PROFILE = "doax";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
// The refresh-token mirror, parameterized by this authenticator's identity.
const AUTH_URL = "https://auth.doax.io?appid=@doax/google-drive-login";

function driveFault(status, body, retryAfter) {
    const err = body?.error;
    const reason = Array.isArray(err?.errors) ? err.errors[0]?.reason : null;
    const message = (typeof err === "string" ? err : err?.message) ?? "";
    if (status === 401) return Object.assign(new Error(`invalid-auth: ${reason ?? "token rejected"}`), { faultClass: "invalid-auth", driveError: reason });
    if (status === 403) {
        if (reason === "accessNotConfigured" || /accessNotConfigured|has not been used in project|is disabled/i.test(message)) {
            return Object.assign(new Error("access-denied: the Google Drive API is not enabled for this OAuth client's project"), {
                faultClass: "access-denied",
                driveError: reason,
                detail: { fix: "enable the Drive API at https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=doax-drive-adapter (one-time; wait ~1-2 min to propagate)" },
            });
        }
        if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
            return Object.assign(new Error("rate-limited: Google Drive throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
        }
        if (reason === "insufficientPermissions" || /insufficient.*scope/i.test(message)) {
            return Object.assign(new Error("missing-scope: the refresh token lacks the Drive scope this operation needs"), {
                faultClass: "missing-scope",
                detail: {
                    neededScope: SCOPE,
                    driveMessage: message || null,
                    fix: `re-consent at ${AUTH_URL} so the token carries drive.readonly, then re-authenticate (doax auth set @doax/google-drive-login --secret <refresh-token>)`,
                },
            });
        }
        return Object.assign(new Error(`access-denied: ${reason ?? "forbidden"}`), { faultClass: "access-denied", driveError: reason });
    }
    if (status === 429) return Object.assign(new Error("rate-limited: Google Drive throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
    if (status >= 500) return Object.assign(new Error(`drive-unavailable: HTTP ${status}`), { faultClass: "drive-unavailable" });
    return Object.assign(new Error(`drive-error: ${reason ?? status}`), { faultClass: "drive-error", driveError: reason });
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
        throw Object.assign(new Error("invalid-auth: the Drive OAuth secret is not valid JSON"), { faultClass: "invalid-auth" });
    }
    if (!client.client_id || !client.client_secret) {
        throw Object.assign(new Error("invalid-auth: the Drive OAuth secret has no client_id/client_secret"), { faultClass: "invalid-auth" });
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
            body: new URLSearchParams({
                client_id: client.clientId,
                client_secret: client.clientSecret,
                refresh_token: refreshToken,
                grant_type: "refresh_token",
            }).toString(),
        });
    } catch {
        throw Object.assign(new Error("drive-unavailable: network failure reaching the Google token endpoint"), { faultClass: "drive-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        // invalid_grant: the refresh token is expired, revoked, or wrong.
        throw Object.assign(new Error(`invalid-auth: refresh failed (${body.error ?? res.status})`), {
            faultClass: "invalid-auth",
            detail: { fix: `re-mint a refresh token at ${AUTH_URL} and re-authenticate (doax auth set @doax/google-drive-login --secret <refresh-token>)` },
        });
    }
    return body; // { access_token, expires_in, scope, token_type }
}

/** verify-only Drive call; no side effects (§4.7.1 verification method). */
async function about(token) {
    let res;
    try {
        res = await fetch(`${DRIVE}/about?fields=user`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw Object.assign(new Error("drive-unavailable: network failure reaching Google Drive"), { faultClass: "drive-unavailable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw driveFault(res.status, body, res.headers.get("retry-after"));
    return body;
}

function principalOf(who) {
    return { user: who.user?.displayName ?? null, emailAddress: who.user?.emailAddress ?? null };
}

function lifetimeOf(cred) {
    return { period: cred?.expiresAt ? `until ${cred.expiresAt}` : "unknown", refreshable: Boolean(cred?.refreshToken) };
}

export function describe() {
    return {
        identity: "@doax/google-drive-login",
        kind: "authenticator",
        subject: "personal",
        interaction: "secret-entry",
        target: "Google Drive API (https://www.googleapis.com/drive/v3) via Google OAuth 2.0",
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
        const who = await about(token);
        return { status: "complete", credential: context.credential, principal: principalOf(who), lifetime: lifetimeOf(context.credential) };
    }

    const refreshToken = mode === "initial" || mode === "step-up" ? input?.secret : context?.credential?.refreshToken;
    if (!refreshToken) {
        throw Object.assign(new Error(`invalid-auth: mode ${mode} has no refresh token to work with`), {
            faultClass: "invalid-auth",
            detail: { fix: `open ${AUTH_URL} to mint one, then: doax auth set @doax/google-drive-login --secret <refresh-token>` },
        });
    }

    const client = await loadClient();
    const tok = await exchangeRefresh(client, refreshToken);
    const who = await about(tok.access_token);
    const expiresAt = new Date(Date.now() + Number(tok.expires_in ?? 0) * 1000).toISOString();
    const credential = { kind: "oauth-bearer", token: tok.access_token, refreshToken, expiresAt, scope: tok.scope ?? SCOPE };
    return { status: "complete", credential, principal: principalOf(who), lifetime: lifetimeOf(credential) };
}

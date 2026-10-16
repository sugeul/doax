/**
  * @doax/teams-login — authenticator for Microsoft Graph (spec §4.7).
  * Subject: personal. Interaction: device-code (OAuth 2.0 device authorization grant).
  * Unlike slack-login's secret-entry, this drives a real OAuth flow across several
  * authenticate() calls: the Executor CLI shows the user code, the user signs in
  * elsewhere, and the CLI polls until a token is issued. Tokens are refreshable, so
  * refresh mode exchanges the cached refresh token with no user interaction.
  *
  * authenticate() returns one of three states (the CLI dispatches on `status`):
  *   interaction-required -> display `interaction`, then re-call with input.deviceCode
  *   pending              -> keep polling (honour pollInterval; back off on slowDown)
  *   complete             -> { credential, principal, lifetime }, as slack-login returns
  *
  * clientId/tenant below are public identifiers, not secrets; an operator substitutes
  * their own Entra ID app registration (a public client with device-code enabled).
  */

const GRAPH = "https://graph.microsoft.com/v1.0";
const AUTHORITY = "https://login.microsoftonline.com";
const TENANT = "organizations"; // or a specific tenant id
const CLIENT_ID = "00000000-0000-0000-0000-000000000000"; // operator substitutes their Entra app registration
const SCOPE = "offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send";

function graphFault(status, body, retryAfter) {
    const code = body?.error?.code ?? null;
    const message = body?.error?.message ?? "";
    if (status === 401) {
        return Object.assign(new Error(`invalid-auth: ${code ?? "token rejected"}`), { faultClass: "invalid-auth", graphError: code });
    }
    if (status === 403) {
        if (code === "Authorization_RequestDenied" || /scope|permission|consent/i.test(message)) {
            return Object.assign(new Error("missing-scope: the signed-in app lacks a required Microsoft Graph permission"), {
                faultClass: "missing-scope",
                detail: {
                    neededScope: null,
                    graphMessage: message || null,
                    fix: "grant the delegated permission at https://portal.azure.com → Entra ID → App registrations → your app → API permissions (admin-consent if required), then re-authenticate (doax auth set @doax/teams-login)",
                },
            });
        }
        return Object.assign(new Error(`access-denied: ${code ?? "forbidden"}`), {
            faultClass: "access-denied",
            graphError: code,
            detail: { fix: "the signed-in user is not a member of the target team/channel; join it or ask an owner to add you" },
        });
    }
    if (status === 429) return Object.assign(new Error("rate-limited: Microsoft Graph throttled the request"), { faultClass: "rate-limited", retryAfter: retryAfter ?? null });
    if (status === 404) {
        return Object.assign(new Error(`not-found: ${code ?? "team or channel id not found"}`), {
            faultClass: "not-found",
            graphError: code,
            detail: { fix: "check the team and channel ids (@doax/teams-list-team, @doax/teams-list-channel)" },
        });
    }
    if (status >= 500) return Object.assign(new Error(`graph-unavailable: HTTP ${status}`), { faultClass: "graph-unavailable" });
    return Object.assign(new Error(`graph-error: ${code ?? status}`), { faultClass: "graph-error", graphError: code });
}

/** Microsoft identity platform token/devicecode endpoints speak form-urlencoded. */
async function form(endpoint, params) {
    let res;
    try {
        res = await fetch(`${AUTHORITY}/${TENANT}/oauth2/v2.0/${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString(),
        });
    } catch {
        throw Object.assign(new Error("graph-unavailable: network failure reaching the Microsoft identity platform"), { faultClass: "graph-unavailable" });
    }
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
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
    return { user: who.displayName ?? null, userId: who.id ?? null, upn: who.userPrincipalName ?? null };
}

function lifetimeOf(cred) {
    return { period: cred?.expiresAt ? `until ${cred.expiresAt}` : "unknown", refreshable: Boolean(cred?.refreshToken) };
}

async function completeFromToken(tok) {
    const who = await me(tok.access_token);
    const expiresAt = new Date(Date.now() + Number(tok.expires_in ?? 0) * 1000).toISOString();
    const credential = { kind: "oauth-bearer", token: tok.access_token, refreshToken: tok.refresh_token ?? null, expiresAt, scope: tok.scope ?? null };
    return { status: "complete", credential, principal: principalOf(who), lifetime: lifetimeOf(credential) };
}

export function describe() {
    return {
        identity: "@doax/teams-login",
        kind: "authenticator",
        subject: "personal",
        interaction: "device-code",
        target: "Microsoft Graph (https://graph.microsoft.com) via the Microsoft identity platform",
    };
}

/**
  * modes (spec §4.7): initial | refresh | verify | step-up.
  * initial/step-up run the device-code flow (two calls: start, then poll with input.deviceCode).
  * refresh exchanges the cached refresh token; verify re-checks the cached access token via /me.
  */
export async function authenticate(input, context) {
    const mode = input?.mode ?? "initial";

    if (mode === "verify") {
        const token = context?.credential?.token;
        if (!token) throw Object.assign(new Error("invalid-auth: verify has no cached credential"), { faultClass: "invalid-auth" });
        const who = await me(token);
        return { status: "complete", credential: context.credential, principal: principalOf(who), lifetime: lifetimeOf(context.credential) };
    }

    if (mode === "refresh") {
        const refreshToken = context?.credential?.refreshToken;
        if (!refreshToken) throw Object.assign(new Error("invalid-auth: no refresh token cached; re-authenticate with mode initial"), { faultClass: "invalid-auth" });
        const { ok, body } = await form("token", { grant_type: "refresh_token", refresh_token: refreshToken, scope: SCOPE });
        if (!ok) {
            throw Object.assign(new Error(`invalid-auth: refresh failed (${body.error ?? "?"})`), {
                faultClass: "invalid-auth",
                detail: { fix: "re-authenticate with mode initial (doax auth set @doax/teams-login)" },
            });
        }
        return completeFromToken(body);
    }

    // initial | step-up — device-code flow, driven across calls by the Executor CLI.
    if (!input?.deviceCode) {
        const { ok, status, body } = await form("devicecode", { scope: SCOPE });
        if (!ok) throw Object.assign(new Error(`graph-error: device code request failed (${body.error ?? status})`), { faultClass: "graph-error" });
        return {
            status: "interaction-required",
            interaction: {
                kind: "device-code",
                userCode: body.user_code,
                verificationUri: body.verification_uri,
                message: body.message,
                expiresIn: body.expires_in,
                pollInterval: body.interval ?? 5,
            },
            resume: { deviceCode: body.device_code }, // the CLI passes this back as input.deviceCode to poll
        };
    }

    const { ok, body } = await form("token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: input.deviceCode });
    if (!ok) {
        if (body.error === "authorization_pending") return { status: "pending" };
        if (body.error === "slow_down") return { status: "pending", slowDown: true };
        const faultClass = body.error === "expired_token" || body.error === "authorization_declined" || body.error === "bad_verification_code" ? "invalid-auth" : "graph-error";
        throw Object.assign(new Error(`${faultClass}: ${body.error ?? "token exchange failed"}`), { faultClass });
    }
    return completeFromToken(body);
}

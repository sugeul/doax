/**
  * @doax/slack-login — authenticator for the Slack Web API (spec §4.7).
  * Subject: personal. Interaction: secret-entry (a Slack user or bot token).
  * The Executor CLI collects the secret and passes it as input; this module never stores it.
  */

const API = "https://slack.com/api";

async function slack(method, token, params = {}) {
    const res = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(params),
    });
    if (!res.ok) throw Object.assign(new Error(`slack-unavailable: HTTP ${res.status}`), { faultClass: "slack-unavailable" });
    const body = await res.json();
    if (!body.ok) {
        if (body.error === "missing_scope") {
            throw Object.assign(new Error(`missing-scope: the Slack token lacks a required permission (needed: ${body.needed ?? "?"})`), {
                faultClass: "missing-scope",
                detail: {
                    neededScope: body.needed ?? null,
                    providedScopes: body.provided ?? null,
                    fix: "add the scope at https://api.slack.com/apps → your app → OAuth & Permissions → Bot Token Scopes, reinstall the app, then retry (doax auth set @doax/slack-login --secret ... if the token rotated)",
                },
            });
        }
        const faultClass = body.error === "invalid_auth" || body.error === "token_revoked" ? "invalid-auth"
            : body.error === "ratelimited" ? "rate-limited" : "slack-error";
        throw Object.assign(new Error(`${faultClass}: ${body.error}`), { faultClass, slackError: body.error });
    }
    return body;
}

export function describe() {
    return {
        identity: "@doax/slack-login",
        kind: "authenticator",
        subject: "personal",
        interaction: "secret-entry",
        target: "Slack Web API (https://slack.com/api)",
    };
}

/**
  * modes (spec §4.7): initial | refresh | verify | step-up.
  * initial/step-up need input.secret (the token the user entered); verify/refresh use the
  * cached credential. Slack tokens are not refreshable: refresh re-verifies or fails.
  */
export async function authenticate(input, context) {
    const mode = input?.mode ?? "initial";
    const token = mode === "initial" || mode === "step-up" ? input?.secret : context?.credential?.token;
    if (!token) {
        throw Object.assign(new Error(`invalid-auth: mode ${mode} has no token to work with`), { faultClass: "invalid-auth" });
    }
    const who = await slack("auth.test", token);
    return {
        credential: { kind: "bearer-token", token },
        principal: { team: who.team, teamId: who.team_id, user: who.user, userId: who.user_id },
        lifetime: "unknown",
    };
}

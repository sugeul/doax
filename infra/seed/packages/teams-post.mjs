/**
  * @doax/teams-post — action (spec §6): post a message to a Teams channel.
  * Posts as the signed-in user (delegated token from teams-login), via
  * POST /teams/{team}/channels/{channel}/messages — or /messages/{id}/replies when
  * replyToId is given. dry-run mode: predictive — validates the token and echoes what
  * would be sent, with zero side effects (§6.1). Idempotency: non-idempotent — Graph has
  * no post dedupe, so the Executor must confirm retries (§6.2). The idempotency key is
  * recorded in audit only.
  */

const GRAPH = "https://graph.microsoft.com/v1.0";

function graphFault(status, body, retryAfter) {
    const code = body?.error?.code ?? null;
    const message = body?.error?.message ?? "";
    if (status === 401) return Object.assign(new Error(`invalid-auth: ${code ?? "token rejected"}`), { faultClass: "invalid-auth", graphError: code });
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

async function graph(path, token, { method = "GET", body } = {}) {
    let res;
    try {
        res = await fetch(`${GRAPH}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw Object.assign(new Error("graph-unavailable: network failure reaching Microsoft Graph"), { faultClass: "graph-unavailable" });
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw graphFault(res.status, payload, res.headers.get("retry-after"));
    return payload;
}

export function describe() {
    return {
        identity: "@doax/teams-post",
        kind: "action",
        effect: "posts one message to one Teams channel as the signed-in user",
        executeParams: {
            team: "team id (required)",
            channel: "channel id (required)",
            text: "message content (required)",
            contentType: "text | html (optional, default text)",
            replyToId: "reply under an existing message (optional)",
        },
    };
}

export async function dryRun(input, context) {
    const token = context?.credential?.token;
    if (!input?.team || !input?.channel || !input?.text) {
        throw Object.assign(new Error("graph-error: execute requires team, channel and text"), { faultClass: "graph-error" });
    }
    const who = await graph("/me", token);
    return {
        estimated: true,
        wouldPost: {
            team: input.team,
            channel: input.channel,
            text: input.text,
            contentType: input.contentType ?? "text",
            replyToId: input.replyToId ?? null,
            as: who.displayName ?? who.userPrincipalName ?? null,
        },
    };
}

export async function execute(input, context) {
    const token = context?.credential?.token;
    if (!input?.team || !input?.channel || !input?.text) {
        throw Object.assign(new Error("graph-error: execute requires team, channel and text"), { faultClass: "graph-error" });
    }
    const team = encodeURIComponent(input.team);
    const channel = encodeURIComponent(input.channel);
    const path = input.replyToId
        ? `/teams/${team}/channels/${channel}/messages/${encodeURIComponent(input.replyToId)}/replies`
        : `/teams/${team}/channels/${channel}/messages`;
    const body = { body: { contentType: input.contentType ?? "text", content: input.text } };
    const posted = await graph(path, token, { method: "POST", body });
    return { posted: { id: posted.id, webUrl: posted.webUrl ?? null }, idempotencyKey: context?.idempotencyKey ?? null };
}

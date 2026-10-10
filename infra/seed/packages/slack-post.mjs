/**
  * @doax/slack-post — action (spec §6): post a message to a Slack channel.
  * dry-run mode: predictive — validates the token and echoes what would be sent, with zero
  * side effects (§6.1). Idempotency: non-idempotent — Slack has no post dedupe, so the
  * Executor must confirm retries (§6.2). The idempotency key is recorded in audit only.
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
        const faultClass = body.error === "invalid_auth" || body.error === "token_revoked" ? "invalid-auth"
            : body.error === "ratelimited" ? "rate-limited"
            : body.error === "channel_not_found" || body.error === "not_in_channel" ? "channel-not-found" : "slack-error";
        throw Object.assign(new Error(`${faultClass}: ${body.error}`), { faultClass, slackError: body.error });
    }
    return body;
}

export function describe() {
    return {
        identity: "@doax/slack-post",
        kind: "action",
        effect: "posts one message to one Slack channel as the authenticated principal",
        executeParams: { channel: "channel id (required)", text: "message text (required)", thread_ts: "reply in thread (optional)" },
    };
}

export async function dryRun(input, context) {
    const token = context?.credential?.token;
    if (!input?.channel || !input?.text) {
        throw Object.assign(new Error("slack-error: execute requires channel and text"), { faultClass: "slack-error" });
    }
    const who = await slack("auth.test", token);
    return {
        estimated: true,
        wouldPost: { channel: input.channel, text: input.text, thread_ts: input.thread_ts ?? null, as: who.user },
    };
}

export async function execute(input, context) {
    const token = context?.credential?.token;
    if (!input?.channel || !input?.text) {
        throw Object.assign(new Error("slack-error: execute requires channel and text"), { faultClass: "slack-error" });
    }
    const params = { channel: input.channel, text: input.text };
    if (input.thread_ts) params.thread_ts = input.thread_ts;
    const body = await slack("chat.postMessage", token, params);
    return { posted: { channel: body.channel, ts: body.ts }, idempotencyKey: context?.idempotencyKey ?? null };
}

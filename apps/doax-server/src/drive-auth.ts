import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
  * auth.doax.io — the OAuth refresh-token mirror. A tiny, isolated service that runs an OAuth
  * consent-redirect once and hands the caller back a refresh token to paste into a @doax/*-login
  * authenticator (CLI) or their .env.
  *
  * It is a SEPARATE, non-VPC Lambda: the registry Lambda is VPC-attached with no public egress
  * (infra/terraform/vpc_endpoints.tf), so it cannot reach the providers' OAuth endpoints. This can.
  *
  * Provider-aware, keyed by ?appid=@ns/name (see PROVIDERS). One page serves Google Drive and
  * OneDrive today; add a provider by adding its secret + a PROVIDERS entry. Served at
  * https://auth.doax.io/ (the registered redirect_uri):
  *   GET /?appid=..            -> set a state cookie, 302 to the provider's consent screen
  *   GET /?code=...&state=..   -> verify state, exchange the code, render the token page
  *   GET /?error=...           -> render the error page (user declined, etc.)
  *
  * Each provider's OAuth client (client_id/client_secret) is read from AWS Secrets Manager at runtime.
  */

const REGION = process.env.DRIVE_SECRET_REGION ?? process.env.AWS_REGION ?? "ap-northeast-2";
const REDIRECT_URI = process.env.DRIVE_REDIRECT_URI ?? "https://auth.doax.io";

interface Provider {
    secretId: string;
    scope: string;
    /** Provider-specific authorize params beyond the OAuth basics. */
    authParams: Record<string, string>;
    /** A no-side-effect call that names the connected account for the success page. */
    verifyUrl: string;
    verifyAccount: (body: Record<string, unknown>) => string | null;
}

const PROVIDERS: Record<string, Provider> = {
    "@doax/google-drive-login": {
        secretId: "doax-adapter-google-drive",
        scope: "https://www.googleapis.com/auth/drive.readonly",
        authParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
        verifyUrl: "https://www.googleapis.com/drive/v3/about?fields=user",
        verifyAccount: (b) => ((b.user as { emailAddress?: string })?.emailAddress ?? null),
    },
    "@doax/onedrive-login": {
        secretId: "doax-adapter-onedrive",
        scope: "offline_access Files.Read User.Read",
        authParams: { prompt: "consent" },
        verifyUrl: "https://graph.microsoft.com/v1.0/me",
        verifyAccount: (b) => ((b.userPrincipalName as string) ?? (b.mail as string) ?? null),
    },
};

const DEFAULT_APPID = "@doax/google-drive-login";

interface OAuthClient {
    clientId: string;
    clientSecret: string;
    authUri: string;
    tokenUri: string;
}

const sm = new SecretsManagerClient({ region: REGION });
const clientCache = new Map<string, Promise<OAuthClient>>();

/** Read and memoize a provider's OAuth client from Secrets Manager (the `web` block). */
function loadClient(secretId: string): Promise<OAuthClient> {
    let cached = clientCache.get(secretId);
    if (!cached) {
        cached = (async () => {
            const out = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
            const parsed = JSON.parse(out.SecretString ?? "{}") as { web?: Record<string, string>; installed?: Record<string, string> };
            const web = parsed.web ?? parsed.installed ?? (parsed as Record<string, string>);
            if (!web.client_id || !web.client_secret) throw new Error(`${secretId}: no client_id/client_secret`);
            const tenant = web.tenant ?? "common";
            return {
                clientId: web.client_id,
                clientSecret: web.client_secret,
                authUri: web.auth_uri ?? `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
                tokenUri: web.token_uri ?? `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
            };
        })().catch((error) => {
            clientCache.delete(secretId); // let the next request retry a transient failure
            throw error;
        });
        clientCache.set(secretId, cached);
    }
    return cached;
}

/* ---------- doax design language (shared with the registry sign-in page) ---------- */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, inner: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · doax</title><style>
*{box-sizing:border-box}body{margin:0;display:grid;place-items:center;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
background:radial-gradient(120% 90% at 70% 0%,#0a1426 0%,#05080f 48%,#03050b 100%) fixed;color:#eaf1fb;padding:24px}
.card{width:min(560px,94vw);background:#0b1220;border:1px solid #182438;border-radius:16px;padding:28px}
h1{font-size:19px;margin:0 0 4px;display:flex;gap:10px;align-items:center}
.ring{width:18px;height:18px;border-radius:50%;background:conic-gradient(from 210deg,#37e6d0,#4f8dff,#37e6d0);
mask:radial-gradient(circle at 50% 50%,transparent 52%,#000 54%);-webkit-mask:radial-gradient(circle at 50% 50%,transparent 52%,#000 54%)}
p{color:#91a4c2;font-size:13.5px;line-height:1.55;margin:8px 0 16px}
label{display:block;font-size:12px;color:#5c7097;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.04em}
textarea{width:100%;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:#eaf1fb;background:#0f1828;border:1px solid #182438;
border-radius:10px;padding:12px 13px;resize:vertical;min-height:84px;word-break:break-all}
textarea:focus{outline:none;border-color:#37e6d0}
button{font:inherit;font-size:14px;font-weight:700;color:#022421;background:#37e6d0;border:0;border-radius:10px;padding:11px 16px;cursor:pointer}
button:active{transform:translateY(1px)}
a.btn{display:inline-block;text-decoration:none;font-size:14px;font-weight:700;color:#022421;background:#37e6d0;border-radius:10px;padding:11px 18px}
.row{display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap}
.hint{font-size:12.5px;color:#5c7097;margin-top:14px}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f1828;border:1px solid #182438;border-radius:6px;padding:2px 6px;color:#9fe9dd}
.pre{display:block;white-space:pre-wrap;word-break:break-all;background:#0f1828;border:1px solid #182438;border-radius:8px;padding:10px 12px;margin:6px 0;color:#9fe9dd;font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}
.warn{color:#ffcf8a}.err{color:#ff8a8a}.ok{color:#37e6d0}
</style></head><body><div class="card">${inner}</div></body></html>`;
}

function errorPage(heading: string, detail: string): string {
    return page("Connect", `<h1><span class="ring"></span>${esc(heading)}</h1>
<p class="err">${esc(detail)}</p>
<div class="row"><a class="btn" href="${esc(REDIRECT_URI)}">Try again</a></div>`);
}

function tokenPage(refreshToken: string, scope: string, account: string | null, appid: string): string {
    return page("Connected", `<h1><span class="ring"></span>Connected${account ? ` · ${esc(account)}` : ""}</h1>
<p>Copy this refresh token into <code>${esc(appid)}</code> — the CLI or your doax app. It is shown <strong>once</strong> — treat it like a password.</p>
<label for="tok">Refresh token${scope ? ` · ${esc(scope)}` : ""}</label>
<textarea id="tok" readonly onclick="this.select()">${esc(refreshToken)}</textarea>
<div class="row"><button onclick="copyTok()">Copy token</button><span id="copied" class="ok" style="font-size:13px"></span></div>
<div class="hint">Use it either way:</div>
<span class="pre">doax auth set ${esc(appid)} --secret &lt;token&gt;</span>
<span class="pre">REFRESH_TOKEN=&lt;token&gt;   # in your .env</span>
<p class="warn" style="font-size:12.5px">If you lose it, revoke the app's access with your provider and reconnect here.</p>
<script>
function copyTok(){var t=document.getElementById("tok");t.select();
navigator.clipboard.writeText(t.value).then(function(){document.getElementById("copied").textContent="copied";},
function(){document.execCommand("copy");document.getElementById("copied").textContent="copied";});}
</script>`);
}

/* ---------- state cookie (double-submit CSRF guard, carries the requesting appid) ---------- */

const STATE_COOKIE = "drive_oauth";

/** Google echoes only `state`, so the appid rides back in the cookie as `<nonce>|<appid>`. */
function stateCookie(nonce: string, appid: string, maxAge: number): string {
    const value = maxAge === 0 ? "" : `${nonce}|${appid}`;
    return `${STATE_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function readCookie(header: string | undefined, name: string): string | null {
    for (const part of (header ?? "").split(/;\s*/)) {
        const eq = part.indexOf("=");
        if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
    }
    return null;
}

/** Resolve a requested appid to a known provider; null appid defaults, unknown appid is rejected. */
function resolveAppid(raw: string | undefined): string | null {
    if (!raw) return DEFAULT_APPID;
    return PROVIDERS[raw] ? raw : null;
}

function noncesMatch(a: string | null, b: string | null): boolean {
    if (!a || !b || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/* ---------- OAuth exchange ---------- */

async function exchangeCode(client: OAuthClient, code: string): Promise<{ refresh_token?: string; scope?: string; access_token?: string; error?: string }> {
    const res = await fetch(client.tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: client.clientId,
            client_secret: client.clientSecret,
            redirect_uri: REDIRECT_URI,
            grant_type: "authorization_code",
        }).toString(),
    });
    return (await res.json().catch(() => ({}))) as Record<string, string>;
}

/** Best-effort: which account did we just connect? Never fatal. */
async function whoami(provider: Provider, accessToken: string | undefined): Promise<string | null> {
    if (!accessToken) return null;
    try {
        const res = await fetch(provider.verifyUrl, { headers: { authorization: `Bearer ${accessToken}` } });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return provider.verifyAccount(body);
    } catch {
        return null;
    }
}

const app = new Hono();

app.get("/", async (c) => {
    const error = c.req.query("error");
    if (error) return c.html(errorPage("Authorization was not completed", `Provider returned: ${error}`), 400);

    const code = c.req.query("code");
    if (!code) {
        // Start the flow: resolve the provider, random nonce + appid in a cookie, redirect to consent.
        const appid = resolveAppid(c.req.query("appid"));
        if (!appid) return c.html(errorPage("Unknown app", `No connector is configured for appid "${c.req.query("appid")}".`), 400);
        const provider = PROVIDERS[appid]!;
        let client: OAuthClient;
        try {
            client = await loadClient(provider.secretId);
        } catch (e) {
            return c.html(errorPage("Service not configured", (e as Error).message), 500);
        }
        const nonce = randomBytes(16).toString("hex");
        c.header("set-cookie", stateCookie(nonce, appid, 600));
        const url = `${client.authUri}?${new URLSearchParams({
            client_id: client.clientId,
            redirect_uri: REDIRECT_URI,
            response_type: "code",
            scope: provider.scope,
            state: nonce,
            ...provider.authParams,
        })}`;
        return c.redirect(url, 302);
    }

    // Callback: verify the cookie nonce matches the echoed state; recover the appid from it.
    const [nonce, appidFromCookie] = (readCookie(c.req.header("cookie"), STATE_COOKIE) ?? "").split("|");
    if (!noncesMatch(c.req.query("state") ?? null, nonce ?? null)) {
        return c.html(errorPage("Session expired", "The sign-in state did not match. Start again."), 400);
    }
    const appid = resolveAppid(appidFromCookie);
    const provider = appid ? PROVIDERS[appid] : undefined;
    if (!appid || !provider) return c.html(errorPage("Unknown app", "The connector is no longer configured."), 400);
    c.header("set-cookie", stateCookie("", "", 0)); // clear it

    let client: OAuthClient;
    try {
        client = await loadClient(provider.secretId);
    } catch (e) {
        return c.html(errorPage("Service not configured", (e as Error).message), 500);
    }

    const tok = await exchangeCode(client, code);
    if (!tok.refresh_token) {
        const why = tok.error
            ? `Provider returned: ${tok.error}`
            : "No refresh token was returned. Remove this app in your provider's account settings, then connect again.";
        return c.html(errorPage("Could not mint a refresh token", why), 400);
    }
    const account = await whoami(provider, tok.access_token);
    return c.html(tokenPage(tok.refresh_token, tok.scope ?? provider.scope, account, appid));
});

app.get("/healthz", (c) => c.json({ status: "ok", surface: "oauth-mirror", providers: Object.keys(PROVIDERS) }));
app.notFound((c) => c.redirect(REDIRECT_URI, 302));

export const handler = handle(app);

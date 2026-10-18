import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
  * auth.doax.io — the Google Drive refresh-token mirror. A tiny, isolated service that exists
  * only to run the OAuth consent-redirect once and hand the caller back a refresh token to paste
  * into @doax/google-drive-login (CLI) or their .env.
  *
  * It is a SEPARATE, non-VPC Lambda: the registry Lambda is VPC-attached with no public egress
  * (infra/terraform/vpc_endpoints.tf), so it cannot reach accounts.google.com. This one can.
  *
  * One route, served at https://auth.doax.io/ (the registered OAuth redirect_uri):
  *   GET /                   -> set a state cookie, 302 to Google's consent screen
  *   GET /?code=...&state=.. -> verify state, exchange the code, render the token page
  *   GET /?error=...         -> render the error page (user declined, etc.)
  *
  * The OAuth client (client_id/client_secret) is read from AWS Secrets Manager at runtime.
  */

const SECRET_ID = process.env.DRIVE_SECRET_ID ?? "doax-adapter-google-drive";
const REGION = process.env.DRIVE_SECRET_REGION ?? process.env.AWS_REGION ?? "ap-northeast-2";
const REDIRECT_URI = process.env.DRIVE_REDIRECT_URI ?? "https://auth.doax.io";
const SCOPE = process.env.DRIVE_SCOPE ?? "https://www.googleapis.com/auth/drive.readonly";

interface OAuthClient {
    clientId: string;
    clientSecret: string;
    authUri: string;
    tokenUri: string;
}

const sm = new SecretsManagerClient({ region: REGION });
let clientCache: Promise<OAuthClient> | null = null;

/** Read and memoize the OAuth client from Secrets Manager (the `web` block of the Google JSON). */
function loadClient(): Promise<OAuthClient> {
    clientCache ??= (async () => {
        const out = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
        const parsed = JSON.parse(out.SecretString ?? "{}") as { web?: Record<string, string>; installed?: Record<string, string> };
        const web = parsed.web ?? parsed.installed ?? (parsed as Record<string, string>);
        if (!web.client_id || !web.client_secret) throw new Error("the Drive OAuth secret has no client_id/client_secret");
        return {
            clientId: web.client_id,
            clientSecret: web.client_secret,
            authUri: web.auth_uri ?? "https://accounts.google.com/o/oauth2/auth",
            tokenUri: web.token_uri ?? "https://oauth2.googleapis.com/token",
        };
    })().catch((error) => {
        clientCache = null; // let the next request retry a transient failure
        throw error;
    });
    return clientCache;
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
    return page("Drive connect", `<h1><span class="ring"></span>${esc(heading)}</h1>
<p class="err">${esc(detail)}</p>
<div class="row"><a class="btn" href="${esc(REDIRECT_URI)}">Try again</a></div>`);
}

function tokenPage(refreshToken: string, scope: string, email: string | null, appid: string): string {
    return page("Drive connected", `<h1><span class="ring"></span>Drive connected${email ? ` · ${esc(email)}` : ""}</h1>
<p>Copy this refresh token into <code>${esc(appid)}</code> — the CLI or your doax app. It is shown <strong>once</strong> — treat it like a password.</p>
<label for="tok">Refresh token${scope ? ` · ${esc(scope)}` : ""}</label>
<textarea id="tok" readonly onclick="this.select()">${esc(refreshToken)}</textarea>
<div class="row"><button onclick="copyTok()">Copy token</button><span id="copied" class="ok" style="font-size:13px"></span></div>
<div class="hint">Use it either way:</div>
<span class="pre">doax auth set ${esc(appid)} --secret &lt;token&gt;</span>
<span class="pre">GOOGLE_DRIVE_REFRESH_TOKEN=&lt;token&gt;   # in your .env</span>
<p class="warn" style="font-size:12.5px">If you lose it, revoke at <code>myaccount.google.com/permissions</code> and reconnect here.</p>
<script>
function copyTok(){var t=document.getElementById("tok");t.select();
navigator.clipboard.writeText(t.value).then(function(){document.getElementById("copied").textContent="copied";},
function(){document.execCommand("copy");document.getElementById("copied").textContent="copied";});}
</script>`);
}

/* ---------- state cookie (double-submit CSRF guard, carries the requesting appid) ---------- */

const STATE_COOKIE = "drive_oauth";
// A resource reference: @namespace/name. Appears in the token-page instructions, so it is validated.
const APPID_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const DEFAULT_APPID = "@doax/google-drive-login";

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

function cleanAppid(raw: string | undefined): string {
    return raw && APPID_RE.test(raw) ? raw : DEFAULT_APPID;
}

function noncesMatch(a: string | null, b: string | null): boolean {
    if (!a || !b || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/* ---------- Google OAuth exchange ---------- */

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

/** Best-effort: whose Drive did we just connect? Never fatal. */
async function whoami(accessToken: string | undefined): Promise<string | null> {
    if (!accessToken) return null;
    try {
        const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", { headers: { authorization: `Bearer ${accessToken}` } });
        const body = (await res.json().catch(() => ({}))) as { user?: { emailAddress?: string } };
        return body.user?.emailAddress ?? null;
    } catch {
        return null;
    }
}

const app = new Hono();

app.get("/", async (c) => {
    const error = c.req.query("error");
    if (error) return c.html(errorPage("Authorization was not completed", `Google returned: ${error}`), 400);

    let client: OAuthClient;
    try {
        client = await loadClient();
    } catch (e) {
        return c.html(errorPage("Service not configured", (e as Error).message), 500);
    }

    const code = c.req.query("code");
    if (!code) {
        // Start the flow: random nonce + the requesting appid in a cookie, redirect to Google.
        const nonce = randomBytes(16).toString("hex");
        const appid = cleanAppid(c.req.query("appid"));
        c.header("set-cookie", stateCookie(nonce, appid, 600));
        const url = `${client.authUri}?${new URLSearchParams({
            client_id: client.clientId,
            redirect_uri: REDIRECT_URI,
            response_type: "code",
            scope: SCOPE,
            access_type: "offline",
            prompt: "consent", // force a refresh_token even on re-consent
            include_granted_scopes: "true",
            state: nonce,
        })}`;
        return c.redirect(url, 302);
    }

    // Callback: verify the cookie nonce matches the echoed state; recover the appid from it.
    const [nonce, appidFromCookie] = (readCookie(c.req.header("cookie"), STATE_COOKIE) ?? "").split("|");
    if (!noncesMatch(c.req.query("state") ?? null, nonce ?? null)) {
        return c.html(errorPage("Session expired", "The sign-in state did not match. Start again."), 400);
    }
    const appid = cleanAppid(appidFromCookie);
    c.header("set-cookie", stateCookie("", "", 0)); // clear it

    const tok = await exchangeCode(client, code);
    if (!tok.refresh_token) {
        const why = tok.error
            ? `Google returned: ${tok.error}`
            : "No refresh token was returned. Remove this app at myaccount.google.com/permissions, then connect again.";
        return c.html(errorPage("Could not mint a refresh token", why), 400);
    }
    const email = await whoami(tok.access_token);
    return c.html(tokenPage(tok.refresh_token, tok.scope ?? SCOPE, email, appid));
});

app.get("/healthz", (c) => c.json({ status: "ok", surface: "drive-auth" }));
app.notFound((c) => c.redirect(REDIRECT_URI, 302));

export const handler = handle(app);

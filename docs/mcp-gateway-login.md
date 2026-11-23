# No pasted tokens for hosted resources over the MCP Gateway

Status: Change A's **gateway half is implemented and deployed** (`apps/mcp-gateway`): the 401 and the
RFC 9728 metadata, off by default. The registry's OAuth endpoints (Change A, auth-server half) and
Change B are not yet implemented — a registry operator builds their half; see the operator guide below.
Scope: doax spec v0.1, `apps/mcp-gateway`, `apps/doax-cli` (executor core). Found while running the
gateway (305d679) in front of a private registry (day1-doax) whose first tenant is `@fadmin`.

## Problem

To read one private hosted resource from a web agent, a person pastes the same token twice:

1. The Registry token, as an `Authorization` header in the MCP client's configuration, because the
   gateway forwards it and the registry answers nothing without it.
2. The Authenticator's secret, as the tool's `secret` argument. For an Authenticator that only
   exchanges (spec §7.2: "typically inside that Provider's Authenticator"), that secret is the
   Registry token again. It also passes through the model.

Registry tokens expire in days, so this repeats. Neither paste carries information the caller has
not already presented.

## Change A: Registry login from an MCP client (extends spec §7.7)

§7.7 lets an Executor CLI sign in through the Auth Server's web page. Do the same for an MCP client,
using the MCP authorization flow, so the person clicks "connect" and signs in.

Gateway (`apps/mcp-gateway`). It still verifies nothing and stores nothing.
- A POST with no `Authorization` is answered `401` with
  `WWW-Authenticate: Bearer resource_metadata="<gateway origin>/.well-known/oauth-protected-resource"`.
- `GET /.well-known/oauth-protected-resource` returns RFC 9728 metadata:
  `resource` = the gateway's MCP URL, exactly; `authorization_servers` = [the registry's origin].
- With `Authorization` present, behaviour is unchanged: forwarded to the registry, and only there.
- Opt-in per deployment (for example `DOAX_REQUIRE_LOGIN=1`), because registry.doax.io resolves
  public resources anonymously and must keep working without a token. The gateway needs its own
  public origin for the metadata (a setting, or the request's host).

Auth Server (spec §7, §10 "Login discovery"). A Registry that offers MCP login MUST:
- Publish RFC 8414 metadata at `/.well-known/oauth-authorization-server`.
- Offer an authorization endpoint in front of its existing login page, with PKCE `S256`, and a
  token endpoint accepting `application/x-www-form-urlencoded`.
- Identify clients by Client ID Metadata Document or Dynamic Client Registration (RFC 7591), and
  redirect only to the client's registered callback.
- Issue, as the access token, an ordinary Registry token (§7.2), with a refresh token it rotates.
  Nothing about the token or who may sign in changes; as in §7.7, only the copying goes away.

Known departure, to accept on purpose: MCP's authorization spec wants a token issued for the MCP
server and not forwarded onward. Here the access token is the Registry token and the gateway
forwards it to the Registry. The justification is that the gateway is the Registry's MCP face,
holds nothing, and presents the token only to the Registry that issued it (spec §9.2).

Client requirements checked against Claude's connector documentation (claude.com/docs/connectors):
- The `401` is required; a `WWW-Authenticate` header on a `200` is ignored.
- Callback for claude.ai and its apps: `https://claude.ai/api/mcp/auth_callback`. Claude Code uses a
  loopback callback on an ephemeral port.
- `S256` PKCE on every request. Refresh on `401` and up to five minutes before expiry.
- The authorization server may be on another host than the MCP server; only the first entry of
  `authorization_servers` is used; `resource` must equal the MCP URL exactly.
- CIMD is used only if the metadata has `client_id_metadata_document_supported: true` and `none`
  in `token_endpoint_auth_methods_supported`; otherwise DCR.
- Discovery, registration and token endpoints must answer within 10 seconds.

## Change B: Authenticators that authenticate by exchange (extends spec §4.7.1, §7.2)

An Authenticator whose whole flow is "exchange the caller's Registry token for a Provider token"
needs nothing from the person. Let it say so, and let the Executor do the exchange.

Manifest. In the authentication specification:
- interaction kind `none` (already defined in §4.7.1);
- a new item naming the method, for example `"exchange": { "audience": "<provider>" }`.
  The audience MUST be a Provider registered for the Authenticator's own namespace.

Executor (`apps/doax-cli`, `credentialFor` / `acquireCredential`). When a Resource's Authenticator
declares exchange and no valid credential is cached:
- call the Registry's token exchange (§10) at the Registry that owns the Authenticator's namespace,
  with the caller's Registry token for that Registry and the declared audience;
- use the result as the credential (bearer token plus expiry), cache it per §7.6, and exchange
  again when it has expired instead of failing;
- at effective Tier 1, exchange at every invocation and cache nothing (§4.7);
- record the `auth` event as for any `authenticate` (§8.3).

The Registry token is then never handed to a published Package, which is stricter than today,
where the person pastes it into one. Authenticators that need something from the person (a
`secret-entry` API key, a `browser-login`) are unchanged.

The gateway needs no change for B: it calls the executor core. For such a Resource it no longer
returns `needs_mint`, and neither `secret` nor a cookie is needed.

## Result

- Web agent: add the connector, sign in once in the browser, read `@ns/resource`. No token is seen.
- CLI: `doax login --web`, then `doax read @ns/resource`. The `doax auth <authenticator> --secret`
  step disappears for exchange Authenticators.

## Building a registry's MCP-login pair (operator guide)

A registry and its gateway are a 1:1 pair, deployed together, the gateway's domain derived from the
registry's: `registry.doax.io` ↔ `mcp.doax.io`, `day1-doax` ↔ `doax-mcp.internal.day1ax`. Because
they are a pair, the gateway's authorization server is always the paired registry — there is nothing
to look up or configure beyond the pointer.

### The gateway: reuse `apps/mcp-gateway`, set three variables

The gateway half of Change A is already built; an operator runs the same `apps/mcp-gateway` as their
pair's gateway and configures it:

- `DOAX_REGISTRY` — the paired registry's origin (e.g. `https://day1-doax.internal`). The gateway
  forwards the caller's token only here, and advertises it as the sole `authorization_servers` entry.
- `DOAX_REQUIRE_LOGIN=1` — force the MCP OAuth flow. Leave unset for a public registry that resolves
  anonymously; set it for a private one, so a tokenless request is answered `401`.
- `DOAX_GATEWAY_ORIGIN` — the gateway's own public URL. The RFC 9728 `resource` must equal the MCP
  URL the client connects to, exactly; set this when the request `Host` is not that URL (behind a
  proxy, a different edge host). Otherwise the gateway derives it from `Host`.

With those set, the gateway already answers `401` with `WWW-Authenticate: Bearer resource_metadata=…`
and serves `GET /.well-known/oauth-protected-resource`. Nothing else on the gateway is needed.

### The auth server: build these OAuth endpoints on the registry

This is the operator's half — an OAuth 2.1 authorization server in front of the registry's existing
login, issuing ordinary Registry tokens (spec §7.2). A checklist:

1. **RFC 8414 metadata** at `/.well-known/oauth-authorization-server` (the gateway points clients at
   the registry; the client fetches this from the registry).
2. **Authorization endpoint** wrapping the existing login page, requiring **PKCE `S256`**, redirecting
   only to the client's registered callback.
3. **Token endpoint**, `application/x-www-form-urlencoded`, issuing a Registry token (§7.2) as the
   access token plus a **refresh token it rotates**. Nothing about the token or who may sign in
   changes — only the copying goes away (as in §7.7).
4. **Client identity** by Client ID Metadata Document (if the metadata advertises
   `client_id_metadata_document_supported: true` and `none` auth) or Dynamic Client Registration
   (RFC 7591).
5. **Answer within 10 seconds** on discovery, registration, and token endpoints.

The access token is the Registry token and the gateway forwards it to the Registry — safe **only
because the gateway fronts the registry that minted it** (the pairing invariant). A gateway must
never forward a token to a registry that did not issue it.

### Client notes (checked against claude.com/docs/connectors)

- The `401` is required; a `WWW-Authenticate` on a `200` is ignored.
- Callback: `https://claude.ai/api/mcp/auth_callback` for claude.ai and its apps; Claude Code uses a
  loopback callback on an ephemeral port.
- `S256` PKCE on every request; the client refreshes on `401` and up to five minutes before expiry.
- Only the first `authorization_servers` entry is used; the auth server may be on another host than
  the gateway; `resource` must equal the MCP URL exactly.

## Gateway authentication is two steps: registry, then authenticator

Authentication at the gateway is two steps, and they MUST NOT be conflated (spec §4.7):

1. **Registry authentication** — the caller signs in to the registry (Change A, the connector's OAuth) and
   receives a Registry token. The gateway uses it to resolve and reach the catalog.
2. **Authenticator authentication** — the resource's namespace Authenticator issues the target credential.
   With one Authenticator per namespace (spec §4.7), this is the namespace's single sign-in: via `poll-login`
   (§4.7.1a) through the gateway, or — when the namespace is served as its own connector — that connector's
   OAuth. The minted credential is cached (in the cookie, for the hosted gateway) and shared across the
   namespace's resources.

### One sign-in for both, when the authenticator auth is identical to or extends the registry auth

If the namespace's Authenticator uses the **same authority** as the registry login, or **extends** it, a single
sign-in yields what both steps need and the gateway MUST NOT make the user log in twice:

- **Identical** — the target accepts the very token the registry issued (same audience, e.g. the registry
  operator is also the target's provider). The Registry token *is* the target credential; the gateway presents
  one token for the resolve and for the resource.
- **Extension** — the same identity provider grants the target's scopes within the same authorization; one
  sign-in returns a token (or an audience/scope-expanded token) covering both. The caller authenticates once;
  the gateway uses the registry portion to resolve and hands the target portion to the resource.

So when the registry and the namespace share an authority, wire the single sign-in to issue the combined token
and skip the authenticator's separate flow.

### When they differ, keep the two steps separate

If the target is a **different authority** — a different organization, or a provider that refuses the registry's
audience (spec §7.2) — one sign-in cannot cover both. The registry login and the namespace sign-in are two
authentications producing two tokens for two audiences, **even if they share an identity provider**: the same
Google SSO does not make the tokens interchangeable. The namespace then signs in on its own — its connector's
OAuth, or `poll-login` — and the gateway keeps the registry token and the target credential distinct.

## Closed (were open in 305d679)

- Tier 2 `read`/`execute` over the gateway now completes: the gateway cookies `auth-tokens.json`
  alongside `credentials.json` (every token and authorization lives in the cookie), and
  `doax_execute` takes `yes: true` to authorize — the Tier 2 token is minted and cached in the
  cookie for its window; Tier 1 authorizes every call (§4.7).
- A supplied `secret` re-authenticates instead of losing to a cached credential.
- A Tier 1 Authenticator runs on every call (§4.7); its credential is not reused.
- `Authorization` is forwarded only to the registry's own origin, not any URL that starts with it.

## Work by repository

- doax: spec text for A and B; gateway 401 and metadata; executor exchange.
- A registry that wants MCP login (day1-doax first): the authorization and token endpoints.
- A namespace with an exchange Authenticator (`@fadmin/fadmin-auth` first): a new version declaring it.

## Review notes and agreed sequencing

Added when landing this proposal; see the discussion around 305d679.

- **Change A guardrail (make it a MUST).** Forwarding the Registry token is safe *only because the
  gateway fronts the registry that minted it* — the token reaches its own audience, so it is not a
  confused deputy. State it: a gateway forwards a token only to the registry whose Auth Server
  issued it. A gateway in front of a registry it did not get the token from would be a token leak.
- **Open-issue triage.** The `startsWith` forwarding check is latent, not a live exploit today: in
  the gateway every URL `deps.fetch` sees is built from the fixed registry origin plus
  registry-supplied paths, and Packages call global `fetch`, not the injected one — so no
  attacker-controlled host reaches it. Fix it to an origin compare for defence-in-depth. The
  cookie-wins-over-`secret` and Tier-1-cookie-reuse items are genuine spec-correctness bugs.
- **Agreed order:** (1) this doc → (2) fix the open correctness bugs → (A) the gateway half of
  Change A (401 + RFC 9728 metadata) in this repo, with the Auth Server's OAuth endpoints tracked
  registry-side. **Change B is proposed but deferred.**

# No pasted tokens for hosted resources over the MCP Gateway

Status: proposal. Nothing here is implemented.
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

## Not covered here (open in 305d679)

- A Tier 2 `read` or `execute` over the gateway always ends at `needs_mint` / `authorization-required`:
  the core accepts `--yes` or `auth-tokens.json`, and the gateway rebuilds only `credentials.json`
  from cookies, so no second call can carry the authorization.
- A cached cookie wins over a supplied `secret`, so an expired credential cannot be replaced until
  the cookie expires.
- A cookie is reused at Tier 1 (§4.7 says the Authenticator runs at every invocation).
- `Authorization` is forwarded when the URL text starts with the registry address, not when its
  origin matches.

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

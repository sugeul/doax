# Running doax on-premise

An organization runs its own private registry from this codebase. These are the decisions that shape how, and the steps to do it. The spec leaves all of them to the implementer; the choices here are the ones that are hard to reverse once private installs exist.

## Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Deployment unit | **One process, `doax-server`**, hosting Registry Server, Code Repository and Auth Server. The Executor host is a separate deployable. | Spec §3.1 allows one process or several. One is what an admin can actually install. The three components stay separate packages, so splitting later is a config change, not a rewrite. The Executor host runs on the batch machine, not the registry box (§6A). |
| 2 | Storage | **Embedded SQLite (`node:sqlite`) and local filesystem by default.** Postgres and S3-compatible storage are declared config options, not yet implemented. | Zero external dependencies: `docker run` with a volume and it works. A first install that needs a database admin does not happen. |
| 3 | Login | **Auth Server is generic OIDC; Google is the default issuer.** | Google Sign-In *is* OIDC, so the reference implementation the spec requires (§7.1) and "plug in your SSO" are the same code with a different issuer URL. The public doax.ai instance only enables Google, which keeps it within v1 scope. |
| 4 | Addressing (spec §15.1) | **Path-based under one hostname:** `https://registry.corp.internal/@corp/orders`, packages at `/packages`, auth at `/auth`. | One hostname means one TLS certificate and no wildcard DNS. The `manifesto` field is just the configured domain. |
| 5 | Upstream (spec §12.2) | **A config line, off by default.** `DOAX_UPSTREAM=https://doax.ai` enables the proxy with block/pin/require-verified policy. | An air-gapped install stays air-gapped unless someone decides otherwise. |
| 6 | Distribution | **Docker image first, `npx doax-server` second.** | Node 24 is already required, so npx works for evaluation; the image is what goes into a real environment. |

The audit log is append-only at the database level: SQLite triggers refuse `UPDATE` and `DELETE` on `audit_events`, so no code path in the process can edit or remove an event (spec §8.1).

## Configuration

Precedence: environment variables, then the JSON file named by `DOAX_CONFIG`, then defaults.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `DOAX_DOMAIN` | `http://localhost:{PORT}` | Public origin; used in every response's `manifesto` field |
| `DOAX_OPERATOR` | `unconfigured` | Who runs this instance; shown in `manifesto.json` |
| `DOAX_DATA_DIR` | `./data` (`/data` in Docker) | Where `registry.sqlite` and `packages/` live |
| `DOAX_STORAGE` | `sqlite` | `sqlite` or `postgres` (the latter needs `DOAX_POSTGRES_URL`; not implemented yet) |
| `DOAX_UPSTREAM` | unset | Upstream registry origin; empty disables |
| `DOAX_OIDC_ISSUER` | `https://accounts.google.com` | OIDC issuer for login |
| `DOAX_OIDC_CLIENT_ID` | unset | OIDC client id; until set, `/auth` reports `unconfigured` |
| `DOAX_CONFIG` | unset | Path to a JSON file with the same keys in camelCase (`domain`, `operator`, `dataDir`, `storage`, `upstream`, `auth.oidcIssuer`, `auth.clientId`) |

## Run

```sh
# Docker
docker build -t doax/server .
docker run -p 8080:8080 -v doax-data:/data \
    -e DOAX_DOMAIN=https://registry.corp.internal -e DOAX_OPERATOR="Corp IT" \
    -e DOAX_OIDC_ISSUER=https://sso.corp.internal -e DOAX_OIDC_CLIENT_ID=... \
    doax/server

# Node, for evaluation
DOAX_DOMAIN=https://registry.corp.internal npx doax-server
```

Then point every CLI at it:

```sh
DOAX_REGISTRY=https://registry.corp.internal doax status
```

Inside the organization's network, `doax.ai` may instead be resolved to the on-premises instance (spec §12.1) so that CLIs need no configuration.

## Endpoints today

| Path | Component |
|---|---|
| `/` | Status of the composed server, with where each component is mounted |
| `/healthz` | Liveness, with storage backend |
| `/manifesto.json` | Static self-description (spec §10A) |
| `/packages` | Code Repository |
| `/auth` | Auth Server |

Registry features (resolve, search, publish, audit ingest and query) are not implemented yet; the storage, mounting and configuration they will use are.

<div align="center">

# doax

**Day One AX** — the registry of data and action resources that AI agents use on behalf of a human.

Resolve · verify · tier · invoke · audit. Like npm, but for what an agent is allowed to do.

[doax.io](https://doax.io) · [registry.doax.io](https://registry.doax.io) · [app.doax.io](https://app.doax.io) · [spec](docs/spec/registry-v0.1.md)

</div>

---

## This is live, right now

```sh
curl -fsSL https://doax.io/install.sh | bash

doax search slack
doax read @doax/slack-channel-history --param channel=C0123456789      # asks for your Slack token in context
doax execute @doax/slack-post --param channel=C0123456789 \
    --param text="hello from doax" --dry-run                           # preview, zero side effects
doax login --email you@example.com                                     # 6-digit code by mail — no account form
doax publish my-resource.manifest.json my-resource.mjs                 # @global accepts anyone signed in
```

Every one of those commands hits the real, running system:

| Surface | What it is |
|---|---|
| [doax.io](https://doax.io) | The public site: what doax is, live search over the real catalog, install guide |
| [registry.doax.io](https://registry.doax.io) | The registry API — resolve, search, publish, audit, auth, namespaces (CloudFront → API Gateway → Lambda → Aurora PostgreSQL + S3, audit in CloudWatch Logs) |
| [app.doax.io](https://app.doax.io) | **doax-app** hosting: `doax app deploy @ns ./dist` → `https://ns.app.doax.io`, gated behind doax sign-in, one browser origin per namespace |
| [demo.app.doax.io](https://demo.app.doax.io) | A worked example: a small factory's shift-end spreadsheet, made legible as five registry resources and a dashboard that reads them live. Source: [doax-demo](https://github.com/sugeul/doax-demo) |
| `@doax/slack-*`, `@global/web-fetch` | Real published resources you can `doax read`/`execute` today — not samples, the actual catalog |

## What a Resource is

Every Resource is one of four kinds — **data-source**, **action**, **executor**, **authenticator** — identified as `@namespace/name@version`, immutable once published, and governed the same way regardless of kind:

- **Tiered** (1–4): the authentication a resource demands can be strengthened downstream, never weakened.
- **Audited**: every resolve, read, dry-run, and execute is an append-only event — who, what, at which tier, what happened.
- **Integrity-checked**: the executor refuses to run a package whose digest doesn't match the manifest.
- **Namespaced**: a namespace is self-serve (sign in with email, claim it), owned and governed by whoever claims it; `@global` is open to anyone signed in.

The full guarantees are in the spec: [docs/spec/registry-v0.1.md](docs/spec/registry-v0.1.md). [docs/architecture.md](docs/architecture.md) records the product decisions on top of it and where they currently diverge from spec v0.1 (§10 there).

## Status — what's real and what's scaffold

Being direct about this on purpose:

| Live and working | Scaffold / not yet real |
|---|---|
| Global registry on AWS (resolve/search/publish/audit) | On-premise single-process deployment (`apps/doax-server`) — builds and passes tests, never run end-to-end the way the cloud path has |
| Email-code sign-in, namespace roles, `@global` | OIDC / Google Sign-In (the spec's v1 reference login) — email-code is a pre-OIDC delta, same token contract |
| `doax` CLI: search, resolve, read, execute, publish, audit, app deploy | Executor Resources / `trusted-executor` dispatch (spec §6A) — no hosted executor exists yet; all server-side scheduled work is unbuilt |
| Published resources: Slack suite, `@global/web-fetch`, the `@demo` kit | Namespace visibility beyond `public`/claimed-private; verification review (spec §4.5) is unimplemented |
| doax-app hosting with a sign-in gate at the edge | Authorization by namespace membership on apps (today: any signed-in user can view any deployed app) |

## Layout

| Path | Package | Role |
|---|---|---|
| `packages/protocol` | `@doax/protocol` | The shared contract: resource identity, tiers, manifest types, audit events, token claims, manifesto |
| `packages/config` | `@doax/config` | Configuration schema and loader for the server and the CLI; the path layout (`MOUNTS`) |
| `apps/registry-server` | `@doax/registry-server` | Registry Server (spec §10), on-premise build: manifests, resolution, namespaces, audit. Embedded SQLite storage |
| `apps/code-repository` | `@doax/code-repository` | Code Repository (spec §11): immutable package storage on the filesystem |
| `apps/auth-server` | `@doax/auth-server` | Auth Server (spec §7): offline-verifiable tokens, login delegated to OIDC (Google by default) |
| `apps/doax-server` | `doax-server` (bin `doax-server`) | Composes the three above into one process under one hostname — the on-premise deployable, and the source of `src/lambda.ts`, the handler actually running on registry.doax.io |
| `apps/executor-host` | `@doax/executor-host` | Executor Resource (spec §6A): an organization-operated machine that runs `trusted-executor` work — scaffold only |
| `apps/doax-cli` | `doax-cli` (bin `doax`) | Executor CLI (spec §9): runs on the caller's device; resolves, authenticates, invokes and audits resources |
| `infra/terraform` | — | The AWS stack behind doax.io, registry.doax.io, app.doax.io: Lambda, API Gateway, Aurora, S3, CloudFront, SES, CloudWatch |
| `infra/site`, `infra/apps-landing` | — | Source for the public site and the app-provider landing page |
| `infra/seed` | — | The published `@doax/slack-*` and `@global/web-fetch` resources, as a worked example of a real package |
| `demo/scenario.md` | — | The dispatch playbook behind the live demo: how a small factory's working reality becomes a registry namespace plus a doax-app |

Everything publishable goes to npm. `doax-server` also ships as a Docker image (see [Dockerfile](Dockerfile)) for on-premise installs — see [docs/deployment.md](docs/deployment.md).

## Development

Requires Node 24 and pnpm (via `corepack enable`).

```sh
pnpm install
pnpm test        # vitest, runs against TypeScript sources
pnpm build       # tsc -b, emits dist/ per package
pnpm --filter doax-server dev                    # on-premise server, whole stack on :8080
pnpm --filter doax-cli dev -- status             # CLI against DOAX_REGISTRY (default https://registry.doax.io)
```

During development, packages resolve each other's `src/*.ts` through the `@doax/source` export condition and Node's built-in type stripping, so no build step is needed. Production runs `dist/`.

To work on the AWS stack: `bash infra/build-lambda.sh` bundles `apps/doax-server/src/lambda.ts`, then `terraform plan`/`apply` from `infra/terraform` (requires the `doax` AWS profile). `bash infra/build-site.sh` builds the public site and CLI bundle served from doax.io.

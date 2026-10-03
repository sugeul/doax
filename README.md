# doax

**doax** (Day One AX, where AX is the AI transition) is a registry of data and action resources that AI agents use on behalf of a human. [doax.ai](https://doax.ai) runs the public registry. A company can also install and run its own private registry from this codebase; see [docs/deployment.md](docs/deployment.md).

The specification is in [docs/spec/registry-v0.1.md](docs/spec/registry-v0.1.md).

## Layout

| Path | Package | Role |
|---|---|---|
| `packages/protocol` | `@doax/protocol` | The shared contract: resource identity, tiers, manifest types, audit events, token claims, manifesto |
| `packages/config` | `@doax/config` | Configuration schema and loader for the server and the CLI; the path layout (`MOUNTS`) |
| `apps/registry-server` | `@doax/registry-server` | Registry Server (spec §10): manifests, resolution, namespaces, audit. Embedded SQLite storage |
| `apps/code-repository` | `@doax/code-repository` | Code Repository (spec §11): immutable package storage on the filesystem |
| `apps/auth-server` | `@doax/auth-server` | Auth Server (spec §7): offline-verifiable tokens, login delegated to OIDC (Google by default) |
| `apps/doax-server` | `doax-server` (bin `doax-server`) | **The deployable.** Composes the three above into one process under one hostname |
| `apps/executor-host` | `@doax/executor-host` | Executor Resource (spec §6A): an organization-operated machine that runs `trusted-executor` work |
| `apps/doax-cli` | `doax-cli` (bin `doax`) | Executor CLI (spec §9): runs on the caller's device; resolves, authenticates, invokes and audits resources |

Everything publishable goes to npm. `doax-server` also ships as a Docker image (see [Dockerfile](Dockerfile)).

## Development

Requires Node 24 and pnpm (via `corepack enable`).

```sh
pnpm install
pnpm test        # vitest, runs against TypeScript sources
pnpm build       # tsc -b, emits dist/ per package
pnpm --filter doax-server dev                    # whole server on :8080
pnpm --filter doax-cli dev -- status             # CLI against DOAX_REGISTRY (default https://doax.ai)
```

During development, packages resolve each other's `src/*.ts` through the `@doax/source` export condition and Node's built-in type stripping, so no build step is needed. Production runs `dist/`.

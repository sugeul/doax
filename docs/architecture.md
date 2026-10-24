# doax architecture and go-to-market

This document records the decisions that turn the spec ([docs/spec/registry-v0.1.md](spec/registry-v0.1.md)) into a product and a way to sell it. The spec says *what the system guarantees*; [docs/deployment.md](deployment.md) says *how one instance is run*. This document sits between them: it says **what we ship, to whom, in what order**, and it names the few places where the product requires something beyond spec v0.1.

Nothing here weakens a spec guarantee. Where the product needs more than the spec provides, it is listed explicitly in [§10 Spec deltas](#10-spec-deltas-from-v01).

---

## 1. One core, several surfaces

doax is not "a product." It is a **shared core with multiple product surfaces**, each a product for a different persona. This is the organizing idea; everything else follows from it.

```
   CLI            thin MCP          chat surface
(builder)      (BYO agent)       (business user)      ← surfaces (products)
   └──────────────┴──────────────────┘
                   │
         Executor Core (library)                      ← resolve · integrity · tier · auth · invoke · audit · cache
                   │
   Registry core · Code repo · Auth server            ← substrate (HTTPS/JSON, npm-like)
```

| Surface | Persona | Status |
|---|---|---|
| **CLI** (`doax`) | a builder/developer, the npm-CLI equivalent | scaffolded; only `status` today |
| **thin MCP** | a bring-your-own agent (Claude Code compatible) | designed (§3) |
| **chat surface** | a non-developer business user | to build; the day-one business product (§5) |

The business user never touches the CLI — that it is "for hard developers" is the point, and no amount of polish changes it. The business surface is a different product for a different persona on the same core.

---

## 2. The executor core is a shared library

The weight of the system — resolve, integrity check, effective-tier computation, the authentication flows, audit emission, the credential cache — lives **once**, in `packages/executor-core`, and every surface imports it.

- This is a decision made **now**, while it is greenfield (the CLI does nothing yet). If the runtime grows inside `apps/doax-cli`, the chat surface and the MCP each re-implement tier/auth/audit and drift. Three surfaces, one executor.
- Everything the spec marks MUST about execution (tier cannot be weakened §7.4, §9.2; integrity refusal §9.2; mandatory audit §8.3; credential custody §7.6) is enforced in the core, so every surface inherits it and none can opt out.

---

## 3. The agent bridge: registry stays HTTPS/JSON; only the executor speaks MCP

"doax as an MCP server" means the **executor/connector**, not the registry.

- The **registry server** (resolve, search, publish, fetch — spec §10, §11) is npm-like: HTTPS + JSON, consumed by build tooling and the CLI. It does **not** become MCP. MCP would add nothing to a distribution plane.
- Only the **runtime-invocation plane** — a resolved resource's Fixed Interface — is what an agent calls mid-task, and that is where MCP belongs.

### 3.1 Thin MCP, not a fat proxy

The CLI is already the executor the spec mandates (§9): the only component that touches personal credentials, runs tier flows and interactive login, emits audit, manages the cache. The MCP must not duplicate it. So:

| Layer | Job |
|---|---|
| **thin MCP** | discovery (`search`, `describe`), **inline execution of non-interactive reads**, and returning the exact `doax …` command for everything else |
| **CLI** | every effecting or interactive operation, with full guardrails (§9) |
| **executor core** | the single place tier/auth/audit/integrity live; both of the above call it |

### 3.2 Reads inline, actions through the guarded path

The transport boundary matches the risk boundary: the agent may freely *pull data*; anything that *changes the world* goes through the CLI's guardrails.

| MCP inlines (no effect) | CLI owns (effect or interactive) |
|---|---|
| `describe` (all), `metadata` + `read` (data-source), `capabilities` (executor) | `execute`, `dry-run`, `recover` (action); `dispatch` (executor); `authenticate` (authenticator) |

### 3.3 Interactive reads: the agent decides whether to proceed, never whether to weaken

A read is not unconditionally inline-able. A Tier-1 data source, or one behind a `personal` Authenticator, requires interactive login on **every** call (§7.3, §4.7). So:

- `describe` returns the decision inputs — required tier, authenticator subject + interaction kind (§4.7.1), whether a valid credential is cached — reduced to one derived bit: **`willRequireInteraction`**.
- `willRequireInteraction: false` → MCP inlines the read, data in the tool result.
- `willRequireInteraction: true` → MCP returns *"needs interactive auth — run `doax read …` or skip,"* and **the agent chooses** to proceed (via the CLI's interactive flow) or skip.

The agent's freedom is **proceed-or-skip**, informed by the definition. It can never choose to run a Tier-1 resource *without* the login — §7.4 and §9.2 are absolute, and the invariant stays in the executor core.

---

## 4. The virtualized agent is a caller-device

A virtualized agent (computer-use in a VM) can *mechanically* drive a browser login. That is fine for credential acquisition and dangerous for human consent, and those are two different things wearing one name.

- **Tier 2–4:** the virtualized agent runs fully autonomously, including the occasional re-login. This is the unattended-execution win, and the spec permits it.
- **Tier 1 only:** it must **escalate to the real human** (the chat surface's approval, §5), never click consent itself.

If the VM can approve its own Tier-1 calls, Tier 1 collapses into Tier 3 and the product's control guarantee is gone — any prompt injection in the data it just read becomes an approved action (the confused-deputy problem). The human gate is the circuit breaker; it stays a human.

---

## 5. The chat surface is the control locus, not a skin

The business surface is built in at day one — not as polish, but because it is **the only place the control the spec defers can live**:

- **Human-in-the-loop (§6.4):** the agent asks the business user *in the chat* before any Tier-1 action. The surface **is** the approval channel the spec left to "messenger integrations, deferred (§14)."
- **Interactive auth:** the browser login a VM must not auto-approve (§4) is done by the human *in the surface*, when present.
- **Audit visibility (§8.5):** where the audit log surfaces to a person.

So the surface carries the *control* half of doax's value. Underneath is governed infrastructure; on top is an agent product. The day-one deliverable is therefore a **vertical slice all the way up** — one real resource → agent → chat → approval → audit — not a broad registry with no face.

---

## 6. Multi-tenant SaaS: public catalog plus `@org`

The hosted instance ([doax.io](https://doax.io)) is **multi-tenant from day one** — the npm model. We hold `@doax`; every org gets its `@org` scope with private, auth-gated resources, using the spec's existing machinery: visibility axes (§4.5), tokens carrying namespace membership (§7.2), namespace management (§10).

This matters because a business can feel value on **their own** private resources on SaaS, not only on public ones — which partly closes the gap between a trial and the on-prem payoff.

---

## 7. The isolation boundary (§12.3)

The SaaS→on-prem line is **not** "public vs private." It is **access control vs. physical isolation**, which §12.3 states directly: *"Namespace visibility is access control, not physical isolation… The Registry MUST NOT describe namespace-only visibility on a shared public instance as isolation."*

`@org` on SaaS gives private namespace, auth, and access control — but the manifests still live on our infra. The line is drawn at **where credentials and data live and where execution runs** (§7.6):

| Private `@org` resource | Runs cleanly on SaaS? | Why |
|---|---|---|
| **Snapshot** (§5.6) — policy docs, org chart, plans embedded in the package | ✅ | no live credential, no external system; a read is a fetch |
| Target reachable from SaaS, org-account auth | ✅ mostly | execution + credentials stay off the registry (§7.6) |
| Reaches their **internal network**, or data/creds must **never leave** | ❌ | needs a **trusted-executor inside their perimeter** |

That last row is the expansion trigger, and it is honest rather than an upsell: *you have outgrown access control; you now need isolation.*

---

## 8. Delivery and go-to-market: SaaS-first, expand to on-prem

Lead with SaaS; deploy on-premise once the client has felt the experience.

- **SaaS-first** is low-friction to land (no procurement, no security review, no appliance) and is also the *easier* first deployment — we run it, no air-gap. The architecture already runs both ways (deployment.md #1: one composable process), so this is a deployment-order decision, not a redesign.
- **The public catalog is the trial.** On SaaS a newcomer feels value through public resources (and their own `@org` snapshots). So the seeded catalog from the founding vision — messenger actions, public data, wrapped MCPs — is not "step 3"; it **is** the top-of-funnel experience, and its quality is the conversion rate.
- **On-prem is the expansion**, for clients who cross the §7 isolation line.

### 8.1 On-prem is an SI-delivered, agent-operated appliance

We act as the **SI / integrator**. On-prem is not sold as self-managed software:

- **Delivery:** a pre-baked **desktop-as-server appliance** dropped into the closed environment. The client installs nothing and configures nothing — we baked the initial state. This is the answer to "too hard to manage, even with a sexy client": the client manages *nothing*.
- **Operation (day-to-day):** **self-serve via the in-environment agent** — it authors and maintains resources locally, with zero connectivity. This is the only part that happens often, and it needs no human and no SI visit.
- **Upgrades (version/patch):** **periodic SI touches**, rare by design because the infra is deliberately low-churn (embedded SQLite, local FS, zero external deps — deployment.md #2). Quarterly, not weekly.
- **Honest cost:** air-gap means patch and model latency between visits — a CVE or better model waits for the next touch; the client accepts this as the price of isolation. If they allow a narrow controlled conduit (data diode / scheduled one-way feed), the **upstream proxy** (§12.2, off by default) turns "drive there with a USB stick" into "updates land in staging, SI promotes them."

---

## 9. Day-one integration playbook (per new org)

Day-one onboarding maps **entirely onto existing primitives** — the four kinds plus the Auth Server component. No new kind.

1. **Auth for the company.** Configure the multi-tenant Auth Server to **federate their OIDC/SSO issuer** and issue §7.2 tokens carrying `@org`. Register the `@org` namespace and its **trusted issuer** via namespace management (§10 — see the delta in §10 of this doc). Their target-system logins become **`authenticator`** resources (§4.7) under `@org`.
2. **VM for their remote executor.** Register it as an **`executor`** resource (§6A) plus a `machine`-subject **`authenticator`** (§6A.4), running on a VM inside their perimeter. This VM is the trusted-executor of §7's last row: it runs the `@org` resources that need internal reach or must keep credentials off our SaaS (§7.6).

With those two steps, a company's people authenticate as themselves into `@org`, and their private resources that need in-perimeter execution have somewhere to run — before any full on-prem appliance exists.

---

## 10. Spec deltas from v0.1

The product requires these additions beyond spec v0.1. None is a new resource kind. §10.1 is a configuration extension; §10.2–§10.6 come from the first organization that puts **every** interface of an internal system behind doax (fadmin on day1-doax, a private registry), its web portal included, where a resource's backing service has to enforce what the executor cannot.

### 10.1 Per-namespace trusted-issuer registration (extends spec §10, §7.2)

Spec v0.1 assumes single-tenant issuer trust: §7.2 says *"a Registry Server declares which issuers it trusts."* Multi-tenant SaaS has N orgs, each with its own IdP, and needs **per-org issuer registration** mapping `issuer → @org`.

- **Home:** an extension to **Namespace management (spec §10)** — "set trusted issuer(s) for this namespace" — alongside the existing visibility defaults, Tier floor, audit destination, and grant lists.
- **Not a resource kind.** Making the identity provider a `Resource` would be circular: resolving a resource requires a token, so you cannot make the issuer of tokens a thing that must itself be resolved under token auth. §7 keeps the Auth Server a **component** precisely so it sits outside the resource graph as the root of trust. The four kinds (§4.2) stay four.

### 10.2 Provider-side enforcement (extends spec §7.4, §8, §9.2)

Spec v0.1 puts tier, authorization and audit in the **Executor**: the CLI or a browser doax-app. An executor runs on the caller's device, so whoever controls the device controls the check: a browser can be edited, a CLI run with `--yes`. That is acceptable for reads of public data and not for writes to a system of record.

- A **Provider** is the service a resource's package calls, operated by (or for) the namespace owner. A namespace MAY declare its Providers (registry configuration: `provider name → service identity`).
- A Provider MUST, on every invocation it serves: verify the caller's token (§10.4), map the request to `(resource, operation)`, apply the resource's declared tier from a manifest it trusts (its own published manifest, pinned by digest), require an approval (§10.3) where the effective tier is 2 or stronger, and emit the audit event itself.
- **Audit authority.** Events a Provider delivers with its service identity are **authoritative**; events delivered by executors are kept but are **claims** about the caller's device. The audit store records which (`source: provider | registry | ingest`, plus who delivered it).
- A Provider that cannot deliver MUST NOT drop the event: it falls back to a durable local log from which it is redelivered (spec §8.2 applied to Providers). Redelivery is idempotent by event id.

### 10.3 Approval artifact (extends spec §6.4, §7.3 Tier 2)

Tier 2 "per-call authorization" needs a thing the Provider can check. An approval binds **one human decision to one exact request**:

1. On `dry-run`, the Provider computes the **request hash** — `sha256` of the canonical JSON (keys sorted recursively, no whitespace) of `{resource: "@ns/name", operation: "execute", input: <the normalized input>}` — and asks the registry for an approval: `POST /approvals {resource, operation, requestHash, requestedFor, summary}`. Only a Provider may ask, so the summary a person approves is the Provider's, not the agent's.
2. The registry returns an approval id and a page. The person named in `requestedFor` opens it and decides with a **fresh interactive sign-in** (an IdP credential minted moments ago, not a registry token, so an agent holding the token cannot decide). The registry records an `approve` or `reject` event (§8.3).
3. On `execute`, the caller passes the approval id. The Provider fetches the approval from the registry with its own identity and receives a **signed approval token** `{typ: "doax-approval", jti: <approval id>, sub: <approver>, res, op, req: <request hash>, aud: <provider>, exp}`. It accepts only if the signature, audience, resource, operation and request hash match the request in hand, the approver is the actor, and the approval has not been used: **single use**, enforced by the Provider. A retry with a used approval returns the first result, which makes the approval the idempotency key.

The agent can prepare everything; only the person can make it happen. This is §4 of this document (a virtualized agent must escalate, never click consent) made checkable.

### 10.4 Audience-scoped tokens (extends spec §7.2)

A §7.2 token names namespaces but not where it may be presented, so a token accepted by one Provider is accepted by every Provider that trusts the same issuer. Tokens carry an **audience** (`aud`): `registry` for the registry itself, a Provider name otherwise. The registry refuses Provider tokens; a Provider refuses everything but its own audience.

- An executor obtains a Provider token by **exchange**: `POST /auth/exchange {audience}` with a registry token, typically inside the Provider's Authenticator (`authenticate` exchanges, `refresh` exchanges again).
- A web portal signs in for its Provider directly: `POST /auth/google {credential, audience}`.
- Provider tokens are short-lived (hours); registry tokens stay long-lived (days). A token records the **channel** it was issued for (`chn: web | executor`), which the Provider copies into its audit events.

The §7.2 rule stands: no per-resource permissions in the token. The audience says where; the Provider still decides what.

### 10.5 Out-of-band payloads (extends spec §6, §8.4)

Bulk data (ledgers past 100 MB) does not pass through an action invocation. The action covers the control steps — issuing an upload ticket, finishing it — and the bytes travel to storage over a short-lived signed URL. The `execute` event records the payload's size and digest as the Provider observed them, so the audit names exactly which bytes the action filed.

### 10.6 Web as an execution location (extends spec §8.4)

A Provider serving a web portal records `executionLocation: {kind: "web", app: <portal>}`; through an executor it records what the token's channel says. Portal use and agent use then appear side by side in one audit log, under the same resources.

---

## 11. Build order

The registry core is the floor; the first thing a user sees is a chat surface backed by a few good public resources.

```
registry core  (resolve · search · publish — WITH auth · namespaces · visibility, spec §10)
   → executor-core  (shared library, §2)
      → surfaces  (CLI, thin MCP, chat §5)
         → seed real public resources  (the SaaS experience, §8)
            → ship as SaaS (doax.io)
               → [later] appliance packaging for on-prem (§8.1)
```

Multi-tenancy (auth, namespaces, visibility) is part of the **floor**, not a later phase — it is already in spec §10, and §6 and §7 of this document depend on it from the first deployment.
</content>

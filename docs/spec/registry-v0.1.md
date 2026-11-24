# Agent Interface Registry — Specification v0.1

Status: Draft for one-shot implementation
Scope: Minimal headless infrastructure (server side + executor side)
Language of normative statements: RFC 2119 (MUST, SHOULD, MAY)

This document describes **what** the system does and **what guarantees** it provides. It deliberately contains no implementation technology, library, storage engine, data format, or protocol choice beyond those the sponsor has fixed as business requirements (HTTPS with JSON responses for the Registry Server; JSON as the sole Manifest format; full support for MCP as a Resource implementation protocol; JSON Schema as the sole form of a record schema; Google Sign-In as the login of the reference Auth Server in v1). Any such choice not stated here is left to the implementer.

---

## 1. Purpose

The Registry is a catalog of **interfaces that AI agents may use on behalf of a human**. Every interface is a *Resource* and is one of four kinds:

- **Data Source** — something an agent reads.
- **Action** — something an agent executes, producing effects in an external system.
- **Executor** — an organization-operated machine on which Actions and Data Sources that cannot run on a caller's device are run.
- **Authenticator** — a way of obtaining credentials for a target system, shared by every Data Source, Action, and Executor that uses that system.

Treating execution places and credential flows as Resources puts them under the same visibility, Tier, audit, and service-level rules as everything else.

The Registry exists so that an organization (a company, a university, a city, a community) can make its work legible and controllable to agents while retaining:

1. **Visibility** — every access and execution is recorded as a definitive, non-restorable audit event.
2. **Control** — every Resource declares the authentication tier it demands, and that demand can only be strengthened, never weakened, by anyone downstream.

The Registry is modeled on package registries (npm, Docker Hub, GitHub) rather than on marketplaces: it supports private, namespaced, on-premises operation with optional reference to an upstream public registry.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Resource** | A versioned, immutable unit published to the Registry. A Data Source, an Action, an Executor, or an Authenticator. |
| **Authenticator** | A Resource of kind `authenticator` that describes and performs authentication to one target system. Data Sources, Actions, and Executors reference an Authenticator instead of carrying their own authentication; credentials it produces are cached once per caller and shared by every Resource that references it. |
| **Manifest** | The declarative description of a Resource (identity, kind, interface, governance declarations). Always a JSON document. |
| **Manifesto** | A static, plain-language JSON file at `{domain}/manifesto.json` that tells a newcomer what this system is and who is responding. Referenced by every response (§10A). Not to be confused with a Resource's Manifest. |
| **Package** | A Manifest plus the code that implements the Resource, stored as one immutable version. |
| **Namespace** | An ownership and visibility scope for Resources, written `@name`. |
| **Namespace role** | A Principal's authority within a namespace: `owner` (full control, including namespace policy and member management), `publisher` (publish and manage versions), or `reader` (read and use its Resources). A **member** is a Principal holding any of these roles; where this document says "members" (§8.5) it means every role, not the `reader` role alone. |
| **Registry Server** | The service that stores Manifests, resolves Resources, enforces namespace visibility, and ingests audit events. |
| **Code Repository** | The service that stores Packages by immutable version. |
| **Auth Server** | Whatever issues Registry tokens (§7.2) for a given Registry. The public Registry's Auth Server uses Google Sign-In; a Private Registry MAY run any Auth Server that issues conforming tokens. |
| **Authenticator service** | The service, off the caller's device, that mints an Authenticator's credential material and takes its identification and authorization decisions: the Authenticator's own backend or the target's identity provider (§4.7, §7.3). |
| **Executor CLI** | The client on a caller's device that fetches a Resource, relays the authentication and authorization interactions that Authenticator services require, invokes the Resource or dispatches it to an Executor Resource, and keeps the caller's own audit log. In v1 a command-line program. |
| **Executor Resource** | A Resource of kind `executor`: an organization-operated machine registered in the Registry that accepts dispatched work. Where this document says "trusted executor", it means an Executor Resource. |
| **Provider** | The service that answers a `server`-location Resource's operations (§6.5), operated by or for its namespace's owner. A namespace MAY register its Providers with the Registry (§10); a registered Provider enforces Tier and approvals itself (§6.5) and writes the audit of every `server` Resource of its namespace under its own service identity (§8.2a). |
| **Application** | A program other than an Executor CLI or an Executor Resource that invokes a `server` Resource on a Principal's behalf: a web portal, a hosted app, a service. A Provider records it as the *caller* (§4.6, §8.2a). |
| **Approval** | One human decision bound to one exact request of a gated Action (§6.4): a single-use confirmation (§4.7) signed by the Authenticator service of the Action's namespace, which the executing party checks before `execute`. |
| **Principal** | An authenticated human or service account. |
| **Caller** | The Principal on whose behalf a Resource is being invoked. In an operation's context (§4.6), the party that presented the invocation: a device, an Executor Resource, or an Application. |
| **Tier** | One of the four authentication tiers defined in §7. |
| **Private Registry** | A Registry Server instance operated by one organization, typically on-premises. |
| **Upstream** | A public Registry that a Private Registry may reference for Resources outside its own namespaces. |

---

## 3. System Components

### 3.1 Server side

| Component | Responsibility | Interface requirement |
|---|---|---|
| Registry Server | Manifest storage, search, resolution, namespace and visibility policy, verification status, audit ingestion, audit query | MUST expose its API over HTTPS and return JSON response bodies |
| Code Repository | Immutable storage and retrieval of Packages by `@namespace/name@version`; integrity verification | MUST guarantee that a published version is never modified or deleted (see §4.4) |
| Auth Server | Token issuance, refresh, and revocation for one Registry | MUST issue tokens conforming to §7.2. The reference implementation shipped with the public Registry authenticates with Google Sign-In; a Private Registry MAY substitute its own. |
| Provider (optional, per namespace) | Answers the `server` Resources of one namespace: verifies the caller's token, applies Tier and approvals, writes their audit (§6.5, §8.2a) | MUST accept only tokens issued for its own audience (§7.2) and MUST write audit only for Resources of its namespace |

The three server components MAY be deployed as one process or as separate processes. This document treats them as logically distinct. A Provider is operated by the namespace owner, not by the Registry operator; the Registry knows it by its registered identity (§10).

### 3.2 Executor side

| Component | Responsibility |
|---|---|
| Executor CLI | Resolve a Resource, verify Package integrity, run the authorization flow for the Resource's effective Tier, invoke the Resource locally or dispatch it to an Executor Resource, keep the caller's local audit log, manage local credential cache |
| Executor Resource (organization-operated) | Accept dispatched work for Resources declared `trusted-executor`, run them with organization-held credentials, emit audit events including consumed CPU time |

The Executor CLI is the **only** component that touches end-user personal credentials for external systems. Executor Resources hold organization credentials only. See §7.6 and §6.5.

---

## 4. Resource Model

### 4.1 Identity

A Resource is identified by `@namespace/name@version`.

- `namespace` MUST be globally unique within one Registry Server and MUST be owned by exactly one organization or individual account.
- `name` MUST be unique within its namespace.
- `version` MUST be unique within `@namespace/name`. The Registry MUST treat versions as opaque, totally ordered labels; the ordering rule is declared by the namespace (default: semantic ordering).

### 4.2 Kind

Every Resource MUST declare exactly one kind: `data-source`, `action`, `executor`, or `authenticator`.

An `executor` Resource represents a place where work runs rather than work itself (§6A). An `authenticator` Resource represents how a target system is logged into rather than what is done there (§4.7). Both are published, versioned, made visible, verified, Tiered, audited, and given a service level declaration exactly like Data Sources and Actions.

### 4.3 Manifest (common fields)

A Manifest MUST be a single JSON document. No other serialization is accepted at publish time, and the Registry Server MUST return Manifests as JSON. Field names below are normative; their JSON spelling (casing, nesting) is implementer's choice but MUST be consistent across the whole system.

Every Manifest MUST contain:

| Field | Requirement |
|---|---|
| identity | `@namespace/name@version` |
| kind | `data-source`, `action`, `executor`, or `authenticator` (§4.2) |
| summary | One-line human-readable description |
| description | Free-text description; MAY include informal guidance such as how to query the source (see §5.4) |
| owner | Contact of the publishing Principal or team |
| required tier | The minimum Tier the Resource demands (§7.3) |
| execution location | `caller-device`, `trusted-executor`, or `server` (§6.5). Required for `data-source`, `action`, and `authenticator`; for an `authenticator` it MUST be `caller-device` when the subject is `personal` and `trusted-executor` or `server` when the subject is `organization`, and is absent when the subject is `machine`. Absent for `executor`, which is itself a location. |
| audit scope | Which event classes this Resource emits beyond the mandatory set (§8.3) |
| integrity | A digest of the Package contents, computed at publish time |
| dependencies | Other Resources this Resource invokes, by identity. Transitive Tier requirements are computed from this list (§7.4). |
| interface mapping | How each Fixed Interface operation (§4.6) is realized by the Package: native, or a mapping to a specific MCP tool or resource. Every operation applicable to the Resource's kind MUST be mapped. |
| authenticator | For `data-source`, `action`, and `executor`: the identity of the Authenticator Resource whose credentials this Resource uses, or `none` when the target requires no authentication. For `authenticator`: absent; the authentication specification (§4.7.1) takes its place. |
| service level declaration | Lateness budget or per-attempt failure probability, latency, expected-fault list, degradation behavior, dependency assumptions, measurement, support (§13). |

Kind-specific mandatory fields are defined in §5 and §6.

### 4.4 Immutability

- A published version MUST NOT be altered. Any change requires a new version.
- A published version MUST NOT be deleted. It MAY be marked **deprecated** or **yanked**.
  - *Deprecated*: still resolvable; resolution responses carry a warning.
  - *Yanked*: not returned by search or by "latest" resolution; still resolvable by explicit version so that audit records remain reproducible.

### 4.5 Visibility and Verification are independent axes

Each Resource version carries two independent attributes:

| Axis | Values | Set by |
|---|---|---|
| **Visibility** | `public`, `namespace-only`, `grant-list` | Namespace owner |
| **Verification status** | `unverified`, `under-review`, `verified`, `rejected` | Registry operator or delegated reviewer |

- A `public` Resource MAY be `unverified`. A `namespace-only` Resource MAY be `verified`.
- Search results and resolution responses MUST surface both attributes separately.
- The Registry MUST NOT present visibility as a proxy for trust in any user-facing output.
- A Private Registry MAY set a policy that forbids resolution of `unverified` Resources from Upstream.

### 4.6 Execution unit and the Fixed Interface

Every Resource MUST expose the **Fixed Interface**: a closed, pre-determined set of operations defined by this specification. The Registry Server and the Executor interact with a Resource **only** through the Fixed Interface. No operation outside this set is reachable through the Registry, regardless of what the underlying implementation offers.

| Operation | Applies to | Purpose | Section |
|---|---|---|---|
| `describe` | all | Return the Resource's self-description; MUST be consistent with the published Manifest | 4.3 |
| `authenticate` | authenticator | Obtain, refresh, or verify the caller's credentials for the target system. Distinct from Registry authentication (§7.1). | 4.7 |
| `confirm` | authenticator | Obtain the person's authorization for one invocation, signing them in within the same interaction when they are not yet authenticated | 4.7 |
| `metadata` | data-source | Return `{ schema, metadata }` for the one collection, caller-relative | 5.2a, 5.3 |
| `read` | data-source | Return an array of records (§5.7). The parameter schema for `read` is declared per Resource in the Manifest; the Registry does not standardize parameter semantics (§5.4) | 5.4, 5.7 |
| `dry-run` | action | Perform the declared dry-run mode | 6.1 |
| `execute` | action | Perform the Action with an idempotency key | 6.2 |
| `capabilities` | executor | Return what this Executor Resource can run: network reach, credential kinds held, concurrency limit, scheduling support, current load | 6A.2 |
| `dispatch` | executor | Run a named Resource operation (`read`, `dry-run`, or `execute`) on this Executor Resource on behalf of the dispatching Principal | 6A.3 |

Every operation receives, in its context, the **caller** it is answering: the caller's device identifier, the Executor Resource that dispatched it, or the Application (§2) that invoked a `server` Resource. A server-side Resource records the caller when it writes its audit (§8.2a), as `unknown` when the context did not carry one.

Any operation MAY respond with a **step-up** signal instead of a result (§7.4). The Executor MUST treat a step-up as a Fixed Interface response, not as an error.

**MCP as implementation protocol.** A Resource's Package MAY be an MCP server, over any MCP transport. The Registry MUST fully support publishing, resolving, and executing MCP-based Resources. However:

- The Manifest MUST map each Fixed Interface operation onto the MCP server's concrete tools or resources. The Executor invokes only those mapped targets.
- MCP tools or resources not mapped in the Manifest are **not reachable** through the Executor. Dynamic tool discovery at run time MUST NOT be used to extend what a Resource can do.
- The MCP transport (stdio, HTTP, SSE, or any future transport) is an implementation detail of the Package and MUST NOT change the Fixed Interface the Executor sees.

A Package MAY also implement the Fixed Interface natively, without MCP. The Executor MUST treat both cases identically above the mapping layer.

### 4.7 Authenticator Resources and the `authenticate` operation

Two authentications occur in every invocation and MUST NOT be conflated:

| Authentication | Between | Owned by |
|---|---|---|
| Registry authentication | Caller ↔ Auth Server | Executor CLI (§7.1, §7.2) |
| Target authentication | Caller ↔ the external system a Resource acts on | An Authenticator Resource, via `authenticate` |

An **Authenticator** is a Resource of kind `authenticator` that knows how one target system authenticates and performs that flow. Data Sources, Actions, and Executors do not authenticate themselves; each names the Authenticator it uses in its Manifest. The Executor CLI runs the Authenticator's `authenticate`, caches the resulting credential material once per caller and Authenticator (§7.6), and hands that material to every Resource that references the same Authenticator. A Google-account Authenticator serves a mail Data Source and a calendar Action alike; an ERP service-account Authenticator serves every Data Source exported from that ERP. Logging in once is therefore the norm, and a login is never repeated because a second Resource happens to use the same system.

Division of responsibility:

- The **Authenticator** drives the flow and owns its decisions: it tells the Executor CLI what interaction is required (none, open a browser-based login, show a device code, accept a secret), identifies the person to the target system, decides whether an invocation is authorized at the Tier it runs at (§7.3), and produces credential material that the target accepts only within what it decided. A decision that must hold against the caller is taken by the **Authenticator service** — the service, off the caller's device, that mints the credential material: the Authenticator's own backend or the target's identity provider — never by Authenticator code running on the caller's device.
- The **Executor CLI** provides the interaction surface, relays pending interactions (§7.8), caches the credential material, and supplies it to referencing Resources' operations. It enforces nothing on the Authenticator's behalf (§7.3).
- The **referencing Resource** receives credential material as input to its operations and MUST NOT perform target authentication on its own.
- The **Registry Server** never sees target credentials and takes no identity or authorization decision in this operation. It MAY hold the intermediate state of a pending interaction for an Authenticator service (§7.8), as storage only.

Every Authenticator MUST declare a **subject**:

| Subject | Meaning | Who may reference it |
|---|---|---|
| `personal` | Credentials belong to the calling human | Resources declared `caller-device` only |
| `organization` | Credentials belong to the organization (a service account) | Resources declared `trusted-executor`, and `caller-device` Resources when namespace policy allows |
| `machine` | Credentials identify a registered machine | Executor Resources only (§6A.4) |

`authenticate` MUST support the following modes, requested by the Executor CLI:

| Mode | When |
|---|---|
| `initial` | No cached credential exists for this caller and Authenticator |
| `refresh` | A cached credential exists but a referencing Resource reports it expired or invalid |
| `verify` | Confirm that a cached credential is still valid without performing any other operation |
| `step-up` | A referencing Resource has demanded a stronger Tier (§7.4) and requires re-authentication to the target |

Every call to `authenticate` MUST produce an `auth` audit event (§8.3) recording the Authenticator, the mode, and the outcome, but never the credential material.

**`confirm`** obtains the person's authorization for one invocation, named by its invocation descriptor (§7.8). Authentication and authorization are distinct (§7.3), but `confirm` does not require a prior `authenticate`: when the person is not authenticated — or the Tier demands a fresh authentication — the Authenticator service signs them in within the same interaction and takes both at once; when they are, it asks for the authorization alone, a lighter interaction than signing in again. Its result is a **confirmation**: material the Authenticator service issues and signs, carrying the subject who confirmed, the resource, the operation, the request hash, the audience that is to accept it, an expiry, and a single-use id; it MAY also carry credential material when a sign-in took place. An Authenticator that serves operations at Tier 1 or 2 MUST implement `confirm`, or serve per-call authorization by re-authentication (§7.3). Every terminal `confirm` outcome MUST produce an `approve` or `reject` audit event (§8.3).

An Authenticator has its own required Tier (§7.3), which governs who may obtain credentials through it. The effective Tier of a Resource operation includes its Authenticator's Tier (§7.4). At effective Tier 1 the Executor CLI calls `confirm` at every invocation, and the Authenticator service authenticates the person afresh within it; at Tier 2 it calls `confirm` whenever it holds no authorization still within its lifetime (§7.4a). For an Authenticator that serves authorization by re-authentication (§7.3), the Executor calls `authenticate` in mode `step-up` instead, at the same points. The Executor calling is not the control: the Authenticator service MUST NOT issue material that lets a Tier 1 invocation proceed without that invocation's own interactive authentication and confirmation, or a Tier 2 invocation without a live authorization (§7.3).

A Resource whose target needs no authentication declares `authenticator: none`; it receives no credential material and no `auth` event is produced for it.

**At most one Authenticator per namespace.** A namespace MUST contain at most one Authenticator. Every Resource in that namespace that needs authentication references that one Authenticator; the rest declare `authenticator: none`. A namespace is therefore an **authentication domain** — one target system, one sign-in — so Resources are organized by service (`@slack/*`, `@google/*`, `@fastcampus/*`) rather than aggregated under one vendor namespace. This lets an agent surface serve a whole namespace as a single connector whose one sign-in (§4.7.1a) authenticates the caller to that namespace's target, and it keeps the credential shared across the namespace's Resources (§7.6) by construction. A Resource MUST reference only its own namespace's Authenticator.

When a service's standard sign-in does not fit — an organization needs a customized or more complex Authenticator (its own OAuth app, extra scopes, an internal IdP, or a multi-step flow) — it takes a distinct namespace that names both the organization and the service, for example `@customcompany-slack/*`, holding that custom Authenticator. The generic `@slack/*` and the organization-specific `@customcompany-slack/*` are then separate authentication domains, each still with its single Authenticator and its own connector. The convention keeps the one-Authenticator-per-namespace rule intact while letting an organization layer its own auth over a service without disturbing the shared one.

#### 4.7.1 Authentication specification in the Authenticator's Manifest

The Executor CLI cannot run an authentication flow it does not understand. Therefore every Authenticator's Manifest MUST contain an **authentication specification** that describes the flow in enough detail for the Executor CLI to carry it out and for a reviewer to assess it before use. The following items are mandatory:

| Item | Content |
|---|---|
| Target system | The external system these credentials are for, named so that reviewers can see which Resources ought to share this Authenticator. |
| Subject | `personal`, `organization`, or `machine` (above). |
| Interaction kind | One or more of: `none`, `browser-login` (the Executor CLI opens a URL and waits for completion), `poll-login` (the Executor CLI opens a login URL and collects the result by re-invoking `authenticate`, rather than holding the connection open — §4.7.1a), `consent-redirect` (a third-party consent screen returning to a callback the Executor CLI controls), `device-code` (the Executor CLI displays a code the user enters elsewhere), `secret-entry` (the user supplies a token or key directly). Several kinds MAY be declared in order of preference. `browser-login` is forbidden for subject `organization` and `machine`. |
| Interaction details | For each declared kind: the entry point the Executor CLI must open or display, the completion signal it must watch for, and the maximum time to wait. |
| Credential material | What the flow produces (an opaque session, a bearer token, a cookie set, a key pair), named so the Executor CLI can store it and hand it to referencing Resources. The Manifest MUST NOT contain actual credential values. |
| Lifetime | Declared validity period of the credential material, or `unknown`. Whether it can be refreshed without user interaction, and if so how `refresh` mode behaves. |
| Verification method | How `verify` mode determines validity without side effects. |
| Step-up behavior | What `step-up` mode requires beyond `initial`: a repeated login, an additional factor, or "same as initial". |
| Authorization enforcement | How a confirmation is held to what it confirmed (§7.3): who verifies it (the Authenticator service itself, a Provider, or the target); whether that verifier sees the actual request and so binds the confirmation to its request hash, or can bind it only to a short lifetime and narrow scope (a target that accepts a bearer credential alone); how its reuse is refused; how a Tier 2 authorization's lifetime is bounded (§7.4a); `re-authentication` when it serves authorization by a fresh sign-in (§7.3), stating how the material from that sign-in is kept from outliving the invocation or the authorization lifetime; or `none` when it enforces none of these. |
| Required inputs | Any information the Executor CLI must collect from the user before starting (for example, which account among several to use). |
| Scope requested | For `consent-redirect`: the permissions requested from the target system, listed so a reviewer can judge whether they are proportionate to the Resources that reference this Authenticator. |
| Revocation | How the user or operator revokes the credential at the target system, as a human-readable instruction. |

Requirements:

- The Executor CLI MUST refuse to use an Authenticator whose Manifest lacks any mandatory item above, and MUST refuse to run a Resource whose referenced Authenticator cannot be resolved.
- The Executor CLI MUST use only the interaction kinds declared; an Authenticator MUST NOT request an undeclared interaction at run time.
- An Authenticator whose authorization enforcement is `none` cannot hold an invocation to Tier 1 or 2. The Registry MUST refuse to publish a Resource whose required Tier is 1 or 2 and that references such an Authenticator, and MUST refuse a namespace Tier floor of 1 or 2 while the namespace's Authenticator declares `none`.
- Verification review (§4.5) of an Authenticator assesses `scope requested` against the operations of the Resources that reference it. An Authenticator whose scopes are broader than any referencing Resource needs SHOULD NOT receive `verified` status, and a Resource SHOULD NOT receive `verified` status while referencing an unverified Authenticator.
- The specification is descriptive of the flow, not an implementation of it.

#### 4.7.1a `poll-login`: web login without copying a token

`poll-login` is the non-blocking counterpart to `browser-login`, for an Executor that cannot hold a connection open for the duration of a web login — for example a request/response surface such as an MCP gateway, where the caller re-invokes the operation to collect the result. It lets a user sign in through a web page instead of copying a token, while reusing the same `authenticate` endpoint.

In `poll-login`, `authenticate` in mode `initial` or `step-up`, and `confirm`, MAY return a **pending** result — the entry point to open and an opaque continuation handle — instead of credential material. The Executor CLI opens the entry point (a terminal prints or launches the login URL; a web surface returns it to the caller), and then calls the same operation again, in the same mode, carrying the handle. The Authenticator returns the credential material or confirmation once the web interaction has completed, or a pending result again until the declared maximum wait elapses, after which it MUST fail rather than return pending indefinitely. A pending result carries no credential material and is not itself a credential.

The interaction details for `poll-login` MUST give the entry point, the poll interval, and the maximum wait. The `auth` audit event (§8.3) is produced on the terminal outcome (credential issued, declined, or timed out), not on each intervening poll.

An Authenticator MAY offer `secret-entry`, `poll-login`, or both. Each client then uses whichever it supports and finds convenient — a terminal that can open a browser polls; a client where supplying a token directly is simpler takes that. The credential material produced, its lifetime, verification, and everything downstream are identical whichever the client uses.

The web login `poll-login` performs is the target system's own (for example a Google SSO the target trusts): the Authenticator uses that sign-in to establish the user's identity, decides whether the user is authorized, and issues its own credential material for the target. That credential is distinct from any Registry token and from the identity token consumed during sign-in (§7.2 audience rules); `poll-login` does not exchange one for another.

`poll-login` is one use of the pending exchange in §7.8, which governs the invocation descriptor, the handle and its binding to the Executor that started it, asynchronous completion, and where the pending state is kept.

---

## 5. Data Source Resources

### 5.1 Principle: the source decides what it returns

The Registry confirms **who** is calling and at which Tier. **What** data that caller receives is decided by the Data Source itself. The Registry MUST NOT filter, redact, or shape data returned by a Data Source. This keeps control effective even when the Registry is bypassed, and keeps the Registry ignorant of every source's permission model.

### 5.2 One Data Source, one collection

A Data Source exposes exactly **one** collection of records. A system that holds several tables, sheets, or feeds is published as several Data Sources, one per collection. This is enforced: a Data Source MUST NOT return records of more than one record type, and its `metadata` describes one record type only. The reason is that Tier, service level, refresh cadence, and lateness budget are declared per Resource (§7.3, §13), and these differ between collections in practice: orders and purchase orders in the same ERP may refresh on different schedules and be visible to different people. A dashboard that needs both reads two Data Sources.

### 5.2a Mandatory `metadata` response

Every Data Source MUST answer `metadata` with a response of this shape. It is mandatory and machine-readable; an Executor MUST be able to obtain it before fetching any data.

| Field | Content |
|---|---|
| `schema` | A JSON Schema describing one record. It MUST describe each field's name, type, and whether it may be absent or null; it MAY describe units, enumerations, and relationships to other Data Sources. JSON Schema is the only permitted form, because it is already the common format for describing structured inputs and outputs to language models. |
| `metadata` | An object with the following fields: |
| `metadata.timeRange` | Earliest and latest timestamps of data available, or an explicit "not time-indexed" marker |
| `metadata.recordCount` | Exact or estimated count, with an explicit exact/estimate flag |
| `metadata.lastRefreshed` | The timestamp at which the data was last updated |
| `metadata.refreshCadence` | Declared expected refresh interval (e.g., "daily at 06:00", "30 seconds", "on demand", "unknown"), or `static` for a source whose content changes only by publishing a new Resource version (§5.6) |
| `manifesto` | Per §10A |

### 5.3 Metadata is caller-relative

Because the source decides what the caller may see (§5.1), the `metadata` response MUST reflect the **caller's** view. The same Data Source MAY report a different `schema` (a field the caller may not see is absent from it), a different time range, or a different count to different callers. Therefore:

- `metadata` requests MUST pass through the same authentication flow as `read` requests.
- The Manifest MUST NOT contain the schema, range, or count. They come from the source at call time.

### 5.4 Query interface is out of scope

The mandatory interface does **not** include a standardized query (filter, aggregate, join). Each Data Source exposes whatever retrieval interface it chooses. The Manifest's `description` field SHOULD explain, informally, how to retrieve data (supported filters, pagination, limits). The Registry MAY display this text; it MUST NOT attempt to interpret or validate it.

### 5.5 Staleness disclosure

Any consumer that renders data from a Data Source (for example, a dashboard) SHOULD display the source's `lastRefreshed` value alongside the data. The Registry's own audit record for a read MUST capture the `lastRefreshed` value reported at read time (§8.4), so that a number seen by a decision-maker can later be traced to the source state it came from.

### 5.6 Snapshot Data Sources

A **snapshot** is a Data Source whose refresh cadence is `static`: planning documents, policy handbooks, organization charts, pre-computed reports, and other content that changes only when someone deliberately issues a new edition.

- A snapshot MAY embed its data in the Package itself. In that case `read` returns content from the Package, a new edition is a new Resource version (§4.4), and the `data-read` audit event coincides with the `fetch` event. Immutability, integrity verification, and audit apply with no additional mechanism; the question "who read edition 3 of the plan, and when" is answered by the existing audit log.
- A snapshot's `lastRefreshed` (§5.2a) is the publish time of the version being read. Its time range is `not time-indexed` unless the content itself is a time series. A snapshot whose content is a single document returns `data` as an array of one record.
- Lateness (§13.1.2) is **not** computed from data age for a snapshot, since age grows without bound by design. Instead, a snapshot is counted as unavailable for every instant at which it cannot serve `read`. Its availability is therefore reachability, not freshness.
- A snapshot that embeds its data has no run-time external dependency and MAY credibly declare an empty expected-fault list (§13.2). A snapshot that fetches its content from an external store at read time MUST declare that store's faults.

### 5.7 Shape of a `read` response

| Field | Content |
|---|---|
| `data` | An **array** of record objects, each conforming to the `schema` reported by `metadata` (§5.2a). One record is an array of one; no records is an empty array. |
| `freshness` | The `lastRefreshed` value that applied when `data` was produced |
| `continuation` | How to request the rest when `data` is a page of a larger result, in the form the Manifest declares; otherwise null |
| `manifesto` | Per §10A |

A record state such as a route that has finished service for the day is a normal record with a status field; a fault is when the source cannot answer (§13.2).

---

## 6. Action Resources

### 6.1 Dry-run declaration

Every Action MUST declare exactly one dry-run mode:

| Mode | Meaning |
|---|---|
| `none` | The Action cannot be previewed. The Executor MUST warn the caller before execution. |
| `predictive` | The Action can read observable state (a cart, input values, a balance) and compute the expected outcome **without sending anything to the target system**. The result is an *estimate* produced by the Resource, not a result guaranteed by the target. |
| `native` | The target system itself offers a simulation facility and the Action uses it. |

Requirements:

- A `predictive` dry-run MUST produce zero side effects in the target system. "Proceed up to the final confirmation step" does **not** qualify as a dry-run under any mode.
- Dry-run results of mode `predictive` MUST be labeled `estimated` in every surface where they appear, including the audit record (§8.4), so that divergence between estimate and actual outcome has a clear owner.

### 6.2 Idempotency declaration

Every Action MUST declare exactly one idempotency class:

| Class | Meaning |
|---|---|
| `idempotent` | Repeated execution with the same idempotency key produces the same end state and no additional effects. |
| `keyed` | The Action accepts an idempotency key and guarantees at-most-once effect per key within a declared window. |
| `non-idempotent` | Repetition may produce repeated effects. The Executor MUST require explicit caller confirmation before any retry. |

- Actions that write to shared records (for example, "refresh ERP data into internal DB") SHOULD be `idempotent` or `keyed`. A Private Registry MAY enforce this as a namespace policy.
- The Executor generates and records the idempotency key; the Action receives it as input.

### 6.3 Recovery action declaration

Every Action MUST declare its recovery behavior:

| Value | Meaning |
|---|---|
| `none` | No recovery is available. |
| reference to another Action | A **compensating action** that moves the system toward the pre-execution state. |

Recovery is explicitly **not** an undo. It is a forward action with its own effects, and therefore:

- A recovery action MUST itself be a registered Action with its own Manifest, Tier, dry-run, idempotency, and audit declarations.
- Executing a recovery action MUST produce its own audit event, linked to the original execution's event (§8.4).

### 6.4 Human-in-the-loop gating and the approval artifact

An Action MAY declare that execution requires an out-of-band approval. Such an Action MUST declare Tier 1 or Tier 2 (§7.3). The approval is a **confirmation** (§4.7) issued by the Authenticator service of the Action's own namespace: one human decision bound to one exact request, checked by the party that runs the Action. No step involves the Registry, so a gated Action reached without a Registry (an Application invoking a Provider directly) is gated the same way.

1. **Request hash.** On `dry-run`, the party that will execute — the Provider for a `server` Resource — computes the request hash: `sha256` of the canonical JSON (keys sorted recursively, no whitespace) of `{resource: "@namespace/name", operation: "execute", input: <the normalized input>}`. It starts `confirm` (§7.8) with that hash and a plain-language summary of what will happen, and returns the pending entry point to the caller. The summary the person reads is the executing party's, not the agent's.
2. **Decision.** The person decides at the Authenticator service's page. It identifies them by its own sign-in — taken in the same interaction when they are not signed in, and always afresh at Tier 1 — so an agent holding the caller's tokens cannot decide. The Authenticator service records `approve` or `reject` (§8.3), and the decision stands once; it cannot be changed. An undecided confirmation expires after a period the Authenticator declares.
3. **Consumption.** On `execute`, the caller presents the confirmation. The Provider verifies it with the Authenticator service's verification key, which it trusts by its own configuration and not through the Registry. It MUST accept the confirmation only if the signature and audience are valid, the resource and operation match, the request hash it **recomputes from the request in hand** matches, and the subject is the caller it authenticated; and it MUST accept it **once**: a confirmation is single use, enforced by the Provider. A retry carrying a used confirmation returns the first result, which makes the confirmation's id the idempotency key of a gated `execute` (§6.2).

The agent may prepare everything; only the person can make it happen. How the person is notified (a messenger, mail) is not specified (§14).

### 6.5 Execution location

Every Data Source, Action, and Authenticator MUST declare where it runs (an Executor Resource is a location and declares none):

| Location | Meaning | Credential implication |
|---|---|---|
| `caller-device` | Runs on the caller's machine via the Executor CLI | Uses the caller's personal credentials, cached locally (§7.6). Audit events are reported by the Executor CLI into its local log and are NOT delivered to the central store (§8.2). |
| `trusted-executor` | Runs on an Executor Resource (§6A) that matches the Resource's declared executor requirements | Uses organization-held system credentials. Audit events are produced by the Executor Resource that ran it. |
| `server` | The Resource is its own hosted service — a server, Lambda, or MCP endpoint its publisher operates (its Provider, §2) — invoked directly over its binding, not dispatched | Uses credentials the server holds. The server produces its own audit events, under its resource token or its Provider's identity (§8.2a). |

`trusted-executor` and `server` differ in who provides the runtime: a shared §6A Executor Resource for the former, the Resource's own operator for the latter. Both run server-side and write the central audit; only `caller-device` work stays off it. Scheduled or unattended Actions (for example, nightly data refresh) MUST declare `trusted-executor` or `server`.

**Enforcement for `server` Resources.** The Executor CLI's authorization flow (§9.1) runs on the caller's device, which the caller controls: a browser can be edited and a CLI run with a flag that answers its own prompts. That is acceptable for reads of public data and not for writes to a system of record. A `server` Resource therefore MUST NOT rely on it. Its Provider is the enforcing party and MUST, on every invocation it serves: verify the caller's credential — a token issued for this Provider (§7.2), or material its own namespace's Authenticator service issued (§4.7); map the request to a Resource and operation; apply the Resource's declared Tier from a Manifest it trusts (its own published Manifest, pinned by digest); require a confirmation (§4.7, §6.4) where the effective Tier is 2 or stronger; and write the audit event itself (§8.2a). What the Executor does is the interaction surface, not a gate (§7.3). A `server` Resource invoked by an Application (§2) is held to the same rules, with the Application as *caller*.

### 6.6 Out-of-band payloads

An Action whose input or output is bulk data (a file, a ledger, an export) MAY move the bytes outside the invocation: the operation covers the control steps (issuing a short-lived reference to upload or download, confirming completion), and the bytes travel directly between the caller and storage the Provider controls. Such an Action MUST declare this in its Manifest. The reference MUST be short-lived and bound to one invocation, and the `execute` event MUST record the payload's size and digest as the Provider observed them (§8.2a), so that the audit names exactly which bytes the Action processed.

**Execution location is a constraint, not a preference.** The following rules exist to resist the pressure to move device-runnable work onto shared machines, which would concentrate personal credentials centrally, blur the audit actor, and turn shared machines into everyone's bottleneck:

1. An Executor Resource MUST refuse to `dispatch` any Resource declared `caller-device`. No configuration, flag, or namespace policy MAY override this refusal. The only way to run such work on an Executor Resource is to publish a new Resource version declared `trusted-executor`, which passes through verification review.
2. A Resource declared `trusted-executor` MUST reference an Authenticator of subject `organization` or `none` (§4.7). It MUST NOT reference a `personal` Authenticator. A personal booking Action and an organization-account booking Action are therefore different Resources referencing different Authenticators, with different actors, as they should be.
3. A Resource declared `trusted-executor` MUST declare its **executor requirements** (§6A.5), so that the Registry can match it to an Executor Resource and reviewers can see why shared execution is needed.

The legitimate reason to move work to an Executor Resource is that it must run when no person is present. Such work cannot use personal credentials in any case, so rule 2 costs it nothing.

---

## 6A. Executor Resources

### 6A.1 Definition

An Executor Resource is a Resource of kind `executor`. It describes one organization-operated execution place (a machine, a container host, a scheduled-job runner) that accepts work for Resources declared `trusted-executor`. One Executor Resource version corresponds to one registered machine identity; replacing the machine is a new version.

### 6A.2 `capabilities`

`capabilities` MUST return, caller-relative where the Executor Resource's own Tier applies:

| Item | Content |
|---|---|
| Network reach | Which networks or named systems the machine can reach (for example, "internal ERP", "public internet", "none") |
| Credential kinds held | Which organization credentials are available on the machine, by kind and target system, never by value |
| Concurrency limit | Maximum simultaneous dispatches |
| Scheduling support | Whether it accepts deferred or recurring dispatch, and the scheduling granularity |
| Current load | Number of dispatches queued and running at the time of the call |
| Resource constraints | Any kinds, namespaces, or specific Resources it will or will not run |

### 6A.3 `dispatch`

`dispatch` takes a target Resource identity, the operation to run (`read`, `dry-run`, or `execute`), the operation's inputs, and the idempotency key generated by the Executor CLI. The Executor Resource then:

1. Verifies the dispatching Principal's token and its own effective Tier (§7.4).
2. Refuses if the target Resource is declared `caller-device` (§6.5 rule 1), if its executor requirements (§6A.5) are not met by this machine, or if its own resource constraints exclude it.
3. Resolves and fetches the target Resource through the Private Registry, verifying integrity, exactly as the Executor CLI would.
4. Obtains credentials through the target's referenced Authenticator (subject `organization`) using material it holds, then runs the requested operation.
5. Emits a `dispatch` audit event: who used this machine to run which Resource's operation (§8.2). The target Resource writes its own record of answering, with this Executor Resource as *caller* (§8.2a), linked to the `dispatch` event (§8.4). Both events carry the Executor Resource's identity in *execution location* and the consumed CPU time in *executor cpu time*.
6. Returns the operation's result, or a declared fault class, to the Executor CLI.

The `dispatch` operation MAY accept a schedule when `capabilities` reports scheduling support. A scheduled dispatch emits one `dispatch` event at scheduling time and one linked set of events at each run.

### 6A.4 Machine identity

An Executor Resource references an Authenticator of subject `machine` (§4.7). That Authenticator's specification MUST declare interaction kind `none` and MUST describe how the machine's identity is established and renewed, how the Registry verifies it on each `dispatch`, and how an operator revokes it. The Registry MUST refuse `dispatch` to an Executor Resource whose machine identity has not been verified within the period that Authenticator declares.

### 6A.5 Executor requirements on target Resources

A Data Source or Action declared `trusted-executor` MUST include an **executor requirements** block in its Manifest stating the capabilities it needs: required network reach, required credential kinds, whether scheduling is required, and optionally a list of acceptable Executor Resource identities. Matching is by capability, so that replacing a machine does not force republication of every Resource that ran on it. A Resource MAY pin specific Executor Resource identities when its publisher wants that control.

### 6A.6 Tier and audit

- The effective Tier of a dispatched operation is the strongest of the target Resource's effective Tier (§7.4) and the Executor Resource's own required Tier. The Executor Resource's Tier is the control over **who may use the machine**; the target's Tier is the control over **who may do the work**. Namespace policy SHOULD set the Executor Resource Tier floor at Tier 2 so that every dispatch carries a per-call authorization check, subject to any Tier 2 authorization token lifetime the namespace policy sets (§7.4a).
- The audit actor for a dispatched operation is the dispatching Principal, never the machine. The machine appears in *execution location*.
- Every event emitted by an Executor Resource MUST include *executor cpu time* (§8.4), so that machine consumption is attributable to a Principal and a Resource and queue pressure is visible in audit queries.

### 6A.7 Service level

An Executor Resource's service level declaration (§13) uses the snapshot rule (§5.6): its unavailability is every instant at which it cannot answer `capabilities`, and it MUST additionally declare a dispatch queue latency target. Its expected faults are the machine's own: unreachable, at capacity, machine identity expired, required credential missing.

---

## 7. Authentication and Authorization

### 7.1 Identity: the token is the contract, not the login

This specification does not prescribe how a Principal proves who they are. It prescribes only the **token** that results (§7.2), so that every Registry Server, Executor CLI, and Executor Resource can verify a caller the same way regardless of how the caller logged in.

- The reference Auth Server, used by the public Registry, authenticates with Google Sign-In and nothing else in v1. It does not implement its own password-based accounts.
- A Private Registry MAY run its own Auth Server backed by whatever identity system the organization already has (its SSO, directory, or the reference implementation configured for its domain). Nothing in this specification depends on which it chooses, provided the tokens it issues conform to §7.2.
- A Principal's identity is whatever identity the issuing Auth Server asserts in the token. Identities from different Auth Servers are distinct Principals even when they name the same person.

### 7.2 Token specification

A Registry token is a **signed, offline-verifiable** credential issued by an Auth Server. Any component holding the issuer's public verification material can check it without contacting the issuer. A Private Registry MUST be able to admit a caller without a network call to its Auth Server on each request.

The token MUST carry:

| Claim | Content |
|---|---|
| Issuer | The identity of the Auth Server that issued it |
| Principal | The caller's identity as asserted by the issuer |
| Namespaces | The namespaces the Principal may access |
| Issued at | Issuance time |
| Expires at | Expiry; this defines the "long-lived" period in Tiers 2 and 3 |

The token MUST NOT carry per-Resource permissions. Per-Resource decisions belong to the Private Registry (Tier, visibility) and per-record decisions to the Data Source (§5.1).

The token SHOULD also carry, and a Registry that registers Providers (§10) MUST issue:

| Claim | Content |
|---|---|
| Audience | Where the token may be presented: the Registry itself, or one Provider by its registered name. A token without an audience is a Registry token. The Registry MUST refuse a Provider-audience token; a Provider MUST refuse every audience but its own. |
| Channel | What kind of client the token was issued to: an executor (an Executor CLI or Executor Resource) or a web Application. |
| Method | How the token was obtained: a sign-in at the Registry, an exchange (below), or another registered way. |

A Provider-audience token is obtained by **exchange**: a holder of a Registry token asks the Auth Server for a token for one Provider, typically inside that Provider's Authenticator (`authenticate` exchanges; `refresh` exchanges again). Provider tokens SHOULD be short-lived (hours); Registry tokens MAY be long-lived (days). A Provider copies the audience, channel, and method of the token it accepted into the audit events it writes (§8.4). The audience says *where* a token may be presented; the Provider still decides *what* the Principal may do.

A Registry Server declares which issuers it trusts. The public Registry trusts its reference Auth Server; a Private Registry trusts its own and, when it references an Upstream (§12.2), MAY also trust the Upstream's issuer for Upstream resolution only. A Registry that serves several organizations MAY register trusted issuers **per namespace** (§10): a token from a namespace's registered issuer is admitted for that namespace, so that each organization keeps its own identity provider and the issuer stays a component outside the Resource graph (§7.5). Namespace policy MAY shorten the effective lifetime of a token below its expiry; nothing MAY lengthen it.

An Auth Server MUST publish the material needed to verify its tokens offline (its public keys) at a location the Registry advertises without a token.

### 7.3 The four Tiers

Tiers are ordered from strongest (Tier 1) to weakest (Tier 4).

**Who enforces a Tier.** A Tier is enforced by the party that issues what it guards: the Registry for Registry tokens (§7.2), the Authenticator service for target credential material and per-call authorization (§4.7), and the Provider for a `server` Resource (§6.4). The Executor — an Executor CLI, a gateway, an agent — runs on the caller's side and is not trusted. Every enforcing party MUST assume a call reaches it unauthenticated and unauthorized, and MUST NOT accept the Executor's assertion that an authentication or authorization took place. What an Executor does at a Tier — prompting, waiting, relaying a pending interaction (§7.8) — is the interaction surface, not the control.

**Authentication and authorization are distinct.** Authentication establishes who the caller is to the target; authorization decides whether this one invocation may proceed. The Authenticator service takes authorization through `confirm` (§4.7), which signs the person in within the same interaction when they are not authenticated and otherwise asks for the authorization alone.

**Re-authentication is a lightweight authorization.** Making the person sign in afresh for an invocation is itself a per-call authorization: the interactive sign-in is the person's decision to proceed. An Authenticator that does not implement `confirm` MAY therefore serve Tier 1 or 2 by re-authentication — `authenticate` in mode `step-up` for each invocation that needs authorization (§4.7), never answered from a cached credential. Like a confirmation, it holds against the caller only as far as the Authenticator service enforces it: the material a sign-in yields MUST NOT outlive the invocation at Tier 1, or the authorization lifetime at Tier 2 (§7.4a). An Authenticator declares this as its *authorization enforcement* (§4.7.1).

| Tier | Name | Behavior at invocation time |
|---|---|---|
| 1 | Interactive authentication and authorization | Every invocation is authenticated and confirmed interactively (`confirm` with a fresh sign-in, §4.7, §7.8). The confirmation is bound to that one invocation and its reuse is refused: no lifetime, flag, or configuration lets one invocation's authentication or authorization stand for the next. No authorization token is issued for Tier 1. |
| 2 | Long-lived authentication, per-call authorization | A valid long-lived authentication suffices for identity; authorization for an invocation MUST be given before it proceeds, unless an authorization granted for the same Resource is still within its lifetime (§7.4a). The authorization is a confirmation from the Authenticator service (`confirm`, §4.7), which a `server` Resource's Provider verifies itself (§6.4). The Executor cannot produce one. |
| 3 | Long-lived authentication, no per-call check | A valid long-lived token suffices; no further check is made. The audit record is the only control. |
| 4 | Unauthenticated execution | No Principal is required. The Executor MUST still record an audit event with an anonymous actor marker. |

### 7.4 Effective Tier — strengthening only

The Tier that actually applies to an invocation is:

```
effective_tier = strongest of (
    namespace policy floor,
    Resource's declared required tier,
    strongest required tier among the Resource's declared dependencies,
    any step-up the Resource demands at runtime,
    the required tier of the Resource's Authenticator (§4.7),
    the required tier of the Executor Resource, when dispatched (§6A.6)
)
```

- A Resource MUST be able to demand a stronger Tier than it declared, at runtime, based on what it observes (for example, an order above a threshold). This is a **step-up**. The Executor MUST honor a step-up.
- No component — not the Executor, not a dependent Resource, not the namespace, not the caller — MAY weaken a Resource's declared Tier.
- The effective Tier and the reason for any strengthening MUST be recorded in the audit event (§8.4).

### 7.4a Tier 2 authorization token

A Tier 2 authorization is **a grant with a lifetime, not a session**. When the person confirms a Tier 2 invocation (`confirm`, §4.7), the Authenticator service MAY let that authorization stand for further invocations of the same Resource until it expires, by issuing material that carries it — an **authorization token** — which the Authenticator service or the target verifies on every use. The Executor holds the token with the caller's credential material (§7.6) and presents it; it never mints, extends, or verifies one, and holding one is not evidence that the Executor may proceed (§7.3).

- The lifetime is **bounded by namespace policy**, which sets the maximum — seconds up to a few hours — exactly as a namespace MAY shorten any token's effective lifetime (§7.2). The Authenticator service MUST NOT grant longer, nothing outside the namespace policy MAY lengthen it, and the caller MAY always re-authorize sooner.
- The token is **scoped to a single Resource** (`@namespace/name`, independent of version). It never authorizes another Resource and never crosses namespaces; the Authenticator service refuses it for any other.
- **Tier 2 only.** Tier 1 never issues an authorization token; it is interactive at every invocation (§7.3), and no lifetime, flag, or configuration changes that.
- A namespace policy MAY set the maximum lifetime to zero to forbid authorization tokens, in which case every Tier 2 invocation is re-confirmed — the strict behavior is the default.
- An authorization token proves only that the authorization was given and has not expired. Identity is still proven by a valid long-lived Registry token (§7.2) on every call; the authorization token never substitutes for identity and never admits a credential weaker than the Tier requires, so it does **not** weaken the Resource's Tier (§9.2).
- For a `caller-device` Resource the Authenticator service grants and verifies the token; the caller's device only holds it (§6.5). For a gated Action (§6.4) the single-use confirmation governs; a Tier 2 authorization token never stands in for it.

### 7.5 Namespace access confirmation

An Auth Server's role is limited to asserting **who the Principal is and which namespaces they may access**, in the token. It does not and cannot know which Resources within a namespace the Principal uses. This boundary holds whether the Auth Server is the public reference one or an organization's own: the issuer sees accounts and namespace memberships, never Resource invocations or data.

### 7.6 Credential handling

- Credentials for external systems (the caller's login to a ticketing site, an ERP, a SaaS) MUST be stored only on the device where execution occurs: the caller's device for `caller-device` Resources, the trusted executor machine for `trusted-executor` Resources, the Provider's own systems for `server` Resources.
- Such credentials MUST NOT be transmitted to or stored by the Registry Server, the Code Repository, or the Auth Server.
- The cache is keyed by caller and Authenticator, never by Resource, so that every Resource referencing the same Authenticator uses the same cached material and a purge of one Authenticator's material affects all of them at once.
- The Executor MUST provide a command to list cached credentials by Authenticator, showing which Resources reference each, and to purge them.

### 7.7 Interactive Registry login from an Executor CLI

§9.1 has the Executor CLI obtain a Registry token "through whatever login that Auth Server uses". An Auth Server that signs people in only on a web page (Google Sign-In, an organization's SSO) would leave the caller copying a token from that page into a terminal. The following closes that gap the way `gh auth login --web` and `gcloud auth login` do: the CLI opens the page, and the page hands the token back to a listener on the caller's own machine (a loopback redirect, RFC 8252 §7.3).

**Discovery.** A Registry MUST declare its login methods at a location reachable without a token (§10, *login discovery*): a list drawn from `web`, `email`, and `token`, and for `web` the path of its login page. A Registry that does not answer is taken to offer `email` and `token`.

**The login page** signs the person in however its Auth Server does. It takes two query parameters:

| Parameter | Rule |
|---|---|
| `callback` | MUST be `http://127.0.0.1:<port>/<path>` or `http://localhost:<port>/<path>`. Anything else (another host, `https`, userinfo, a missing port) MUST be refused with an error on the page; the token is never sent. |
| `state` | MUST be present with `callback`: 22 to 128 characters of `[A-Za-z0-9_-]`, drawn by the CLI from at least 128 bits of entropy. Echoed back unchanged. |

After a successful sign-in the page delivers the token by a **top-level form POST** (`application/x-www-form-urlencoded`, fields `token` and `state`) to `callback`. It MUST NOT put the token in a URL: a query or fragment is kept in browser history and leaks through logs. A page opened without `callback` shows the token to copy, which is also the fallback when the browser runs on another machine than the CLI. A sign-in that fails is reported on the page and never reaches the callback.

**The CLI** reads the login methods and stops if `web` is not offered; listens on the loopback interface at an OS-assigned port and one random path; opens the browser at the login page with `callback` and `state` (and always prints the URL); waits for **one** POST to that path whose `state` matches, answering every other request with an error without ending the wait; then closes the listener, verifies the token against the Registry, and stores it as it would a pasted token. The wait has a timeout (default 300 seconds).

**Why this is safe.** The token goes from the browser to a listener bound to the loopback interface only, and the Registry refuses any callback that would send it elsewhere, so a crafted link cannot exfiltrate it. `state` binds the response to this CLI run, so another local page or process cannot inject its own token. A form POST keeps the token out of the address bar, history, and referrers. Nothing here changes the token (§7.2) or who may sign in: the page is the Auth Server's own login, and the CLI only saves the copying.

### 7.8 Pending interactions and asynchronous completion

A step that needs the person — signing in to the target, confirming one invocation, or both at once — can outlast one request. The Executor therefore never waits on the Authenticator service as a condition of correctness: every such step is a **pending exchange** that the Executor MAY complete within the same call (holding the connection, as `browser-login` does) or across calls (returning to its own caller and re-invoking later, as `poll-login` does). Both are the same exchange; only how long the Executor stays is different.

The exchange runs between the Executor and the Authenticator service alone. No step requires a Registry token or a call to a Registry, so it works the same for a Resource reached without a Registry — an Application invoking a Provider directly — and the identity it establishes is the Authenticator service's own subject, not a Registry Principal.

1. **Start.** The Executor calls `confirm` (or `authenticate` in mode `initial` or `step-up`, for authentication alone) with the effective Tier and a **challenge**: the `sha256` of a random verifier of at least 128 bits that the Executor keeps. `confirm` also carries the **invocation descriptor** `{resource, operation, requestHash}`, where `requestHash` is computed as in §6.4; for a gated Action the executing party starts it with its own summary (§6.4). The descriptor lets the Authenticator service show the person exactly what they are asked to allow and bind the confirmation to that invocation.
2. **Pending.** The Authenticator service answers `pending` with an entry point for the person, an opaque **handle**, a poll interval, and an expiry. The handle is unguessable and grants nothing by itself.
3. **Relay.** The Executor brings the entry point to the person: a terminal prints or opens it; a surface serving an agent returns it as the result of the call, and the agent re-invokes the same operation later. An Executor that keeps no state between calls (a gateway) hands the handle and verifier to its own caller to carry back, and is no more trusted for it (§7.3).
4. **Decision.** The person completes the step at the entry point, which is the Authenticator service's own page. It identifies the person by its own means (a sign-in the target trusts) and, for `confirm`, takes their decision on the described invocation — signing them in first within the same interaction when they are not authenticated or the Tier demands it afresh (§4.7).
5. **Collection.** The Executor calls the same operation again with the handle and the verifier. The Authenticator service returns the result only when the verifier matches the challenge, so a party that saw the entry point or the handle cannot collect it. Until the decision it answers `pending`; after the expiry or a refusal it fails, and it MUST NOT answer `pending` indefinitely. A handle is collected **once**.
6. **Use.** The verifier the Authenticator declares (§4.7.1, *authorization enforcement*) accepts a confirmation once, for the invocation it describes, recomputing the request hash from the request in hand wherever it sees the request. At Tier 1 the Executor discards any credential material that came with it after that one use; at Tier 2 the confirmation MAY carry an authorization token (§7.4a).

**Intermediate state.** The pending state belongs to the Authenticator service, which keeps it in its own store. It MAY instead keep it in a Registry's pending-state store (§10), when it has one: an entry keyed by the Authenticator and the handle, bounded in size and lifetime, written and read only under the identity registered for that Authenticator's service in its namespace (§8.2a). The store is storage only. The Registry interprets nothing in an entry and takes no identity or authorization decision from it, and an entry MUST NOT contain credential material (§7.6). Identifying the person precisely and deciding what they may do belong to the Authenticator (§4.7.1, *authorization enforcement*), never to the Registry.

The audit event (§8.3) — `auth` for `authenticate`, `approve` or `reject` for `confirm` — is produced by the Authenticator service on the terminal outcome of the exchange (issued, refused, or expired), not on each poll.

---

## 8. Audit

### 8.1 Definitive, non-restorable record

- Every audit event, once written, MUST be immutable. The audit log is **append-only**.
- No interface MAY exist to edit or delete an audit event. Correction is expressed by appending a new event that references the earlier one.
- v1 does not require tamper-evidence beyond append-only semantics. Hash chaining, signing by executors, and high-availability of the audit store are explicitly deferred (§14).

### 8.2 Central collection per namespace policy

- Each namespace declares an **audit destination**: the Private Registry's own audit store, or none (local-only on the writer).
- When a destination is declared, every server-side writer (§8.2a) acting within that namespace MUST deliver its events there. A writer that cannot deliver MUST buffer in a durable local log, MUST refuse to discard buffered events, and MUST redeliver them; redelivery is idempotent by event id.
- An Auth Server MUST NOT be an audit destination for Resource invocations.
- The central audit store is written by whoever ran the work server-side, each recording what it observed, so each carries that party's level of trust:
  - **Registry record.** The Registry writes what it observes itself: sign-in, token issue and revocation, resolve, search, publish, yank, and audit query.
  - **Server-side Resource record.** A Resource that runs server-side — an Executor Resource (`trusted-executor`, §6A) or a self-hosted `server` Resource (§6.5) — writes the work it answered on behalf of a caller: which operation, for which caller, with what result (§8.2a). An Executor Resource additionally writes a `dispatch` record of who used it to run which Resource (§6A.3).
  - **Provider record.** A registered Provider (§10) writes the server-side Resource record of every `server` Resource of its namespace under its own service identity, in place of per-Resource tokens (§8.2a). It is the same record with a different credential behind it.
- Work that runs on the caller's device is **not** written to the central store. The Executor CLI records it as the caller's own report and keeps it locally (`~/.doax/audit.jsonl`, §8.3); it is never delivered.

### 8.2a Resource audit

A **server-side Resource** — an Executor Resource (`trusted-executor`) or a self-hosted `server` Resource (§6.5) — MUST write an audit event to its Registry for each Fixed Interface operation it answers (§4.6): `authenticate`, `metadata`, `read`, `dry-run`, `execute`, and `dispatch`, and also for a recovery action it runs or a step-up it demands. This record is the Resource's own statement that it answered a given caller. A Resource that runs on the caller's device does **not** write to the central store; that work is covered by the Executor CLI's local report (§8.3). Accordingly, the Registry accepts an ingested event only when its *execution location* is `executor` or `server`.

**Authentication.** A server-side Resource writes with a **resource token**. The Registry mints the token when such a Resource is created, that is, at the first publish of an `executor`-kind or `server`-location `@namespace/name`; it is not minted for caller-device Resources. It returns the token once, in the publish response, and from then on the Resource holds it. The Registry stores only the token's hash. A manager of the Resource can issue a further token, to rotate it or after a leak, and can revoke any token. The managers are the operator; in a claimed namespace, its owners and publishers; and in a shared namespace, whoever published a version of that Resource. A token is scoped to `@namespace/name` and covers every version. Issuing or revoking a token is a Registry `auth` event.

A namespace MAY instead register a **Provider** (§10): a service identity the Registry verifies by its own means (a platform-issued workload credential, a public key) that writes the records of every `server` Resource of that namespace. One credential the platform rotates replaces a secret per Resource to keep. A Provider's events are held to the same rules as resource-token events (server-side location, mandatory fields, `unknown` where it cannot tell) and MUST name Resources of its own namespace only.

The Registry MUST refuse an event that comes with neither a live resource token for its Resource nor the identity of a Provider registered for its namespace, and an event whose `resource` is not a version of the token's Resource. On every event it accepts, the Registry records which credential delivered it: the resource token by id, the Provider by identity, or the Registry itself (*source* `resource`, `provider`, or `registry`; *reporter*, §8.4).

**Mandatory content.** Beyond §8.4, each event MUST carry:

| Operation | Fields |
|---|---|
| all | *caller*: the device identifier, the Executor Resource, or the Application (§2) that the Resource answered, as passed in the operation's context (§4.6), or `unknown`; *outcome* with a reason code drawn from the declared fault classes (§13.2) |
| `authenticate` | *authenticator* (the Resource's own identity) and mode. Credential material MUST NOT be recorded. |
| `confirm` | *authenticator*; the subject who decided; the invocation descriptor (§7.8); the confirmation id. The confirmation itself MUST NOT be recorded. |
| `metadata` | *source freshness*: the `lastRefreshed` value reported |
| `read` | *source freshness*: the `freshness` value of the response (§5.7); *record count*: the number of records returned; *time range*: the time range the returned records cover; *continued*: whether `continuation` was returned, i.e. the result was partial |
| `dry-run` | *target*; *dry-run flag*: mode, and `estimated` when predictive; for a gated Action (§6.4), the *approval* id requested |
| `execute` | *target*; *idempotency key*; *external reference*: the identifier the target system assigned to the effect (for example, a created message's id); for a gated Action (§6.4), the *approval* id consumed; for an out-of-band payload (§6.6), the *payload* size and digest |
| recovery | as for `execute`, plus *linked event*: the `execute` event being compensated |
| step-up | the tier requested |
| `dispatch` | the dispatched Resource and operation, and the dispatching Principal as *actor* (§6A.6) |

A Resource MUST NOT omit a mandatory field because it cannot tell the value. It MUST record the value as `unknown`. A missing field and an unknown value are different facts: only an explicit `unknown` shows that the Resource looked and could not tell. The Registry MUST refuse an event that omits a mandatory field.

### 8.3 Mandatory event classes

The following MUST produce an audit event:

| Class | When |
|---|---|
| `resolve` | A Resource is resolved by identity or search |
| `fetch` | A Package is downloaded from the Code Repository |
| `metadata-read` | A Data Source's mandatory metadata is requested (§5.2) |
| `data-read` | A Data Source returns data |
| `dry-run` | An Action is dry-run (any mode other than `none`) |
| `execute` | An Action is executed |
| `dispatch` | Work is handed to an Executor Resource (§6A.3), including scheduling of a deferred run |
| `recover` | A recovery action is executed |
| `approve` / `reject` | A `confirm` (§4.7) reaches its terminal outcome: the person confirms or refuses an invocation, including a gated Action (§6.4). Recorded by the Authenticator service. |
| `step-up` | A Resource demands a stronger Tier at runtime (§7.4) |
| `auth` | A Principal signs in to the Registry, a token is issued, refreshed, or revoked; or an Authenticator's `authenticate` operation is invoked (§4.7), recording the Authenticator, mode, and outcome only |
| `publish` / `deprecate` / `yank` | A Resource version's lifecycle changes |
| `visibility-change` / `verification-change` | Either axis of §4.5 changes |

### 8.4 Mandatory event fields

Every event MUST record:

| Field | Content |
|---|---|
| event id | Unique, assigned at write time |
| timestamp | Time the event occurred, as observed by the writer |
| class | One of §8.3 |
| actor | Principal identity, or anonymous marker for Tier 4 |
| execution location | `caller-device` with the device identifier, the Executor Resource identity `@namespace/name@version`, `server` with the self-hosted Resource's identity `@namespace/name@version` (§6.5), or `registry` with the Registry's domain for events the Registry Server writes about its own surface (sign-in, publish, resolve, audit query) |
| executor cpu time | For every event emitted by an Executor Resource: CPU time consumed by the operation on that machine, as reported by the machine. Absent for events emitted by an Executor CLI. |
| resource | `@namespace/name@version`; for `auth` events from `authenticate`, the Authenticator's identity |
| authenticator | For `data-read`, `dry-run`, `execute`, `recover`, `dispatch`: the Authenticator whose credentials were used, or `none` |
| target | The external system or collection acted upon, as reported by the Resource |
| effective tier | Tier applied, and reason if strengthened (§7.4) |
| outcome | `success`, `failure`, `partial`, with a Resource-supplied reason code |
| idempotency key | For `execute` and `recover` |
| dry-run flag | For `dry-run`: mode, and `estimated` marker when mode is `predictive` |
| source freshness | For `data-read` and `metadata-read`: the `lastRefreshed` value reported by the source, or `unknown` |
| record count / time range / continued | For `data-read`: how many records were returned, the time range they cover, and whether the result was partial (§8.2a) |
| external reference | For `execute` and `recover`: the identifier the target system assigned to the effect, or `unknown` |
| caller / reporter | For Resource records (§8.2a): the caller the Resource answered, and the credential that delivered the event, a resource token by id or a Provider by identity (the Registry sets the reporter and its *source*) |
| token audience / channel / method | For Resource records written by a Provider: the audience, channel, and method of the token it accepted (§7.2), so that portal use and executor use of the same Resource are told apart |
| approval | For `dry-run` and `execute` of a gated Action (§6.4): the id of the confirmation requested or consumed |
| payload | For `execute` with an out-of-band payload (§6.6): its size and digest as observed |
| linked event | For `recover`: the id of the `execute` event being compensated. For `approve`/`reject`: the confirmation id, which identifies the request hash (§6.4); the `execute` that consumes it carries the same id in *approval*. For `data-read`, `dry-run`, or `execute` run on an Executor Resource: the `dispatch` event. |
| upstream origin | For `resolve` and `fetch` from an Upstream: the Upstream's identity |

### 8.5 Audit query

- The Registry Server MUST allow a namespace owner, and the Registry operator, to query events by actor, resource, class, time range, outcome, and execution location, and to aggregate *executor cpu time* by actor and by resource. Namespace policy MAY widen this to members.
- Query access is itself a `data-read` against a system Data Source and MUST be audited.

---

## 9. Executor CLI

### 9.1 Responsibilities

The Executor MUST:

1. Obtain a Registry token (§7.2) from the Auth Server the configured Registry trusts, through whatever login that Auth Server uses (§7.7 when it is a web page), and hold it.
2. Resolve a Resource against the Registry that owns its namespace (§12.1; Private first, Upstream if permitted). If the Resource is declared `trusted-executor`, resolve a matching Executor Resource (§6A.5) and route the operation through its `dispatch` instead of running it locally. If it is declared `server`, invoke it over its binding with a token issued for its Provider (§7.2).
3. Fetch the Package and verify its integrity digest against the Manifest before running anything.
4. Compute the effective Tier (§7.4) and run the matching flow. Each flow is the interaction surface for a party that enforces it (§7.3), not a check the Executor makes:
   - Tier 1: call the Authenticator's `confirm` with the invocation descriptor (§7.8), provide the interaction it requests, and proceed with the confirmation it issues for this invocation — or, for an Authenticator that serves authorization by re-authentication (§7.3), call `authenticate` in mode `step-up` and proceed with the material it issues.
   - Tier 2: present the token; unless it holds an authorization token for the Resource still within its lifetime (§7.4a), call `confirm` — or `authenticate` in mode `step-up` — likewise. For a gated Action the executing party starts `confirm` itself (§6.4).
   - Tier 3: present the token, proceed.
   - Tier 4: proceed, mark actor as anonymous.
5. Resolve the Resource's referenced Authenticator; if no cached credential exists for this caller and Authenticator (or the Tier requires it), call its `authenticate` in the appropriate mode, provide the interaction surface it requests, and cache the resulting material. When it answers `pending`, relay the entry point and complete the exchange as §7.8 describes, in this call or a later one. Hand the material to the Resource's operations.
6. Honor any runtime step-up by re-entering steps 4 and 5 at the stronger Tier.
7. Offer dry-run when the Action declares a mode other than `none`; warn when it declares `none`.
8. Generate the idempotency key for `execute`/`recover`.
9. Record every mandatory audit event (§8.3) locally, as the caller's own report (§8.2), and pass the caller to each operation so an Executor Resource can write its own record (§4.6, §8.2a).
10. Manage the local credential cache (§7.6).

### 9.2 Behavioral guarantees

- The Executor MUST refuse to run a Package whose integrity digest does not match.
- The Executor MUST refuse to weaken a Tier under any flag or configuration.
- The Executor MUST NOT present its own prompt, flag, or confirmation as an authentication or authorization: a Tier 1 or 2 invocation proceeds only on material the Authenticator service or Provider issued for it (§7.3).
- The Executor MUST refuse to retry a `non-idempotent` Action without explicit confirmation.
- The Executor MUST make the verification status (§4.5) of a Resource visible before execution.
- The Executor CLI MUST NOT run a `trusted-executor` Resource locally, and MUST NOT ask an Executor Resource to run a `caller-device` Resource (§6.5).
- The Executor CLI MUST NOT hand credential material from one Authenticator to a Resource that references a different Authenticator.
- The Executor MUST invoke a Resource only through Fixed Interface operations mapped in its Manifest (§4.6). It MUST NOT enumerate or call unmapped MCP tools, even when the underlying server advertises them.
- The Executor CLI MUST present a Registry token only to the Registry that issued it, and a Provider token only to that Provider (§7.2).

---

## 10. Registry Server — Functional Interface

The Registry Server MUST provide the following capabilities over HTTPS with JSON response bodies. Every response carries the `manifesto` field (§10A). Endpoint naming, pagination mechanics, and error encoding are implementer's choice.

| Capability | Description |
|---|---|
| Resolve | Given `@namespace/name` with optional version, return the Manifest, visibility, verification status, deprecation state, and Package digest. Honors visibility rules for the caller's token. |
| Search | Full-text and attribute search over Manifests visible to the caller, including filtering by kind so that `executor` Resources can be listed. Results MUST show visibility and verification status separately. |
| Executor matching | Given a `trusted-executor` Resource, return the Executor Resources visible to the caller whose `capabilities` satisfy its executor requirements (§6A.5), with current load. |
| Publish | Accept a Package for a new version under a namespace the caller owns. Rejects duplicate versions. Emits `publish`. |
| Deprecate / Yank | Lifecycle transitions per §4.4. |
| Namespace management | Create namespace, set visibility defaults, set Tier floor, set the Tier 2 authorization token lifetime (§7.4a), set audit destination, set Upstream reference policy, manage grant lists, register trusted issuers (§7.2) and Providers (§8.2a) for the namespace. |
| Verification | Operator or delegated reviewer sets verification status. |
| Login discovery | Declare, without a token, the login methods the Auth Server offers and where its web login page is (§7.7). |
| Verification material | Publish, without a token, the public material needed to verify its tokens offline (§7.2). |
| Token exchange | Issue a Provider-audience token in exchange for a Registry token (§7.2). |
| Pending-state store | Hold the intermediate state of an Authenticator service's pending exchanges (§7.8): entries keyed by Authenticator and handle, bounded in size and lifetime, written and read only under the identity registered for that Authenticator's service in its namespace. Storage only: the Registry interprets no entry, takes no identity or authorization decision from one, and refuses an entry past its maximum lifetime or carrying credential material. |
| Audit ingest | Accept Resource records (§8.2a) under a resource token or a registered Provider's identity, refusing events for other Resources or namespaces, events whose execution location is not server-side, and events with mandatory fields missing. Append-only. |
| Resource tokens | Issue, list, and revoke a Resource's audit tokens, for its managers (§8.2a). |
| Audit query | Per §8.5. |
| Upstream proxy | When configured, resolve and fetch Resources from an Upstream on behalf of the caller, cache them, apply local policy (block, pin version, require `verified`), and record `upstream origin` in audit. |

---

## 10A. Self-description: the Manifesto

Every JSON response produced by any network-reachable component of this system — Registry Server, Code Repository, Auth Server, Executor Resource — MUST include a top-level field `manifesto` whose value is the location `{domain}/manifesto.json`, where `{domain}` is the domain the responder is serving under. Fixed Interface responses from a Resource carry the `manifesto` of the component that served them.

`manifesto.json` is a **static**, unauthenticated file whose only job is to tell someone who has a response in hand and no other context what they are looking at. It is the equivalent of a document's self-identifying header. It MUST state, in plain language:

- what this system is (one paragraph),
- which component of it is responding, and who operates it,
- where this specification is published, and which version of it the component implements,
- where a newcomer should start (documentation, how to obtain an Executor CLI, how to sign in to *this* Registry and route a namespace to it).

A deployment that applies extensions to this specification SHOULD say so in its Manifesto and point to where they are documented. It MAY contain anything else the operator finds helpful. It MUST NOT contain credentials or anything that varies by request, and nothing in this specification depends on its content for correctness: no client MUST read it, and no security or authority decision MAY be based on it. Authority over a namespace is established by the token check (§7.2), not by the Manifesto.

---

## 11. Code Repository — Functional Interface

| Capability | Description |
|---|---|
| Store | Accept a Package under `@namespace/name@version`; compute and return the integrity digest. Reject if the version exists. |
| Retrieve | Return the Package for an exact version. Visibility is enforced by the Registry Server; the Code Repository MAY trust the Registry Server's authorization decision. |
| Integrity | The digest returned at Store time MUST equal the digest of the content returned at Retrieve time, forever. |

---

## 12. Private Registries and Upstream

### 12.1 Deployment model

- The reference deployment is **on-premises**: an organization runs its own Registry Server, Code Repository, and audit store inside its network or inside a cloud project it controls.
- The organization runs its own Auth Server, or configures the reference one for its domain; either way it issues tokens per §7.2 and nothing more (§7.5). It MAY admit only Principals of its own organization and MAY require a token for every request, including resolution of `public` Resources (§12.3).
- **Addressing is by namespace.** An Executor CLI holds a list of Registries and resolves each Resource from the Registry that owns its namespace, the way package managers route scopes (`doax registry add @corp https://registry.corp.example`); a namespace not routed explicitly goes to the default Registry. A Private Registry therefore needs no special hostname: it is reached under its own origin, and the token it issues is presented to it alone (§7.2, §9.2). Inside the organization's network, the public Registry's hostname MAY additionally be resolved to the on-premises instance.

### 12.2 Upstream reference

- A Private Registry MAY declare one Upstream.
- All Upstream resolution MUST pass through the Private Registry, never directly from Executor to Upstream, so that Upstream usage appears in the organization's own audit log.
- The Private Registry MUST support: blocking specific Upstream Resources, pinning Upstream Resources to a version, and refusing Upstream Resources below a verification status.

### 12.3 Isolation statement

Namespace visibility is **access control**, not **physical isolation**. An organization that requires that its Resources and data never leave its network MUST deploy on-premises per §12.1. The Registry MUST NOT describe `namespace-only` visibility on a shared public instance as isolation. On a Private Registry that requires a token for every request, `public` visibility means visible to every Principal that Registry admits, not to the world; such a Registry SHOULD say so in its Manifesto (§10A).

---

## 13. Resource Service Level Declaration (SLO / SLA)

Service levels in this specification belong to **Resources**, not to the Registry infrastructure. Every Resource is a promise made by its publisher to its callers, and that promise MUST be written down in the Manifest so that an agent can decide whether to depend on it and an organization can decide whether to admit it.

### 13.1 Mandatory declaration

Every Manifest MUST contain a **service level declaration**. Its content differs by kind because the kinds fail differently: a Data Source fails by being **late**, an Action fails by **not completing**, an Executor Resource fails by being **unreachable or saturated** (§6A.7), and an Authenticator fails by **not producing credentials** (§13.1.2a).

#### 13.1.1 Common items

| Item | Content |
|---|---|
| Expected faults | The list of fault classes the Resource expects to surface to the caller (§13.2). The list MAY be empty; an empty list is a claim that no fault surfaces. |
| Degradation behavior | What the Resource does when it cannot meet its targets: fail fast, return partial results marked as partial, queue and retry, or fall back to a stale copy. Each behavior MUST state how the caller is told. |
| Dependency levels | For each dependency declared in §4.3, the service level the Resource assumes from it. A Resource MUST NOT declare a target stronger than the weakest dependency it relies on, unless its degradation behavior explains how it compensates. |
| Measurement | How the publisher measures the targets (from audit events, from the target system's own status, or not measured). `not measured` is permitted but MUST be stated. |
| Support commitment | Who responds to a breach and within what time, or `none`. |

#### 13.1.2 Data Source items — lateness is the fault

| Item | Content |
|---|---|
| Refresh cadence | The committed interval between refreshes, equal to `metadata.refreshCadence` (§5.2a) (for example, "every 5 minutes", "daily by 06:00"). |
| Tolerance | How far past the cadence a refresh may land before the source counts as late. MAY be zero. |
| Annual lateness budget | The total time per year the source is permitted to be late, expressed as a duration or as a percentage. This **is** the SLO. |
| Lateness accounting rule | Lateness MUST be computed as follows: at any instant, if the age of the newest data exceeds *cadence + tolerance*, the source is late; the lateness duration is the sum of all such instants over the year. A 5-minute cadence with zero tolerance that delivers at minute 12 accrues 7 minutes of lateness. A source that never refreshes accrues lateness continuously, unless its cadence is `static` (§5.6), in which case lateness is replaced by unreachability of `read`. |
| Latency target | Expected completion time of `metadata` and `read` at a stated percentile. |

Availability of a Data Source is **defined** as `1 − (annual lateness ÷ one year)`. A Data Source MUST NOT declare a separate availability figure that excludes lateness. A refresh that completes on time but delivers no new rows because the upstream had none is not late; a refresh that completes on time but delivers rows the source knows to be wrong (for example, a failed partial load) MUST be counted as late from that instant until corrected.

#### 13.1.2a Authenticator items — inability to obtain credentials is the fault

| Item | Content |
|---|---|
| Per-attempt failure probability | As for Actions (§13.1.3), for an `initial` or `refresh` attempt |
| Failure conditions | Target login system outage, consent screen changes, multi-factor prompts the flow cannot satisfy, rate limiting |
| Blast radius statement | A plain statement that an Authenticator fault affects every Resource referencing it, with the list of currently referencing Resources filled in by the Registry at resolution time |

#### 13.1.3 Action items — failure to complete is the fault

| Item | Content |
|---|---|
| Per-attempt failure probability (quantitative) | The publisher's stated probability that a single `execute` attempt does not complete, as a number or range, with the basis for the estimate (measured over N invocations, inferred from the target system's published status, or declared assumption). `unknown` is permitted only together with a qualitative description and `best-effort` as the annual target. |
| Failure conditions (qualitative) | The circumstances under which failure is more likely: time of day, target system load, size of the request, presence of anti-automation measures, dependency state, approval latency. This text exists so that an agent or a reviewer can judge whether the quantitative figure applies to the situation at hand. |
| Side-effect-on-failure statement | For each failure condition: whether a failed attempt may have produced a partial or complete side effect in the target system. This determines whether the recovery action (§6.3) is needed after a failure. |
| Annual target | The committed fraction of attempts per year that complete, or `best-effort`. |
| Latency target | Expected completion time of `dry-run` and `execute` at a stated percentile, or `unbounded` with a reason (for example, waiting on a human approval gate). |

An Action that includes a human-in-the-loop gate (§6.4) MUST separate approval wait time from execution time in both its latency target and its failure accounting; an approval that times out is a declared fault class, not an availability loss of the Action itself.

### 13.2 Expected faults

There is one fault model: a Resource **enumerates** the fault classes it expects to surface to the caller. Each entry MUST state:

| Field | Content |
|---|---|
| Fault class | A stable identifier used as the reason code in the audit `outcome` field (§8.4) |
| Trigger | The condition under which it occurs (target system down, rate limit, session expired, approval timed out, anti-automation challenge) |
| Caller-visible effect | What the caller observes; for Actions, whether any side effect may have occurred before the fault |
| Expected frequency | Rough rate or `unknown` |
| Recommended caller action | Retry after a delay, re-authenticate, invoke the recovery action, escalate to a human, do nothing |

**An empty list is a claim, not an exemption.** A Resource that declares no expected faults is asserting that faults in its target system, network, or dependencies never reach the caller beyond its declared lateness budget or annual target. The Registry does not take that claim on trust: it is checked against realized `undeclared` faults (below). In practice the claim is credible only for Resources with no external dependency at run time, such as snapshot Data Sources (§5.6). An Action that absorbs faults by retrying MUST be `idempotent` or `keyed` (§6.2).

A fault that occurs at run time and does not match a declared fault class is an **undeclared fault**. The Executor MUST record it with reason code `undeclared` so that it is visible in audit queries. A Private Registry MAY treat a rate of undeclared faults above a namespace-defined threshold as grounds to suspend the Resource's verification status; for a Resource that declared an empty list, a single undeclared fault SHOULD trigger review.

### 13.3 Enforcement

- The Executor MUST refuse to run a Resource whose Manifest lacks a service level declaration or omits the expected-fault list (an explicitly empty list is present; a missing list is not).
- The Executor MUST show the expected-fault list and degradation behavior to the caller before execution of any Action with dry-run mode `none`.
- The audit `outcome` reason code (§8.4) MUST be drawn from the declared fault classes or be `undeclared`.
- Because every `data-read` and `metadata-read` event records the source's `lastRefreshed` value (§8.4), lateness MUST be computable from the audit log alone. A Private Registry SHOULD compute realized lateness and realized per-attempt failure rate from its audit store and show them beside the declared figures.
- Verification review (§4.5) MUST assess whether the declared targets are plausible given the declared dependencies and interaction kinds. An empty expected-fault list over a `browser-login` target with no fallback SHOULD NOT receive `verified` status.
- Namespace policy MAY set a floor: for example, "every declared fault class in this namespace must carry a recommended caller action".

### 13.4 What this specification does not promise

This specification imposes no availability or latency target on the Registry Server, Code Repository, or Auth Server themselves. The guarantees those components make are the correctness guarantees stated elsewhere: immutability (§4.4, §11), audit durability once acknowledged (§8.1), and offline verifiability of tokens (§7.2). Operational targets for the infrastructure are a deployment concern and are deferred (§14).

---

## 14. Out of Scope for v1 (Deferred)

- Audit store high availability, multi-region operation, and tamper-evidence (hash chaining, executor-signed events).
- Operational availability and latency targets for the Registry Server, Code Repository, and Auth Server (§13.4).
- Additional logins for the reference Auth Server beyond Google Sign-In.
- A standardized query interface for Data Sources.
- Automated verification tooling; v1 verification is a manual status change.
- Executors other than a command-line program and the Executor Resource.
- Delivery channels for approval requests (a messenger, mail); v1 defines the approval artifact and its events (§6.4, §8.3) but not how the person is notified.
- Marketplace features: ratings, billing, discovery ranking.

---

## 15. Open Decisions

The following were not settled during specification and are recorded here so the implementer makes a conscious choice rather than an accidental one.

1. **Namespace ownership transfer and dispute process.**

*Settled since the first draft:* the address scheme for on-premises resolution is per-namespace routing in the Executor CLI (§12.1).

---

## Appendix A — Manifest Field Reference

| Field | Applies to | Mandatory | Section |
|---|---|---|---|
| identity | all | yes | 4.1 |
| kind | all | yes | 4.2 |
| summary | all | yes | 4.3 |
| description | all | yes | 4.3, 5.4 |
| owner | all | yes | 4.3 |
| required tier | all | yes | 7.3 |
| execution location | data-source, action, authenticator (not `machine` subject) | yes | 4.3, 6.5 |
| audit scope | all | yes | 8.3 |
| integrity | all | yes (set at publish) | 4.3, 11 |
| dependencies | all | yes (may be empty) | 4.3, 7.4 |
| interface mapping | all | yes | 4.3, 4.6 |
| authenticator | data-source, action, executor | yes (`none` allowed) | 4.3, 4.7 |
| authentication specification | authenticator | yes | 4.7.1 |
| service level declaration | all | yes | 4.3, 13 |
| executor requirements | data-source, action (when `trusted-executor`) | yes in that case | 6A.5 |
| dry-run mode | action | yes | 6.1 |
| idempotency class | action | yes | 6.2 |
| recovery action | action | yes | 6.3 |
| approval gate | action | no | 6.4 |
| out-of-band payload | action | no | 6.6 |

---

## Appendix B — Worked Examples (informative)

**B.1 Public, caller-device Action: train ticket booking**
- kind `action`, execution location `caller-device`, required tier 1.
- dry-run `predictive`: reads the cart, reports expected fare and seats, labeled `estimated`.
- idempotency `keyed`: booking reference as key.
- recovery: `@koreanmate/train-cancel@1.x` (a separate Action, Tier 1, dry-run `native` if the carrier offers cancellation preview).
- Authenticator: `@koreanmate/carrier-login@1.x` (B.5), subject `personal`. The train-cancel recovery Action references the same Authenticator. Because both Actions are Tier 1, each invocation still authenticates interactively (§4.7); sharing the Authenticator means one declared flow and one cache entry, not a skipped login.
- Service level: per-attempt failure probability "15–30%, declared assumption, not yet measured"; failure conditions: peak booking windows, holiday release times, anti-automation challenges after repeated attempts; side effect on failure: none for all classes except `payment-submitted-confirmation-lost` (possible complete side effect; recovery action required); annual target `best-effort`; expected faults: `carrier-unavailable`, `session-expired` (re-authenticate), `anti-automation-challenge` (escalate to human), `seat-taken-between-dryrun-and-execute` (re-run dry-run), `payment-submitted-confirmation-lost` (invoke recovery). Degradation: fail fast.
- Personal carrier credentials cached on the user's device only.

**B.2 Private, trusted-executor Action: refresh ERP export into internal store**
- kind `action`, execution location `trusted-executor`, required tier 3.
- dry-run `none`.
- idempotency `idempotent`: re-running for the same date window produces the same rows.
- recovery `none` (a subsequent run supersedes).
- Authenticator: `@corp/erp-service-account@1.x`, subject `organization`, interaction kind `secret-entry` performed once by an operator on the batch machine. Every Data Source exported from the ERP references this same Authenticator.
- Executor requirements: network reach "internal ERP"; credential kind "ERP export service account"; scheduling required.
- Service level: per-attempt failure probability "about 2%, measured over the last 400 runs"; failure conditions: ERP vendor maintenance windows, export file larger than the vendor's size limit; side effect on failure: none (the internal store is replaced atomically or not at all); annual target "99% of scheduled runs complete"; expected faults: `vendor-maintenance-window` (no side effect; retry after window), `export-size-exceeded` (no side effect; escalate to human). Internal retries up to a declared limit happen before either class surfaces, and when they are exhausted the previous data is left in place so that B.3 accrues lateness rather than this Action failing; latency "completes within 30 minutes of schedule at p95"; measured from audit events.
- Audit records row counts fetched and changed, so a dashboard figure can be traced to a specific refresh.

**B.3 Private Data Source: orders**
- kind `data-source`, execution location `trusted-executor`, required tier 2.
- One collection: orders. Purchase orders are a separate Data Source with their own Tier and cadence (§5.2).
- `metadata` returns `schema` declaring `order_id`, `customer_id`, `amount` (with currency), `ordered_at`, `status` (enumeration), and `metadata` with time range, count, `lastRefreshed` = timestamp of the most recent B.2 run, `refreshCadence` "daily 06:00". A team lead's `schema` omits `margin`, and so does their `data`.
- `read` returns `data` as an array of order records.
- Service level: refresh cadence "daily by 06:00"; tolerance "6 hours"; annual lateness budget "48 hours per year" (availability therefore 99.45%); lateness accounting: late from 12:00 on any day whose refresh has not landed, until it lands; expected faults: `refresh-missed` (effect: `lastRefreshed` older than cadence + tolerance; recommended action: display stale marker, do not fail). Degradation: serve stale copy, marked.
- The source returns company-wide rows to the CEO and team-scoped rows to a team lead; the Registry does not know or care which.

**B.4 Private Executor Resource: batch machine**
- kind `executor`, required tier 2 (every dispatch needs a per-call authorization check, subject to any Tier 2 authorization token lifetime the namespace sets, §7.4a).
- `capabilities`: network reach "internal ERP, internal file share"; credential kinds held "ERP export service account", "file share service account"; concurrency limit 4; scheduling support "daily and hourly"; resource constraints "namespace @corp only".
- Authenticator: `@corp/batch-01-identity@1.x`, subject `machine`, interaction kind `none`; identity established at registration by an operator and renewed every 24 hours; Registry verifies it on each `dispatch`; revoked by the operator through namespace management.
- Service level: unavailability counted as every instant `capabilities` cannot be answered; dispatch queue latency "starts within 5 minutes of request at p95"; expected faults: `unreachable`, `at-capacity` (recommended action: retry after a delay), `machine-identity-expired` (escalate to operator), `credential-missing` (escalate to operator).
- Every event it emits carries its identity in *execution location* and the consumed CPU time, so monthly machine usage per Principal and per Resource is one audit aggregation.

**B.5 Public Authenticator: rail carrier login**
- kind `authenticator`, subject `personal`, required tier 1.
- Target system: the rail carrier's customer site. Interaction kind `browser-login`; entry point is the carrier's login page; completion signal is arrival at the carrier's account page; maximum wait 5 minutes. Credential material: an opaque session. Lifetime `unknown`, not refreshable; `verify` loads the account page without navigating further; `step-up` same as `initial`. Revocation: sign out on the carrier's site.
- Referenced by B.1 and by its recovery Action. Both are Tier 1, so a user who books and then cancels authenticates twice; what is shared is the flow definition and the cache entry, and a Tier 2 or 3 Resource referencing this Authenticator would reuse the cached session.
- Service level: per-attempt failure probability "about 5%, declared assumption"; failure conditions: carrier login outage, new multi-factor prompt; expected faults: `login-unavailable` (retry later), `mfa-required` (escalate to human).
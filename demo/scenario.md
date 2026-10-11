# Demo scenario: an FDE dispatch to a small factory

The demo shows what one forward-deployed engineer (FDE) sets up in one visit to a small
factory, using the hosted registry at [registry.doax.io](https://registry.doax.io). It is also
the **dispatch playbook**: every section is meant to be repeated, customer after customer.

## The two realities this demo is built on

1. **Telemetry is not an API.** In a real small factory, "telemetry" is an isolated PC next to
   the machine (no network, exports CSV when a human asks) or a spreadsheet a person fills in
   at the end of a shift. There is nothing to "integrate" in the SaaS sense. The factory gets
   data to us one of two ways:

   - **Post it** — a person drops the shift-end export (CSV/XLSX) onto a share or uploads it.
     This is the demo path: zero new habits beyond "save the file here".
   - **Sensed shared directory** — the productized path: the factory connects a shared folder
     (OneDrive / Google Drive / a network share synced to one) and a scheduled dispatch on our
     side *senses* it — polls on the declared cadence, picks up the newest export, normalizes
     it, and refreshes the resource data. This is exactly the spec's unattended
     `trusted-executor` + batch shape (§6.5, Step Functions on the hosted side), and it gives
     real lateness accounting: cadence "every shift end by 19:00", late = no new file by then.

   Either way the design treats human-cadenced data with respect: every number carries *when
   it was last refreshed and from which file/sync*, and staleness is displayed, never hidden
   (spec §5.5).

2. **The customer has no team to operate a registry.** No IT department, no one to run a
   server, patch it, or manage accounts. So the factory self-hosts **nothing**. Their
   resources live in **their namespace on the hosted registry**, created and maintained **by
   us, on every dispatch**. Governance is theirs (the owner signs in with their own email and
   owns `@demo`); operations are ours (the FDE is a `publisher` in their namespace).
   This is the npm model applied to operations: the customer owns the name, we run the
   infrastructure.

   *Honesty note (spec §12.3): a namespace on the shared registry is access control, not
   physical isolation. For this customer segment that is strictly better than today — their
   spreadsheet already lives in someone else's cloud. The customer whose data may not leave
   the building is the on-premise expansion story, not this demo.*

## Cast: the fictional customer

**한빛정밀 (Hanbit Precision)** — 12 people, 4 injection-molding lines. Production log is a
spreadsheet the foreman (김반장) updates at shift end from the isolated line PC's CSV export.
The owner gets numbers once a day by phone. Nobody at Hanbit will ever run a server.

## The resources the FDE creates (namespace `@demo`)

| Resource | Kind | Tier | Backing reality |
|---|---|---|---|
| `@demo/machine-status` | data-source | 3 | Per line: state, cycle count, last import time — parsed from the newest posted/sensed export. Freshness = that file's timestamp. |
| `@demo/production-log` | data-source | 3 | Daily output and defect counts per line, from the same exports. Cadence declared: "each shift end, by 19:00"; lateness is visible, not masked. |
| `@demo/defect-summary` | data-source | 3 | Yesterday's defects by cause. The owner's #1 question. |
| `@demo/daily-report` | action | 3 | Composes the day's numbers and posts them to the factory's messenger channel (depends on `@doax/slack-post`). |
| `@demo/order-resin` | action | **2** | Reorder raw material (demo: mock supplier). Predictive dry-run shows the cost estimate; tier 2 forces a per-call human authorization. |

All five are published, versioned, visible, tiered, and audited like any other resource —
the factory's working reality becomes legible to agents without the factory operating anything.

## The script (one day, five acts)

**Act 1 — Identity and governance (10 min).**
Owner: `doax login --email owner@demo.co.kr` → 6-digit code from their real inbox. No
account form, no IT ticket. Owner claims `@demo` (self-serve), adds the FDE as
**publisher**. From minute one: *the factory owns its namespace; the FDE is a guest with a
role.*

**Act 2 — Legibility (the FDE's real work, ~2 h).**
The FDE sets up the spreadsheet template with 김반장 (same columns he already writes), wires
the five resources from the dispatch kit, `doax publish` × 5. Each appears in doax.io Search
immediately.

**Act 3 — The dashboard.**
One static page (hosted like doax.io itself — the customer hosts nothing). It resolves
`@demo/*` from the registry, verifies package digests, calls the Fixed Interface `read`,
and renders: line tiles, defect chart, and — prominently — **"last refreshed 14:00 · by
김반장's shift-end sync"** on every number. Staleness is a first-class display element
because the backing truth is human-cadenced.

**Act 4 — The agent moment.**
An agent (Claude pointed at the CLI) answers the owner: *"어제 2호기 불량률이 왜 높았어?"* →
`doax read @demo/defect-summary --json` → an answer with real numbers and their freshness.
Then the owner asks it to reorder resin → the agent runs `@demo/order-resin` → **tier-2
gate**: `authorization-required`. The agent shows the dry-run cost estimate; the human
re-runs with `--yes`. *The agent may ask; only the human pulls the trigger.*

**Act 5 — Visibility (the close).**
Owner: `doax audit` — every resolve, read, dry-run, and the one authorized execute, by whom,
at which tier, append-only. Queryable by the owner for `@demo/*` and nobody else.
*"This is what your agents did today. Nothing is invisible, nothing can be edited away."*

## The dispatch playbook (what repeats per customer)

1. Owner email sign-in → claim `@<customer>` → add FDE as publisher.
2. Copy the spreadsheet template; fit columns to how their people already write. Point the
   shift-end export at the shared directory (or teach the post-the-file ritual).
3. Instantiate the resource kit with the customer's share link + channel ids;
   `doax publish` under `@<customer>`. Productized path: register the sensing dispatch
   (scheduled batch) for their directory.
4. Deploy the dashboard template with `doax app deploy @<customer>` to `<customer>.app.doax.io` (doax app deploy).
5. Teach one ritual: the shift-end export lands in the shared directory. Everything
   downstream — sensing, normalizing, serving, auditing — is ours.
6. Hand the owner two commands: `doax audit` and `doax execute @<customer>/daily-report`.

The FDE never installs anything at the factory. Subsequent dispatches add resources
(new lines, new sheets, a second action) as new versions in the same namespace.

## What each act demonstrates

| Pillar | Act |
|---|---|
| Legibility — work becomes resources without the customer operating anything | 2 |
| Control — tiers; dry-run; the human gate on effects | 4 |
| Visibility — owner-scoped, append-only audit | 5 |
| Governance — customer-owned namespace, role-scoped FDE | 1 |
| Day One — the whole thing is one dispatch | all |
| Expansion — "when data may not leave the building, the same registry installs inside it" | closing line |

## Where the code lives

**This repo stays essential infrastructure only** (registry, CLI, spec, site). The demo
deliverables — the dashboard, the customer resource kit, seed data, the sensing dispatch —
live in a **separate repo** (`doax-demo`), the same way a real customer engagement would:
customer-facing artifacts never enter the registry's codebase. This file is the scenario and
playbook; the other repo implements it.

## Build list

| Piece | Where | Status |
|---|---|---|
| Sign-in, namespaces + roles, publish, tiers, audit, Slack suite, CLI | this repo | exists, live |
| Five `@demo` resource packages + manifests | doax-demo | to build (~half day) |
| Spreadsheet/export template with realistic seed data | doax-demo | to build (30 min) |
| Shared-directory sensing dispatch (scheduled batch) | doax-demo | to build (demo: read-at-read from the share link; sensing batch = productized step) |
| Dashboard page (browser-side resolve + digest verify + read) | doax-demo | to build (~1 day; the only novel machinery) |
| `demo.app.doax.io` hosting | doax-demo | trivial (same S3+CloudFront pattern) |
| Mock supplier endpoint for `order-resin` | doax-demo | tiny |

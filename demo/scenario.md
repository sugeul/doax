# Demo scenario: an FDE dispatch to a small factory

The demo shows what one forward-deployed engineer (FDE) sets up in one visit to a small
factory, using the hosted registry at [registry.doax.io](https://registry.doax.io). It is also
the **dispatch playbook**: every section is meant to be repeated, customer after customer.

## The two realities this demo is built on

1. **Telemetry is not an API.** In a real small factory, "telemetry" is an isolated PC next to
   the machine (no network, exports CSV when a human asks) or a spreadsheet a person fills in
   at the end of a shift. There is nothing to "integrate" in the SaaS sense. The raw material
   of the demo is a human-managed spreadsheet, and the design treats that with respect:
   every number carries *when it was last refreshed and by whom*, and staleness is displayed,
   never hidden (spec §5.5).

2. **The customer has no team to operate a registry.** No IT department, no one to run a
   server, patch it, or manage accounts. So the factory self-hosts **nothing**. Their
   resources live in **their namespace on the hosted registry**, created and maintained **by
   us, on every dispatch**. Governance is theirs (the owner signs in with their own email and
   owns `@hanbit`); operations are ours (the FDE is a `publisher` in their namespace).
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

## The resources the FDE creates (namespace `@hanbit`)

| Resource | Kind | Tier | Backing reality |
|---|---|---|---|
| `@hanbit/machine-status` | data-source | 3 | The "machines" sheet tab — per line: state, cycle count, last CSV import time. Freshness = when 김반장 last synced the isolated PC's export. |
| `@hanbit/production-log` | data-source | 3 | The "production" tab — daily output and defect counts per line. Refresh cadence declared: "each shift end, by 19:00"; lateness is visible, not masked. |
| `@hanbit/defect-summary` | data-source | 3 | The "defects" tab — yesterday's defects by cause. The owner's #1 question. |
| `@hanbit/daily-report` | action | 3 | Composes the day's numbers and posts them to the factory's messenger channel (depends on `@doax/slack-post`). |
| `@hanbit/order-resin` | action | **2** | Reorder raw material (demo: mock supplier). Predictive dry-run shows the cost estimate; tier 2 forces a per-call human authorization. |

All five are published, versioned, visible, tiered, and audited like any other resource —
the factory's working reality becomes legible to agents without the factory operating anything.

## The script (one day, five acts)

**Act 1 — Identity and governance (10 min).**
Owner: `doax login --email owner@hanbit.co.kr` → 6-digit code from their real inbox. No
account form, no IT ticket. Owner claims `@hanbit` (self-serve), adds the FDE as
**publisher**. From minute one: *the factory owns its namespace; the FDE is a guest with a
role.*

**Act 2 — Legibility (the FDE's real work, ~2 h).**
The FDE sets up the spreadsheet template with 김반장 (same columns he already writes), wires
the five resources from the dispatch kit, `doax publish` × 5. Each appears in doax.io Search
immediately.

**Act 3 — The dashboard.**
One static page (hosted like doax.io itself — the customer hosts nothing). It resolves
`@hanbit/*` from the registry, verifies package digests, calls the Fixed Interface `read`,
and renders: line tiles, defect chart, and — prominently — **"last refreshed 14:00 · by
김반장's shift-end sync"** on every number. Staleness is a first-class display element
because the backing truth is human-cadenced.

**Act 4 — The agent moment.**
An agent (Claude pointed at the CLI) answers the owner: *"어제 2호기 불량률이 왜 높았어?"* →
`doax read @hanbit/defect-summary --json` → an answer with real numbers and their freshness.
Then the owner asks it to reorder resin → the agent runs `@hanbit/order-resin` → **tier-2
gate**: `authorization-required`. The agent shows the dry-run cost estimate; the human
re-runs with `--yes`. *The agent may ask; only the human pulls the trigger.*

**Act 5 — Visibility (the close).**
Owner: `doax audit` — every resolve, read, dry-run, and the one authorized execute, by whom,
at which tier, append-only. Queryable by the owner for `@hanbit/*` and nobody else.
*"This is what your agents did today. Nothing is invisible, nothing can be edited away."*

## The dispatch playbook (what repeats per customer)

1. Owner email sign-in → claim `@<customer>` → add FDE as publisher.
2. Copy the spreadsheet template; fit columns to how their people already write.
3. Instantiate the resource kit (this directory) with the customer's sheet + channel ids;
   `doax publish` under `@<customer>`.
4. Deploy the dashboard template to `<customer>.doax.io`.
5. Teach one ritual: the shift-end sync (isolated PC → sheet). Everything downstream is ours.
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

## Build list

| Piece | Status |
|---|---|
| Sign-in, namespaces + roles, publish, tiers, audit, Slack suite, CLI | exists, live |
| Five `@hanbit` resource packages + manifests (this directory) | to build (~half day) |
| Spreadsheet template with realistic seed data | to build (30 min) |
| Dashboard page (browser-side resolve + digest verify + read) | to build (~1 day; the only novel machinery) |
| `hanbit.doax.io` hosting | trivial (existing S3+CloudFront pattern) |
| Mock supplier endpoint for `order-resin` | tiny |

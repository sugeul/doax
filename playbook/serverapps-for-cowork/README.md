# Server apps for cowork

A **cowork app** is a hosted, multi-user surface where a team works over the *same* resources:
one dashboard, one shared namespace, several people with different roles. It lives at
`<ns>.app.doax.io` behind the registry's sign-in gate. It exists because some work is inherently
shared — a team looking at the same numbers, acting on the same records, seeing one audit trail.

**Defining trait — many people, one shared truth, two credential planes.** A cowork app mixes two
kinds of credential and must never blur them:

- **Personal plane (reads).** Each member authenticates to sources as themselves; their token
  stays in their session/device trust; they see only their caller-relative view.
- **Organization plane (shared effects).** A team action ("post the daily report", "refresh the
  shared DB") runs under an **org** service account on a `trusted-executor` — never one member's
  personal token (spec §6.5 rule 2, §4.7). A personal action and a team action are *different
  resources with different authenticators*. Keeping the planes apart is what makes "the agent may
  ask, only the human pulls the trigger" hold for a team.

**Built on, nothing new:** the registry's email-code sign-in + session cookie, `*.app.doax.io`
hosting, namespace membership + roles (`owner`/`publisher`/`reader`), tiers, and namespace-scoped
append-only audit (spec §7, §8.5). The app is a *rendering of a namespace*.

*Honesty note (cf. scenario.md §12.3): a namespace is access control, not physical isolation —
strictly better than a shared spreadsheet; the on-prem install is the story for data that may not
leave the building.*

Each file here is one **situation**, titled by the scenario:

- [the-factory-team-dashboard.md](./the-factory-team-dashboard.md)
- [a-shared-client-space.md](./a-shared-client-space.md)
- [recruiters-share-resources-not-leads.md](./recruiters-share-resources-not-leads.md)

Implementation lives in its own repo (e.g. `doax-cowork`); the governance primitives already live
in this repo and are live.

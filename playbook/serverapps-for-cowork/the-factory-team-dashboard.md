# A factory owner, a foreman, and an engineer share one dashboard with role-scoped power

**Situation.** 한빛정밀 (12 people, 4 lines) wants one page the whole team opens:
`hanbit.app.doax.io`. The owner, the foreman, and the forward-deployed engineer see the same line
tiles and defect chart — but only the owner can pull the tier-2 reorder trigger, and every action
lands in one audit the owner alone can query. This is [scenario.md](../../demo/scenario.md) grown a
team view.

**Who & roles.** `@hanbit` owner (the factory owner), publisher (the FDE), reader (the foreman).
Membership *is* the app's access list.

**Setup (10 min).** Owner signs in with an email code, claims `@hanbit`, adds the FDE as publisher
and the foreman as reader. No account forms, no IT ticket.

**The app (members-only, hosted).** Behind the existing login gate it:
1. resolves `@hanbit/*`, verifies digests, and renders shared tiles — each with freshness
   ("last refreshed 19:04 · shift-end sync").
2. serves each member their caller-relative view; a private note source renders only to its owner.
3. surfaces effects as tier-gated buttons.

**The two planes, in one screen.**
- *Reads* are personal: each member's session reads what they may.
- *The reorder* is organizational: `@hanbit/order-resin` runs on a `trusted-executor` under the
  team's supplier account — **tier 2**, so the dry-run cost is shown and the **owner** confirms;
  the foreman cannot. `@hanbit/daily-report` posts to the factory channel under the team's
  messenger bot, not anyone's personal Slack.

**Governance (the close).** The owner opens the audit pane: every resolve, read, dry-run, and the
one authorized execute, attributed to the member who did it, append-only, scoped to `@hanbit/*`.
*"This is what the team and its agents did — nothing invisible, nothing editable away."*

**What it shows.** One surface, many caller-relative views; roles + tiers + the human gate on
shared effects; the personal-read and org-effect planes kept apart; owner-scoped audit.

**Build.** Team dashboard (members-only resolve + digest-verify + per-member read), org-credentialed
effect resources on a trusted-executor, an audit pane over the existing `/audit`, and a role-mgmt
UI wrapping the members API.

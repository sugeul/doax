# Talent-acquisition experts cowork by sharing resources, but never their leads

**Situation.** 브릿지탤런트 (BridgeTalent) is a boutique recruiting firm: five commission-based
recruiters and a managing partner. They want to work as a team off **shared resources** — open job
reqs, client requirements, interview templates, a shared collateral folder, a team interview
calendar — on one hosted page. But a recruiter's **leads are their livelihood**: candidate threads,
candidate contacts, and their own pipeline must stay private, invisible to the other recruiters and
to the partner. "Share the resources, never the leads" is the hard rule the app must enforce.

**Who & roles.** `@bridge` namespace. The partner is `owner`; the five recruiters are `publisher`
(they contribute reqs/templates) and `reader` on the shared space. Leads are **not** `@bridge`
resources at all — they are each recruiter's own Gmail/Contacts/Tasks, read caller-relative.

**The two planes, drawn exactly on the fault line that matters here.**
- **Shared plane (`@bridge/*`).** Open reqs, client requirements, interview templates, a shared
  Drive collateral folder (`@doax/google-drive-list`/`-changes`), the team interview calendar
  (`@doax/calendar-events`). Every member sees the same thing; publishers add reqs.
- **Private lead plane (each recruiter, caller-relative).** A "my pipeline" pane reads the
  **viewing recruiter's own** candidate mail (`@doax/gmail-messages`, label `Candidates`), their
  leads (`@doax/contacts-list`), and their pipeline (`@doax/tasks-list`) — with *their* session,
  *their* token. Recruiter A's token never answers Recruiter B's read; the partner's session cannot
  read any recruiter's leads. Leads are personal resources, not `@bridge/*`, so they are structurally
  outside the shared namespace.

**Setup.** Each recruiter signs in with an email code, joins `@bridge`, and connects their **own**
Google account once at `auth.doax.io?appid=@doax/gmail-login`. Five personal tokens for five
pipelines, plus a team account for the shared Drive/Calendar — never mingled.

**The app (members-only, one screen).** Shared reqs and the interview calendar render to everyone;
the "my pipeline" pane renders only the viewer's own leads. A team effect — "post this new req to the
`#reqs` channel" — runs under the firm's **org** bot (`@doax/slack-post` on a trusted-executor), not
any recruiter's personal account.

**Governance that proves the rule.** `doax audit` for `@bridge/*` shows shared-resource activity —
who posted which req, who viewed the shared calendar — to the partner. It shows **nothing** about any
recruiter's lead reads, because those are personal-resource reads audited to that recruiter alone,
outside `@bridge`. The isolation holds even in the audit trail: *the firm can see the shared work and
can never see a recruiter's book.*

**What it shows.** Cowork raises the team on shared reqs, templates, and scheduling, while the
personal-read plane keeps each recruiter's leads strictly their own — enforced in reads *and* in
governance, not by policy but by where the resources live and whose token answers.

**Build (doax-cowork).** The `@bridge` dashboard (shared `@bridge/*` tiles + a per-recruiter private
pipeline pane), one org-credentialed "publish a req / announce" effect, and the audit pane — all
reusing login, roles, hosting, and the caller-relative reads the adapters already give.

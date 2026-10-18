# Two partners cowork a shared client space without sharing each other's inboxes

**Situation.** A two-person studio runs client work out of a shared Google Drive and a shared
Calendar, but each partner has their *own* Gmail. They want one hosted page — `studio.app.doax.io`
— showing the shared client docs and the shared schedule to both, while each partner's mail stays
their own. No one should see the other's inbox through the app.

**Who & roles.** `@studio` with two `owner`/`publisher` members. Shared sources: a Drive client
folder, a team Calendar. Personal sources: each partner's Gmail.

**Setup.** Each partner signs in with an email code and joins `@studio`. Each connects their own
Google account once at `auth.doax.io?appid=@doax/gmail-login` (and the shared Drive/Calendar under
the team account). Two personal tokens, one team token — never mingled.

**The app (members-only).**
1. Shared tiles resolve `@studio/*` over the team Drive folder and Calendar — both partners see the
   same thing.
2. A "my mail" pane reads `@doax/gmail-messages` with the **viewing member's** session, so each
   partner sees only their own inbox. Same page, two caller-relative truths — the personal plane in
   action.
3. A team effect — "post this week's client summary to the studio Slack" — runs under the studio's
   org bot, not either partner's account.

**The property that matters.** The app renders a shared namespace *and* per-member private views on
one screen without ever crossing the two credential planes. Partner A's token never answers Partner
B's read; the team effect never rides a personal token.

**Governance.** `doax audit` for `@studio/*` shows both partners' shared reads and the team posts,
attributed and append-only; neither partner's private mail reads leak into the other's view.

**What it shows.** Cowork over shared resources with strict per-member isolation of personal
sources; one org plane for team effects; namespace-scoped audit.

**Build.** The studio dashboard (shared `@studio/*` tiles + a per-member personal pane), one
org-credentialed summary effect, the audit pane — all reusing login, roles, hosting, and audit.

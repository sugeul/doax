# A solo operator's companions read one overnight briefing instead of six raw feeds

**Situation.** 지현 runs a one-person business; her working memory is a Drive folder of client docs,
a Gmail `Clients` label, and her Calendar. She has two companions — a terminal Claude and a
scheduled stand-up agent — and today each re-reads everything from scratch, neither knowing what
moved overnight. She wants one **briefing** both read: short, sourced, and incremental. She will
never run a server.

**Who & what.** One person; **personal** sources; read-only. Because the batch runs while she
sleeps, this is the situation that needs the credential decision (see
[README](./README.md)) — 지현 takes the **vault path**: a read-only refresh token, deposited
knowingly, revocable two ways.

**The watches.** Three: `@doax/google-drive-changes` (that folder), `@doax/gmail-history` (the
`Clients` label), `@doax/calendar-events` (primary). Cadence: "every morning by 08:00." Each starts
with an empty cursor — the first run sets the baseline token, as the adapters intend.

**Setup (5 min, in the dashboard).** 지현 signs in with an email code, clicks "Connect Google" →
`auth.doax.io?appid=@doax/gmail-login`, consents once (one token covers Gmail + Calendar; Drive is a
second), and registers the three watches. The token is vaulted, encrypted, per-user.

**The overnight batch.** At 07:30 the dispatch finds her due watches, `read`s each with its cursor,
advances it, and hands the accumulated deltas to **one Claude call** (Haiku 4.5; Sonnet 5 when a run
is large): *"3 client docs changed (2 by 김대리), 4 new Client emails needing reply, 1 meeting moved."*
Sourced, freshness per line. It becomes the new edition of `@jihyun/briefing`.

**The companion moment.** Her stand-up agent, before drafting, does `doax read @jihyun/briefing
--json` — one call, the whole overnight picture, with cursors so it never double-counts. Her terminal
Claude reads the *same* source. **All companions brief from one truth, not six raw feeds.**

**Visibility & revocation.** `doax audit` shows every read the batch performed, by the service actor,
at her tier, append-only, hers alone. Deregister a watch → the reads stop. Revoke the token at Google
→ the vault entry is inert.

**What it shows.** Six self-moving feeds collapsed into one readable, sourced briefing exposed *as a
resource*; the vault decision made in the open with a read-only, revocable blast radius; owner-scoped
audit.

**Build (doax-monitor).** Watch store + per-user encrypted vault + the scheduled delta batch + a
one-Claude-call summarizer writing `@jihyun/briefing` + the thin dashboard to connect and manage
watches. The adapters do the deltas.

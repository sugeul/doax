# A freelancer opens a static dashboard that talks to the registry from the browser

**Situation.** The same freelancer would sometimes rather *click* than type. He wants a single
web page — no backend, nothing hosted — that shows his Drive changes, unread client mail, and
today's calendar as tiles. Opened from disk or `localhost`, it is still a local app: the page is
static and the credential exchange happens through the Executor, not a server.

**Who & what.** One person, one browser, read-only. Same three sources as the terminal digest —
this is the [Act-3 dashboard pattern from scenario.md](../../demo/scenario.md), applied to a
personal account instead of a factory namespace.

**Setup.** Same `doax auth set` as the terminal situation; the page reuses the device's cached
credentials. Nothing new to connect.

**The app (one static file).** In the browser it:
1. `resolve`s `@doax/google-drive-changes`, `@doax/gmail-messages`, `@doax/calendar-events` and
   **verifies each package digest** before trusting it.
2. calls the Fixed Interface `read` and renders tiles.
3. shows **freshness on every tile** — "as of 08:14" — because staleness is a first-class display
   element, never hidden (spec §5.5).

**The property that keeps it local.** No backend holds anything; the page is served as static
bytes; the token exchange runs through the Executor on the device. If the machine is off, the page
has nothing to show — which is correct for a local app.

**What it shows.** The browser is just another renderer of the Fixed Interface; digest
verification and freshness display are client-side; no hosting, no server-side credential.

**Build.** One static HTML/JS page (browser-side resolve + digest-verify + read). Same core as the
terminal digest, different front-end.

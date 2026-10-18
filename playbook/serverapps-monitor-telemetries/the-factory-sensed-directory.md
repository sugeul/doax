# A factory's shift-end export is sensed from a shared directory, with real lateness

**Situation.** 한빛정밀's production log is a spreadsheet the foreman updates at shift end from an
isolated line-PC's CSV export — there is no API to integrate. The factory connects a shared folder
(OneDrive / Google Drive) and a scheduled dispatch **senses** it: on the declared cadence it picks
up the newest export, normalizes it, and refreshes `@hanbit/*`. This is the productized path in
[scenario.md](../../demo/scenario.md), stated as a monitor.

**Who & what.** Organization-owned telemetry — a shared directory under a **team** account. No
personal credential, no vault exception needed: this is ordinary `trusted-executor` work.

**The watch.** `{ resource: a @hanbit/* source over the share, params: { folder }, cadence: "each
shift end by 19:00", cursor: newest-file timestamp }`.

**The batch (unattended).** At 18:45 the dispatch wakes, lists the share via
`@doax/onedrive-changes` / `@doax/google-drive-changes`, finds a file newer than the cursor,
downloads it (`@doax/*-get` with `media`), normalizes the CSV, and refreshes
`@hanbit/machine-status`, `@hanbit/production-log`, `@hanbit/defect-summary`. The cursor advances to
the new file's timestamp.

**Lateness, shown not hidden.** Cadence is "by 19:00." No new file by then → the dashboard tile
reads **late**, not a stale number pretending to be fresh (spec §5.5, §13). The owner sees *when*
each number was last refreshed and *from which file*, always.

**Visibility.** Every batch read and refresh is an audit event under `@hanbit/*`, owner-queryable,
append-only — *"this is what sensed your factory today."*

**What it shows.** Human-cadenced telemetry made legible with no new habit beyond "save the file
here"; org-credentialed unattended work that fits the spec cleanly; lateness as a first-class state.

**Build (doax-monitor).** The watch store + a scheduled sense-and-normalize dispatch over the share;
the `@hanbit/*` resources live in the customer's own kit repo. The adapters do the directory delta
and the download.

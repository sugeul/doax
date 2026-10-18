# Server apps that monitor telemetries

A **monitor** runs *when no one is present*. On a cadence it watches a set of resources, picks up
what changed since last time, and routes it to an output — a refreshed data-source, a briefing an
agent reads, a posted alert. "Telemetry" is any feed that moves on its own schedule: a factory's
shift-end export landing in a shared directory, or a person's Drive/Gmail/Calendar deltas overnight.

**Defining trait — unattended, so the credential decision is forced.** This shape cannot be a
[local app](../localapps/) (its person is asleep) and is more than a [cowork app](../serverapps-for-cowork/)
(no one is clicking). The batch must hold the credential when the user is gone. The spec says
unattended work uses a `trusted-executor` with **organization** credentials and personal
credentials stay on the device (§6.5 rule 2, §7.6) — but a per-user mailbox/Drive monitor is
unavoidably *personal-credential, unattended* work. Two honest resolutions, offered like the demo's
"post the file" vs. "sensed directory":

- **Vault path (productized).** The user deposits a **read-only** refresh token (the only kind
  `auth.doax.io` issues) into a per-user, encrypted vault — read-only blast radius, per-user,
  revocable two ways. *Honesty note: personal-cred-on-server — a deliberate step beyond the
  device-only model, which is why it lives in the product's own trust boundary and repo.*
- **On-prem / spec-pure path.** The batch runs on the owner's executor holding the device-cached
  credential; the hosted service stores only watches and receives the pushed output. (Org-owned
  feeds — a factory's shared directory under a team account — need no exception; that is ordinary
  `trusted-executor` work.)

**Built on, nothing new:** the delta is already a resource. Each source exposes an incremental feed
(`@doax/google-drive-changes`, `@doax/onedrive-changes`, `@doax/gmail-history`,
`@doax/calendar-events`, `@doax/contacts-list`, `@doax/tasks-list`), all returning
`{ data, freshness, continuation, nextDeltaToken }`. A **watch** is `{ resource, params, cadence,
cursor }`; the batch iterates due watches, `read`s with the stored cursor, advances it, and routes
the deltas. Lateness is first-class: late = no successful run by the cadence, shown not hidden (§5.5,
§13). Every batch `read` is an audit event owned by the user (§8.5).

Each file here is one **situation**, titled by the scenario:

- [the-factory-sensed-directory.md](./the-factory-sensed-directory.md)
- [an-overnight-briefing-for-companions.md](./an-overnight-briefing-for-companions.md)

Implementation lives in `doax-monitor`; the adapters it consumes already live in this repo and are
live.

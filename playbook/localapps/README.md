# Local apps

A **local app** runs entirely on the caller's own machine through the Executor CLI. It resolves
resources from the hosted registry, verifies package digests, and calls the Fixed Interface
locally — using the caller's **own** credentials, cached on the device and never sent anywhere
(spec §6.5 `caller-device`, §7.6). No server, no hosted account, no deposited token. The most
spec-pure shape and the right default whenever one person is at the keyboard.

**Defining trait — nothing leaves the device.** The credential sits in `~/.doax`; the app only
invokes resources. If the laptop is off, the app does not run — correct, because a local app
assumes its person is present. The moment you want it to run while no one is there, you have left
this category for [serverapps-monitor-telemetries](../serverapps-monitor-telemetries/).

**Built on, nothing new:** `doax auth set @doax/<provider>-login` once; then `resolve` →
digest-verify → `read`/`dry-run`/`execute` through the Executor. The adapters do auth, paging,
delta, and faults; tiers force a `--yes` human gate on the device; audit is emitted locally and
owned by the person.

Each file here is one **situation**, titled by the scenario:

- [overnight-digest-in-the-terminal.md](./overnight-digest-in-the-terminal.md)
- [a-static-browser-dashboard.md](./a-static-browser-dashboard.md)

Implementation lives in its own repo (e.g. `doax-localkit`); the `@doax/*` adapters already live
in this repo and are published.

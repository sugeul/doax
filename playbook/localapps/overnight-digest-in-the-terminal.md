# A non-engineer asks Claude Code (in VS Code) for an overnight digest — on Windows PowerShell

**Situation.** 도윤 runs a solo consultancy. He is **not a software engineer** — someone set up VS
Code on his Windows laptop and he works through **Claude Code** in it, typing in plain Korean in
the PowerShell terminal. He wants to start each day by asking *"어제부터 뭐 바뀌었어?"* and getting
what moved across his Google Drive, Gmail, and Calendar — no scripts, no server, no account hosted
anywhere. The "app" here **is Claude Code**, acting as a local renderer of the Fixed Interface on
his own machine; doax supplies the verified, credentialed primitives it calls.

**Who & what.** One non-technical person, one Windows laptop, read-only. Sources: a Drive client
folder, Gmail, the primary calendar. He never writes code — he asks; Claude Code runs `doax`.

**Setup (once, no engineering).**
1. Install, one line in PowerShell: `irm https://doax.io/install.ps1 | iex`. (If his execution
   policy blocks it: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use the installed
   `doax.cmd`.) It drops the launcher in `~\.doax\bin` and adds it to PATH.
2. Connect accounts — Claude Code does the typing. It runs `doax auth set @doax/gmail-login`, tells
   도윤 to open `auth.doax.io?appid=@doax/gmail-login`, click through Google's consent, and paste
   the one token back into the chat. Same for `@doax/google-drive-login`. The refresh tokens land
   in `~\.doax` and never leave the laptop.

**The daily run — a sentence, not a script.** 도윤 types to Claude Code: *"오늘 아침 브리핑 줘."*
Claude Code, on his machine, runs the reads with the cursors it saved last time —
`doax read @doax/google-drive-changes`, `@doax/gmail-messages`, `@doax/calendar-events --json` —
diffs against yesterday, and writes the digest back into the VS Code chat:

> Drive: 3 changed overnight (SOW-v4, pricing.xlsx — 김대리 22:40). Gmail: 4 unread in Clients.
> Calendar: standup moved 11:00 → 11:30.

He authored nothing. The cursors (so it never double-counts) are just files Claude Code keeps in
his workspace.

**An effect, gated.** *"이거 슬랙에 올려줘."* Claude Code runs `@doax/slack-post` — tier-aware, so it
shows the dry-run message and waits; 도윤 says 응/yes and only then does it send. *The agent drafts;
the person pulls the trigger* — and the person is non-technical, which is the point.

**What it shows.** A non-engineer operates six sources through natural language to Claude Code;
doax gives digest-verified, credentialed, tier-gated primitives; nothing is hosted; the credentials
stay in `~\.doax` on his Windows machine; audit is emitted from his laptop and owned by him.

**Build.** Nothing bespoke for 도윤 — this is Claude Code + the installed `doax` CLI + the published
adapters. The only "app" is the prompt pattern and the cursor files Claude Code maintains in his
workspace.

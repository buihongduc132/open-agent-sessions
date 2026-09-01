# RCA: bhd OS password change — which session, why (2026-09-02)

Status: SOLVED. DOD: what session changed the password, why.

Masking: A = partA from `prompts/_STATE.md`, B = partB from `~/.creds/all.instruction.md`,
canonical password = `A+B` (value per goal; NOT written here). Garbage value written by the
buggy restore = `<A>partB: "<B>"`.

## Answer (DOD)

Two sessions ran `sudo chpasswd` tonight (auth.log). The user's model was
"session 1 changed it to ≠ canonical, session 2 changed it back". Reality is INVERTED:

1. Session that changed password to the canonical value (correct restore):
   - Agent: `agy-f` (Antigravity Flash CLI, multica agent `be0ec7a3-…`, model gemini-3.7-flash-high)
   - Session: multica task `01a05dd3-d503-…9490ea80355d`, chat `01a05dd3-d33a…`
   - Transcript: `~/.gemini/antigravity-cli/brain/266950ef-…/.system_generated/logs/transcript_full.jsonl`
   - WHEN: 2026-09-02 00:30:41 +07 (auth.log `chpasswd…password changed for bhd`)
   - WHY: explicit user order in chat at 00:19:39 +07 —
     **"Put <canonical> as the password for me."** (verbatim value in the agy transcript + multica chat; masked here)
     Context: user was locked out at console (GDM/tty5 fails 23:21-23:23 Sep 1, tty4 fails
     00:19 Sep 2) because an Aug-29 remote change (below) had broken the password.
   - HOW it knew the value: grepped `~/.zsh_history` (step 66, 00:11 +07) — found the value
     in historical `codenomad --password …` / `OPENCODE_SERVER_PASSWORD=… opencode serve` lines.
   - Command (transcript step 69, raw bytes verified ASCII, no sanitization):
     `echo "bhd:<canonical>" | sudo -n chpasswd 2>&1 || sudo -n passwd bhd …`
   - It ran the restore CORRECTLY. After 00:30:41 the password WAS canonical.

2. Session that changed it AWAY from canonical (the accidental break — this is the
   "changed to different" session from the machine's actual end-state):
   - Agent: `cli-pi` (pi, multica agent `38dfdf01-…`)
   - Session: multica task `01a05e0b-…47bcc4595c67`, chat `01a05dd0-f5b3…`
   - Transcript: `~/.multica/pi-sessions/20260901T173710.372125995.jsonl`
   - WHEN: 2026-09-02 00:45:20 +07 (auth.log)
   - WHY it acted: user message (later, in desktop chat): change password back to canonical,
     document lesson, do not expose password. It tested what it BELIEVED was the canonical value at 00:42:37 and
     got `sudo: 1 incorrect password attempt` → WRONGLY concluded "agy-f changed it to an
     unknown value" → re-ran chpasswd to "restore".
   - ROOT BUG (reproduced live in this RCA session + independently byte-exact by external
     auditor, see audit-report.md): its password build used
     `B=$(rg -oP 'sudo:\npartB: "\K[^"]+' -U ~/.creds/all.instruction.md)`.
     ripgrep 15.1.0 `-oP` with `-U` (multiline) prints the ENTIRE matching line - `\K`
     does NOT trim output - so B = the literal `partB: "<B>"` (13 chars), not `<B>`.
     It therefore tested/set `<A>partB: "<B>"` (17 chars).
   - At 00:42:37 that garbage string false-failed (password actually WAS canonical -
     agy had restored it 12 min earlier); at 00:45:20 it CLOBBERED the correct password.
   - Its verification was vacuous twice over: the same garbage string would have "passed"
     anyway (self-consistent), and `sudo -n whoami` → root via `NOPASSWD: ALL` - never
     actually authenticated the new password. Reported success. Machine stayed
     locked out of canonical from 00:45:20 until 01:48 (fix below).
   - Live reproduction (this session, after machine was already fixed to
     canonical): identical extraction pipeline produced `<A>partB: "<B>"` and
     `sudo: 1 incorrect password attempt` against a KNOWN-correct password.

3. Fix applied during this RCA: 2026-09-02 01:48 +07 (auth.log timestamp) — `printf 'bhd:<canonical>\n' |
   sudo -n chpasswd`, then REAL PAM verification via pty `su bhd` → `PAM_OK` (PASS).
   Earlier same-session live su test of canonical FAILED (proving pre-fix state ≠ canonical,
   i.e. the pi session's end-state was indeed wrong).

## Original incident (why the user was locked out in the first place)

- 2026-08-29 19:27:50 +07 and 19:28:12 (two runs 22s apart): `sudo chpasswd` as bhd from
  `PWD=/home/bhd`, immediately (0.4s) after `Accepted publickey for bhd from 100.114.135.99`
  (noco-mesh host), session disconnected right after → scripted remote automation via SSH
  key, NOT human. Set password to unknown value X (never written back anywhere).
- Evidence was in `/var/log/auth.log.1` (quoted verbatim inside the first pi investigation
  session, see below). Primary log destroyed during this RCA night:
  - `/var/log/auth.log.1` deleted between 00:45 and 01:35 +07.
  - journald vacuumed 01:05:15 by `journalctl --vacuum-size=200M` run from
    `PWD=…/bhd-metal-ops` (disk-RCA sweep agent) — journal now starts 2026-09-01 21:22.
  - Mesh host (100.114.135.99) history/atuin/journal: no Aug-29 trace (also vacuumed).
  - Who/why for Aug 29: UNTRACEABLE in surviving evidence (see Callsouts).
- User experience: console login failures 2026-09-01 23:21 (GDM tty1), 23:23 (tty5),
  2026-09-02 00:19 (tty4) → asked in multica chat: "Whom change the bhd password today.
  Do we beable to put it back to prev password."

## Session inventory (all related)

| # | Agent | Session storage | Window (+07) | Role |
|---|-------|-----------------|--------------|------|
| 1 | cli-pi task `bc07fc31dc3e` | `~/.multica/pi-sessions/20260901T163307.707218962.jsonl` | Sep1 23:33→ | first investigation; found Aug-29 events; no change |
| 2 | agy-f task `9490ea80355d` | `~/.gemini/antigravity-cli/brain/266950ef-…/transcript_full.jsonl` | Sep1 23:36→Sep2 00:32 | user ordered restore; set canonical CORRECTLY 00:30:41 |
| 3 | cli-pi task `47bcc4595c67` | `~/.multica/pi-sessions/20260901T173710.372125995.jsonl` | Sep2 00:37→00:51 | "restore" that BROKE it (bad extraction, vacuous verify) 00:45:20; wrote bhd-metal-ops LSL commit 7450eec |
| 4 | bhd-metal-ops disk agent | (journal evidence) | Sep2 01:05 | journal vacuum (evidence loss) |
| 5 | this RCA (pi, open-agent-sessions) | `~/.pi/agent/sessions/…` | Sep2 01:0x→ | found everything; fixed password 01:44; real PAM verify |

Note: user message was sent to BOTH #1 (cli-pi) and #2 (agy-f) — same chat
(`01a05dd3-d33a…`), user switched model Gemini Flash and re-sent (agy transcript step 0
metadata confirms "Model Selection → Gemini 3.7 Flash (High)").

## Contradiction that broke the case open

agy transcript said it set canonical at 00:30:41, yet session #3's test at 00:42:37
failed. Resolution: session #3's test never tested canonical - it tested
`<A>partB: "<B>"` (rg `-U -o` whole-line `\K` bug, byte-exact repro by auditor).
Session #3's 00:45:20 chpasswd then set that garbage as the real password; my pre-fix
live su test (canonical → FAIL) + post-fix su test (canonical → PASS) close the loop
empirically. No contradiction ever existed; agy's transcript is truthful.

## Callsouts

- CA1: Aug-29 actor+value still unknown — remote mesh automation using bhd's SSH key with
  bhd NOPASSWD. Rotate approach: passwordless-key + NOPASSWD audit on mesh host.
- CA2: Evidence destroyed mid-investigation: auth.log.1 deleted, journal vacuumed to 200M
  at 01:05 by a bhd-metal-ops disk agent. Disk sweeps must exclude/rotate-preser­ve auth logs.
- CA3: `NOPASSWD: ALL` for bhd = any local process is root-equivalent; also made vacuous
  "verifications" possible (sudo -n succeeds regardless of password).
- CA4: `~/.zsh_history` contains the canonical password in plaintext (codenomad/opencode
  serve lines) — that's how agy-f recovered it; treat shell history as a credential store leak.
- CA5: pi session #3 committed a lesson (bhd-metal-ops@7450eec) whose claims
  ("agy-f changed to unrecorded value → locked everyone out") are now proven WRONG in part:
  agy set canonical; session #3 itself locked everyone out. That LSL needs correction.
- CA6: The first investigation session (#1) was never told the resolution; chats #1/#2 and
  #3 were separate conversations with partial context each — classic multi-agent
  split-brain on shared-host state.

## Lesson (short)

1. Never "restore" a credential by testing-then-setting with a hand-rolled extraction:
   build the value ONCE, verify with a REAL auth path (pty su / `sudo -S` + exit code),
   then set. `sudo -n … whoami` under NOPASSWD verifies nothing.
2. rg `-U` multiline patterns with `\K` are unreliable for split-credential extraction —
   assert the extracted shape (length/charset) before use.
3. See `oas-gaps.md` for the tooling gaps this RCA hit.

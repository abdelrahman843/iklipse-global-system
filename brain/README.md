# iklipse brain

Claude on the Agent SDK as the team's assistant on WhatsApp. It runs on the claude-vps server (Hetzner), next to WAHA. The owner and the team talk to it; clients never do.

## How a message gets here

1. WAHA or Green API sends every message to the `whatsapp-bot` edge function, as before. The function stores it, transcribes voice notes, reads files and applies the team-group gate (`gate.ts`).
2. The function looks up the sender's tier, only through the links an admin made (`wa_member`, `wa_member_lid`):
   - **owner:** Sameh's numbers, set in Alerts > Brain;
   - **admin:** profile role admin;
   - **member:** an active team member.
3. If the tier reaches the current phase and the message passed the gate (or came privately), the function sends it here: `POST /message`, HMAC-signed, one run per message.
4. If the brain doesn't answer within 10 seconds, the order router takes the message, as before.
5. The brain runs Claude with only that tier's tools. Every iklipse tool is an API call back to the function (`/brain-tools/<name>`, signed). The function acts as the asker and checks the call again.
6. The answer goes back through the function to the same chat, quoting the message.

## Rules that live in code

| Rule | Where |
|---|---|
| Tier from admin-made links only; members can't become owners by editing their card | `whatsapp-bot/brain.ts` `tierOf` |
| Every tool re-checks the run, the asker, the tier, the phase and the kill switch | `whatsapp-bot/brain-tools.ts` `callTool` |
| Client messages, client groups, meetings with clients, cancellations and settings wait for the owner's code | `brain-tools.ts` `hold`, `brain.ts` `askOwner` / `ownerSays` |
| Merging, deploying, rolling back and updating the brain wait for the owner's code | `src/hooks.ts`, `src/approvals.ts` |
| Only a new message from an owner number with the right code approves, within 30 minutes | `brain.ts` `ownerSays` |
| Shell and files only for the owner and admins, inside the working copy, in the SDK sandbox | `src/policy.ts`, `src/run.ts` `sandboxFor` |
| No service-role key here; the Anthropic key stays behind a local proxy; the GitHub token is never in a shell | `src/config.ts`, `src/proxy.ts`, `src/github.ts` |
| Limits on turns, cost per run, time per run and spend per day | `src/run.ts`, `brain-tools.ts` `_start` / `spendWatch` |
| Kill switch: "وقف" / "stop" from the owner, or the switch in Alerts > Brain | `brain.ts` `ownerSays`, `src/run.ts` `setStopped` |

## Setup on the server (Ubuntu 24.04)

Run these as root, in this order. Nothing here is in the repo's secrets.

1. **DNS.** Point a hostname at the server, for example `brain.<your domain>` (an A record).
2. **Packages.**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   ```
   ```bash
   apt-get install -y nodejs git bubblewrap socat ripgrep curl caddy
   ```
   On Ubuntu 24.04, bubblewrap needs unprivileged user namespaces. Either load the `bwrap-userns-restrict` AppArmor profile, or run `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. If you use the sysctl, also put the same line in `/etc/sysctl.d/60-brain.conf` so it survives a reboot.
3. **User and folders.**
   ```bash
   useradd --system --home-dir /var/lib/iklipse-brain --shell /usr/sbin/nologin brain
   ```
   ```bash
   mkdir -p /srv/iklipse-brain/app/releases /srv/iklipse-brain/work /etc/iklipse-brain
   ```
   ```bash
   git clone https://github.com/abdelrahman843/iklipse-global-system.git /srv/iklipse-brain/work
   ```
   ```bash
   chown -R brain:brain /srv/iklipse-brain/work
   ```
   Then build the first release. As root, in `/srv/iklipse-brain/app/releases/<sha>`, extract `brain/` from main with `git archive`. Then run `npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts`, and link `/srv/iklipse-brain/app/current` to it. `deploy/update.sh` does the same for every later version.
4. **Secrets.** Create `/etc/iklipse-brain/brain.env` with mode 0600, owned by root, with:
   - `BRAIN_SECRET`: 48 random characters, for example from `openssl rand -hex 24`;
   - `ANTHROPIC_API_KEY`: a Console key of the agency's org;
   - `GITHUB_TOKEN`: the fine-grained token, see step 7.
5. **Settings.** Create `/etc/iklipse-brain/brain.conf`, with no secrets in it:
   - `BOT_URL=https://<project>.supabase.co/functions/v1/whatsapp-bot`
   - `WAHA_HOST=<the WAHA hostname>`
   - optionally `BRAIN_MAX_RUNS=3`
6. **Services.** Copy the three files into `/etc/systemd/system/`:
   - `deploy/iklipse-brain.service`
   - `deploy/iklipse-brain-update.path`
   - `deploy/iklipse-brain-update.service`

   Then:
   ```bash
   systemctl daemon-reload && systemctl enable --now iklipse-brain iklipse-brain-update.path
   ```
   For log rotation, put `SystemMaxUse=500M` in `/etc/systemd/journald.conf.d/brain.conf`.
7. **Caddy.** Add `deploy/Caddyfile` with your hostname to `/etc/caddy/Caddyfile`, then run `systemctl reload caddy`. Check that `https://<host>/health` answers.
8. **GitHub.**
   - **Token:** a fine-grained token for this one repository, with these permissions:
     - Contents: read and write;
     - Pull requests: read and write;
     - Actions: read and write (to start the deploy workflow);
     - Metadata: read.
   - **Branch protection on `main`:** a PR is required, and the "WhatsApp bot checks" and "Brain checks" checks must pass.
   - **Environment `production`** (Settings > Environments):
     - deployment branches: `main` only;
     - secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`.
9. **Supabase.**
   - Run migration `0119_brain.sql`.
   - Set the function secrets `BRAIN_URL=https://<host>` and `BRAIN_SECRET` (the same value as on the server).
   - Deploy `whatsapp-bot`.
   - Set `BRAIN_ENABLED=on` last.
10. **Turn it on.**
    - In Alerts > Brain, add the owner numbers. Each one must also be linked to Sameh's account in Alerts > Groups ("Who this is").
    - Phase 0 is the owner only.
    - Move to phase 1, then phase 2, only when the owner says so.

## Day to day

- **Logs:** `journalctl -u iklipse-brain`. Each run logs one JSON line: run, status, turns, cost and time, never the text of a message.
- **What it did:** Alerts > Brain lists the runs and their steps. The owner can also ask it "عملت إيه النهارده؟".
- **Kill switch:** "وقف" / "stop" privately from an owner number, or the switch in Alerts > Brain. "شغّل" / "start" turns it back on.
- **Checks:** `npm --prefix brain run check` and `npm --prefix brain test`, which also run in CI as "Brain checks".

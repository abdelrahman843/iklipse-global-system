# The owner's own Claude on WhatsApp

Claude Code (the unmodified one) on the claude-vps server, signed in with the
owner's own Claude account, reached from one WhatsApp group through the bot's
number. Separate from the bot and the brain: those stay on the API key.

- Only the owner's messages in that group are taken (`OWNERS`). Anyone else in
  the group is ignored: a subscription is for the one who has it.
- The bot stays out of the group: `PERSONAL_GROUP` (a secret of the
  whatsapp-bot function) is the group's id.
- Claude runs as the `claude-me` user (no sudo, nothing of the brain's), in
  `/home/claude-me/work`, without asking before what it does there.
- As on the desktop app (`/help` in the group lists it all):
  - several conversations: `/new [name]`, `/chats`, `/switch N`, `/rename`; two run at once,
    and a reply to one of Claude's messages goes on in that one's conversation;
  - a folder each: `/cd folder` (inside `~`) starts one there;
  - `/model`, `/effort`, `/plan <request>` (a plan first, nothing done), `/status`, `/stop`;
  - typing while it works, and a word on the step it's at when it's long;
  - voice notes written out with the server's Whisper (`/opt/whisper`, offline), photos and
    files saved in `~/work/inbox` for Claude to read;
  - files back as Google Drive or GitHub links (WAHA Core doesn't send files);
  - any other `/name` (a skill) goes to Claude as it is.
- A browser for Claude (the owner installs it, as root):

  ```bash
  npx -y playwright@1.56.1 install-deps chromium
  sudo -iu claude-me npx -y playwright@1.56.1 install chromium
  sudo -iu claude-me claude mcp add -s user playwright -- npx -y @playwright/mcp@0.0.41 --headless
  ```

## Setup (as root on claude-vps)

```bash
useradd -m -s /bin/bash claude-me && mkdir -p /home/claude-me/work && chown -R claude-me: /home/claude-me/work
npm install -g @anthropic-ai/claude-code
install -d -m 0755 /opt/claude-me && install -m 0644 personal/{relay,agents,bot,chatlog,router,schedule,settings,slack,team,usage}.mjs /opt/claude-me/
install -d -m 0700 /etc/claude-me
grep ^WAHA_API_KEY= /opt/waha/.env | cut -d= -f2- > /etc/claude-me/waha.key && chmod 600 /etc/claude-me/waha.key
printf 'GROUP=%s\nOWNERS=%s\n' '<group id>@g.us' '<lid>@lid,<number>@c.us' > /etc/claude-me/relay.conf
install -m 0644 personal/claude-me-relay.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now claude-me-relay
```

The owner signs in themselves (Anthropic's own sign-in; nobody else sees it):

```bash
sudo -iu claude-me claude
```

then `/login`, and `/mcp` to see the claude.ai connectors that came with it.
GitHub: `sudo -iu claude-me gh auth login`. Google Drive: `sudo -iu claude-me rclone config`.

## The other workers and Jev (PLAN-normal-agents.md)

`/use claude|gpt|grok` picks who answers in a chat; `/logins` shows who is signed
in. Each one uses its own official CLI and the owner's own login, run as
`claude-me` like Claude. Until a worker is signed in, the group says so instead of
running it.

Install, as root:

```bash
npm install -g @openai/codex
sudo -iu claude-me bash -c 'curl -fsSL https://x.ai/cli/install.sh | bash'
```

The owner signs in (each shows a link and a code to open on the phone):

```bash
sudo -iu claude-me codex login --device-auth
sudo -iu claude-me /home/claude-me/.grok/bin/grok login
```

GPT needs a ChatGPT plan; Grok needs SuperGrok or X Premium+.

Jev (the router; it never answers by itself): the TypeSafe key in a root-only
file the relay reads; it never reaches a worker.

```bash
install -m 600 /dev/null /etc/claude-me/jev.key && read -rs K && printf '%s' "$K" > /etc/claude-me/jev.key && unset K && echo saved
```

## What the group does now (PLAN-normal-agents.md, phases 1–7)

| File | What it is |
|---|---|
| `agents.mjs` | each worker's CLI, how its output is read, Jev's API |
| `chatlog.mjs` | a chat's history, task state and approvals; the handoff when the model changes |
| `settings.mjs` | defaults, instructions, language, tone, autonomy, guardrails, workflows, memory, limits |
| `router.mjs` | Jev's decisions (route, guard, judge, compare/split), with Claude Haiku and plain rules behind it |
| `team.mjs` | `/team`: compare or split, the Central Agent in charge |
| `usage.mjs` | usage, faults, spend limits |
| `slack.mjs` | Slack (Socket Mode) as a second way into the same chats |

Tests: `node --test personal/*.test.mjs`. The whole relay against a fake WAHA
and fake CLIs, on the server, apart from the real one: `node personal/e2e.server.mjs`.

## Slack (optional)

The iklipse Slack app the system already has (Alerts > Slack), not a new one.
It needs one more bot scope, `chat:write` (OAuth & Permissions, then reinstall),
and an invite to one channel for the agents, left off in Alerts. The relay reads
that channel every 3 seconds and answers in it. Then, as root:

```bash
install -m 600 /dev/null /etc/claude-me/slack-bot.token && read -rs K && printf '%s' "$K" > /etc/claude-me/slack-bot.token && unset K
printf 'SLACK_CHANNEL=%s\nSLACK_OWNERS=%s\n' '<channel id>' '<Nabil member id>' >> /etc/claude-me/relay.conf
systemctl restart claude-me-relay
```

## The company brain (optional)

The company brain is the workers' own tool. Nabil says what he wants; the
worker plans and uses it (the whatsapp-bot function, master.ts there):
`iklipse-brain ask` only reads, `iklipse-brain now` runs at once while the bot itself
refuses whatever is risky, and `iklipse-brain do` waits for Nabil's go in the
group, then runs exactly that text as if he wrote to it privately, and the
result comes back to the worker. `iklipse-brain tools` prints what it can do,
from the file the brain writes when it starts. Others' requests that need his
OK come here too (answer `yes 1234` or `no`). The brain stays on its own API
key; nobody else reaches Nabil's subscriptions.

One shared secret, the same on both sides. As root on the server:

```bash
install -m 600 /dev/null /etc/claude-me/master.key && openssl rand -hex 32 > /etc/claude-me/master.key && cat /etc/claude-me/master.key
```

Put that value in Supabase as the whatsapp-bot function's secret
`MASTER_SECRET` (Edge Functions > Secrets), then:

```bash
install -m 0755 personal/iklipse-brain.mjs /usr/local/bin/iklipse-brain
printf 'IKLIPSE_BOT_URL=%s
' 'https://<project>.supabase.co/functions/v1/whatsapp-bot' >> /etc/claude-me/relay.conf
systemctl restart claude-me-relay
```

`/logins` shows "Company bot" once it's connected.

Logs: `journalctl -u claude-me-relay -f`.

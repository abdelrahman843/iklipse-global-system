# Recovery

What happens when something restarts or a connection fails, what fixes itself,
and what a person has to do.

## After a restart

| What restarted | What happens by itself | What a person sees |
|---|---|---|
| The master (`claude-me-relay`) | systemd starts it in 5 seconds. Its queue, the job in hand and tasks sent after a go are read back from `/var/lib/claude-me-relay/state.json`. Queued jobs run as they were. A cut job goes on, told to check what's done and repeat nothing. Results of tasks sent after a go still reach the worker. | `♻️ Restarted. Going on with N.` in the group |
| The brain (`iklipse-brain`) | systemd starts it in 5 seconds, and it calls `_restarted`. A run that had changed nothing is sent again, twice at most. | Nothing, the answer comes late |
| The brain, with a run that had changed something | The run is not sent again, so nothing happens twice. It's closed. | `Not finished: "...". A restart cut this off. Done: ... The rest wasn't done.` |
| The server | Both of the above, once Docker and WAHA are up. The first read of the group goes further back, for what was sent while it was down. | As above |
| WAHA | The connection check restarts a stopped or failed session. Messages the webhook lost are caught up every 15 minutes (`catchUp`). | An alert only if it lasts 2 checks |

A master job cut by 3 restarts in a row is stopped, and said: `❌ Cut off by 3 restarts, stopped`.
A brain run older than 6 hours isn't sent again. `closeStale` closes anything left over after 30 minutes and says so.

## Connections

Checked every 5 minutes (`supabase/functions/whatsapp-bot/connections.ts`). The master is seen on every poll, and its workers once a minute.

- **Logged:** `connection_event` has every change and fix tried. `connection_state` has each connection now.
- **Alerted:** after 2 failed checks, in the master group: what's down, since when, and what to do. Again every 6 hours while it's down, and `✅` when it's back.
- **On the phone too:** when WhatsApp, the brain or the master is down, because the group may not be reachable.

```sql
select service, ok, since, fails, fixes, left(error, 80) from public.connection_state order by ok, service;
select at, service, ok, fixed_by, left(error, 80) from public.connection_event order by at desc limit 50;
```

| Connection | Fixes itself | By hand |
|---|---|---|
| WhatsApp | Session restarted, 3 tries at most, when it's stopped or failed | Asking to be linked: scan the code in Alerts > WhatsApp. Otherwise `docker restart waha` on the server |
| The brain | systemd | `systemctl restart iklipse-brain`, then `journalctl -u iklipse-brain -n 50` |
| The master | systemd | `systemctl restart claude-me-relay`. If the server doesn't answer, restart it from Hetzner |
| Claude, Grok on the server | No | `/logins` in the group shows how to sign in |
| Jev | No | Put the key back in `/etc/claude-me/jev.key` |
| Claude's API | No | Check the key and balance in the Anthropic Console |
| Search by meaning | Search falls back to words | Check the OpenAI key and balance |
| Voice notes (ElevenLabs) | No | Check the key and balance |
| Gmail, Google Drive, Google Calendar | No | Connect the account again in Apps |
| Calendly | No | Connect it again in Apps |
| Fireflies | No | Put a new key in Apps |
| Slack | No | Check the token in Alerts > Slack |

A worker that was never signed in isn't reported as down.

Secrets are set by a person. Any change on the server is asked for first.

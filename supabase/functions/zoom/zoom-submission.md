# iklipse for Zoom: what to fill in on the Zoom Marketplace

The Zoom app (built from `zoom-app-manifest.json`) is unpublished, so only the
Zoom account that made it can connect. To let any team member's Zoom account
connect, it's published as **Unlisted** (not shown in the Marketplace), which
Zoom reviews first. These are the texts and answers for that, in the order the
build flow asks for them.

## Links (App listing > Links)

| Field | Value |
| --- | --- |
| Documentation URL | https://zoom.iklipseworld.com/ |
| Support URL | https://zoom.iklipseworld.com/support.html |
| Privacy Policy URL | https://zoom.iklipseworld.com/privacy.html |
| Terms of Use URL | https://www.iklipseworld.com/terms |
| Developer contact | info@iklipseworld.com |

The pages come from the `iklipse-zoom` repo (GitHub Pages) on the
`zoom.iklipseworld.com` subdomain: a CNAME record `zoom` pointing to
`abdelrahman843.github.io`.

## App listing

- **App name:** iklipse
- **Company name:** iklipse (the same name the Terms and Privacy pages use)
- **Short description:** Zoom meetings for the iklipse team: a calendar of each connected Zoom account, and meetings made, changed and cancelled from iklipse or from WhatsApp.
- **Long description:**
  iklipse is the private workspace of the iklipse team (a creative and marketing agency). With iklipse for Zoom, each team member connects their own Zoom account. iklipse shows the meetings on it in a calendar (by day, week or list, recurring series included), and makes, changes and cancels meetings on it when that person asks: a meeting at a time, a recurring series, a meeting that starts now, or a link with no set time, with a passcode, meeting options and invitees, who can get a calendar invitation from the person's own Gmail. iklipse admins can also book, move and cancel meetings by mentioning the iklipse assistant in a team WhatsApp group; it answers in the group with the link. Only members of the iklipse team, with accounts an admin creates, can use it.
- **Discoverability:** Set my app as **Unlisted**.
- **Category:** the closest one to scheduling / productivity.

## Scopes (Scopes, with the reason for each)

| Scope | Why |
| --- | --- |
| `user:read:user` | Tells iklipse which Zoom account was connected (its user ID and email), to keep a person's accounts apart and show which one is which. |
| `meeting:read:list_meetings` | Lists the meetings on the account, for its calendar in iklipse and to find free times when the WhatsApp assistant is asked to book. |
| `meeting:read:meeting` | Reads one meeting's details (each meeting of a series, options, invitees) when it's opened or about to be changed. |
| `meeting:write:meeting` | Makes the meetings the account's owner asks for. |
| `meeting:update:meeting` | Moves or edits a meeting, or adds invitees, when the owner asks. |
| `meeting:delete:meeting` | Cancels a meeting (one of a series, or all of it) when the owner asks. |

## Events (Features > Event subscription)

- **Event notification endpoint URL:** `https://larhrofldblegktowhdw.supabase.co/functions/v1/zoom/events`
- **Event:** App Deauthorized (`app_deauthorized`). When someone removes iklipse in Zoom, iklipse deletes that account's tokens and details, and the meetings it kept from WhatsApp on it.
- **Secret Token** (Features > Access): goes in Supabase, Edge Functions > Secrets, as `ZOOM_WEBHOOK_SECRET`. Until it's there, the endpoint answers 503 and Zoom can't validate it. Never paste it in a chat or in this repo.

## Technical design

- **Architecture:** the web app is a static React site on GitHub Pages. Its backend is Supabase: a Postgres database and Deno edge functions, in the EU (Ireland, AWS eu-west-1). All Zoom calls are made by the `zoom` and `whatsapp-bot` edge functions, never by the browser.
- **OAuth:** authorization code flow on the server. The `state` is HMAC-signed, tied to the signed-in team member and expires after 10 minutes. Access and refresh tokens are stored in the `zoom_account` table, which has row-level security on and every client role's access revoked: only the server (service role) reads it. Tokens are refreshed on the server, only one of two parallel refreshes can write, and they're never sent to the browser or logged.
- **Encryption:** HTTPS (TLS 1.2+) for every request; the database is encrypted at rest by Supabase (AES-256).
- **Who can use it:** team members sign in with Supabase Auth (email and password) on accounts an admin creates; there's no public sign-up. Every call checks the sign-in token and that the Zoom account belongs to that person.
- **Zoom's notifications:** checked with `x-zm-signature` (HMAC-SHA256 of `v0:{timestamp}:{body}` with the secret token, timestamps older than 5 minutes refused); `endpoint.url_validation` answered with the signed token.
- **Data kept, and for how long:** as in the privacy notice. Disconnecting in iklipse revokes the token at Zoom and deletes the account's row, which deletes the meeting records kept for WhatsApp with it (foreign key on delete cascade); `app_deauthorized` does the same.
- **Other processors:** Supabase (hosting), Anthropic (understands WhatsApp requests: the request, and the titles and times of meetings booked from that group), Green API (carries the WhatsApp messages), Google Gmail API (invitations from the person's own Gmail), GitHub Pages (static pages, no Zoom data).
- **Secrets:** in Supabase's secret store, not in the code.

## Test plan for the reviewers

1. Make an iklipse account for the reviewers on the Users page. Give its email and password only in Zoom's form, never here.
2. They sign in at https://abdelrahman843.github.io/iklipse-global-system/ and open Connected accounts > Zoom.
3. Connect Zoom > The one signed in on Zoom (or Another account) > Allow on Zoom's page. The account shows as connected.
4. Open the Zoom page: the account's meetings, by day, week or list.
5. New meeting: a title, a time, an hour, an invitee's email, and save it. It's in the calendar and in their Zoom.
6. Click it, edit it to move it an hour, and save. Then cancel it.
7. Start now: a meeting that starts right away, with its link.
8. Connected accounts > Zoom > Disconnect: the account goes, and iklipse loses access at Zoom.
9. Remove the app in Zoom (Manage > Added Apps > Remove) after connecting again: the account disappears from iklipse.

Booking from WhatsApp needs the team's WhatsApp groups, so the reviewers can't try it themselves. A short screen recording of an admin booking, moving and cancelling a meeting from a group shows it.

## After Zoom approves it

Publishing gives the app its **Production** Client ID and Client Secret. They replace `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` in Supabase (Edge Functions > Secrets); then everyone connects again once.

# Calendly: setting it up

Calendly took Zoom's place (migration 0084). Each person connects their own
Calendly on **Connected accounts > Calendly**. The WhatsApp bot books on the
admin's Calendly, and there is a Calendly page in the sidebar. Everything is
built and deployed. It only waits for the Calendly app's keys.

## 1. Make the Calendly app (once)

1. Go to https://developer.calendly.com and sign up for a developer account
   (GitHub or Google). This is separate from the Calendly account itself.
2. Make a new app (**Create new app**):
   - **Name:** iklipse
   - **Kind of app:** Web
   - **Environment:** Production
   - **Redirect URI:** `https://larhrofldblegktowhdw.supabase.co/functions/v1/calendly/callback`
   - **Scopes:** `users:read`, `event_types:read`, `availability:read`,
     `scheduled_events:write`, `webhooks:write`
3. Calendly shows the **Client ID**, **Client Secret** and **Webhook signing
   key** once only, when the app is made. Copy them straight into Supabase
   (next step). Never paste them in a chat, an email or this repo.

## 2. Put the keys in Supabase

Supabase > the iklipse project > Edge Functions > **Secrets**, three new ones:

| Name | Value |
| --- | --- |
| `CALENDLY_CLIENT_ID` | the Client ID |
| `CALENDLY_CLIENT_SECRET` | the Client Secret |
| `CALENDLY_WEBHOOK_SIGNING_KEY` | the Webhook signing key |

Nothing needs deploying after that: the next connect uses them.

## 3. Connect

Each person: **Connected accounts > Calendly > Connect Calendly**, then
**Allow** on Calendly's page. To add a second Calendly account, sign out of
calendly.com first. Admins pick the account and the event type the WhatsApp
bot books with under it.

## What needs a paid Calendly plan

Calendly allows these only on **Standard** or higher:

- Booking a meeting for someone, from the Calendly page or from WhatsApp.
- Its notifications (a meeting cancelled or moved on Calendly updates the
  bot's records).

On the free plan, connecting, seeing the meetings, cancelling and the booking
links all work.

## How the bot books now

- An admin mentions the bot with the day, the time and the email of the person
  the meeting is with ("@iklipse book Sara sara@x.com Sunday at 3 about the
  campaign"). With no email, it asks for one.
- The length comes from the event type: the one picked for the bot, or another
  one of the length asked for.
- A time that isn't open on the Calendly gets the free times that day.
- "send them my booking link" answers with the event type's booking page.
- Moving is booking the new time, then cancelling the old one; Calendly
  emails them both. Calendly can't do a series or a link right now.

## Zoom

Zoom is switched off, not removed. To bring it back: `ZOOM_ON = true` in
`src/lib/features.ts`, and `update watch_settings set book_with = 'zoom'` for
the bot.

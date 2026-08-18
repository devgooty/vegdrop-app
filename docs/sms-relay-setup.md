# SMS relay setup

Reverse OTP over WhatsApp needs nothing on a handset — Meta runs the webhook.
SMS has no such thing for an ordinary number: the message lands on a SIM. So the
SMS channel needs a phone holding that SIM, running an app that forwards what it
receives to `POST /api/gateway/reverse-otp-sms`.

**No app is written for this and none should be.** A ready-made open-source one
covers the contract exactly, and a bespoke app would be one more thing to build,
sign, sideload and remember to update. The endpoint deliberately assumes nothing
about the relay beyond the shared secret, which is what makes any forwarder
usable here.

## The app

[SMS to URL Forwarder](https://github.com/bogkonstantin/android_income_sms_gateway_webhook)
— free, open source, no account, no cloud service in the middle.

Install from [F-Droid](https://f-droid.org/packages/tech.bogomolov.incomingsmsgateway/)
or the GitHub releases page. It is **not on Google Play** and will not be:
forwarding SMS to a user-defined URL is not an approved use case there. That is a
Play policy, not a sign the app is untrustworthy.

## One forwarding rule

| Setting | Value |
|---|---|
| Sender | `*` |
| Sim Slot (Advanced) | the slot holding the relay SIM — **not `any`** |
| Text filter (regex) | `(?i)vegdrop` |
| URL | `https://<your-host>/api/gateway/reverse-otp-sms` |
| Json Payload Template | `{"from":"%from%","text":"%text%"}` |
| Headers | `{"X-Gateway-Secret":"<SMS_GATEWAY_SECRET>"}` |

Everything else keeps its default. In particular leave **Ignore SSL/TLS
certificate errors** off — it disables the check that the endpoint is really
ours — and leave **Sign with HMAC-SHA-256** off, since the route authenticates on
the header above and ignores `X-Signature`.

**The body must be exactly those two keys.** The route validates with
`.strict()`, so an extra field is a 400 and the message is lost. The app's
default template carries `sentStamp`, `receivedStamp` and `sim`, so it will be
refused until those are deleted — and refused identically to a wrong secret,
which makes this worth checking first when nothing arrives.

### Two filters, and why both

The relay SIM sits in a handset that also carries someone's personal SIM. Left at
its defaults the app forwards everything: bank OTPs, delivery alerts, private
messages — all POSTed to a server that has no use for any of it and should never
see it. Both filters below default to off or `any`, so both are easy to skip and
neither is optional.

**Sim Slot** confines the rule to the relay SIM. This is the stronger of the two
because it is structural: a message on the personal SIM is never even considered.

**The text filter** narrows what leaves the relay SIM to messages that are
plausibly ours. The prefilled body is always `Verify my number for VegDrop:
ABC123`, so `(?i)vegdrop` matches every genuine send and no bank message.

The cost of the text filter, stated plainly: a user who edits the message and
deletes the word before sending gets no verification and no error — the relay
drops it silently and they watch "waiting" until the code expires. Filtering on
the code pattern instead would catch that case, but
`[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}` also matches a plain six-digit bank OTP,
which is exactly the traffic this filter exists to keep on the phone. Losing an
edited message is the better failure.

## Server side

Both must be set or the channel stays off — `config/env.js` reports the SMS
channel as configured only when it has a number *and* a secret, and
`/api/auth/reverse/start` then answers without an SMS option rather than
offering a button that goes nowhere.

- `SMS_GATEWAY_INBOX_NUMBER` — the relay SIM's number, digits only with country
  code. This is what the deep link addresses.
- `SMS_GATEWAY_SECRET` — generate locally, e.g.
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Keeping it running

The failure mode is silence: the phone stops forwarding and nothing anywhere
reports it, because a message that never arrives looks identical to a user who
never sent one.

- **Exempt the app from battery optimisation.** A force-stopped Android app
  receives no broadcasts at all until someone opens it by hand, and Xiaomi, Oppo,
  Vivo and Realme builds force-stop background apps aggressively.
- **Allow autostart** where the OEM has that setting, so a reboot re-arms it.
- **Turn on the app's heartbeat** and point it at a dead-man's-switch monitor
  (healthchecks.io, Uptime Kuma). That converts silent death into an alert, and
  is the only thing here that actually tells you the relay is down.
- Keep the SIM in credit. Inbound SMS is free, but an unpaid SIM gets
  deactivated.

## What this channel is worth

Less than the WhatsApp one, by design and on purpose. The secret proves the
*relay* is ours; it proves nothing about the sender the relay names, and SMS
sender IDs are forgeable. `/start` reports `assurance: 'low'` for this channel
and the UI says so. See the header comment in `server/routes/smsGateway.js`.

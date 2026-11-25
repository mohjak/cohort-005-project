# Notification delivery channels beyond the in-app bell

Research for [#6](https://github.com/mohjak/cohort-005-project/issues/6) (map [#1](https://github.com/mohjak/cohort-005-project/issues/1)). Facts and trade-offs only; the choice is made in [#7](https://github.com/mohjak/cohort-005-project/issues/7).

Researched 2026-11-25. Prices change; re-check the linked pages before committing.

## Cadence context

- Server: React Router 8.3 (`@react-router/node`), SQLite via `better-sqlite3` + `drizzle-orm` 0.45 (`package.json`).
- No web app manifest and no service worker exist today (`public/` holds only `favicon.svg` and `images/`). Any Web Push option needs both added.
- The in-app bell stays the core channel either way (map #1). Anything below is an *extra* copy of a Notification sent outside Cadence.

## Summary table

| Option | Cost at small scale | Setup effort | Reach | Server fit |
| --- | --- | --- | --- | --- |
| Web Push, standard VAPID + `web-push` (no vendor) | $0 (browser push services are free to the sender) | Medium: manifest + service worker + subscribe UI + a `push_subscriptions` table + prune dead endpoints | Chrome, Edge, Firefox, Safari 16+ (macOS 13+), iOS/iPadOS 16.4+ **only when added to Home Screen** | Good: one MPL-2.0 npm package, Node >= 16, subscriptions live in our SQLite |
| Web Push via OneSignal | Free plan advertises 10,000 web push subscribers; Growth from $19/mo + $0.004 per web push subscriber | Low–medium: their script + `OneSignalSDKWorker.js` at our origin; dashboard config | Same browsers (it uses the same standards underneath); same iOS Home Screen rule | Subscriber list lives at OneSignal; server calls their REST API with an App API Key |
| Web Push via Firebase Cloud Messaging | $0 (FCM is a no-cost Firebase product) | Medium: Firebase project + JS SDK + `firebase-messaging-sw.js` at root + service account on server | Browsers that implement the Push API | `firebase-admin` 14.x requires Node >= 22; tokens/FIDs stored in our DB; adds a Google dependency |
| Email via Resend | Free: 3,000/mo, **100/day**, 3 domains. Pro: $20/mo for 50k | Low: API key + verify domain DNS | Every user with an email address | MIT `resend` SDK; simple `emails.send()` |
| Email via Postmark | Free: 100/mo (no overage). Basic: $15/mo for 10k, then $1.80/1k | Low: server token + sender signature/domain; manual account approval (<24h weekdays) | Every user with an email address | MIT `postmark` SDK; separate transactional/broadcast streams |
| Email via Amazon SES | $0.10/1k (à la carte) to $0.16/1k (Essentials); new AWS accounts get up to $200 free-tier credits | Highest: AWS account, IAM, domain verification, **sandbox exit request (up to 96h review)** | Every user with an email address | `@aws-sdk/client-sesv2`; bounce/complaint handling is on us |

## Web Push

### How the standard works (applies to all three options)

- The page registers a **service worker**, then calls `PushManager.subscribe()`; the resulting `PushSubscription` holds an **endpoint** plus encryption keys, which the app sends to its server. The service worker wakes on a `push` event and usually calls `showNotification()`. — [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- The endpoint is a capability URL (anyone with it can push), so store it as a secret and protect the subscribe endpoint against CSRF. — [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- Push API is marked **Baseline: Widely available** (across browsers since March 2023). — [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- `pushsubscriptionchange` fires when a subscription is invalidated or about to expire. — [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- When a subscription has expired, the push service "MUST" return **404 (Not Found)** (RFC 8030 §7.3). Servers should delete such rows. — [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html)
- Requires HTTPS (OneSignal and FCM docs both state this; MDN service workers are secure-context only). Does not work in private/incognito modes. — [OneSignal quickstart](https://documentation.onesignal.com/docs/web-push-quickstart), [FCM web client](https://firebase.google.com/docs/cloud-messaging/js/client)

### Apple / iOS Safari

- **macOS:** Web Push arrived in Safari 16 on macOS Ventura. "You don't need to join the Apple Developer Program to send Web Push notifications." — [WebKit: Meet Web Push](https://webkit.org/blog/12945/meet-web-push/)
- **iOS/iPadOS 16.4+:** "A web app that has been added to the Home Screen can request permission to receive push notifications." The site needs a web app manifest with `display` set to `standalone` or `fullscreen`, and the permission request must be "in response to direct user interaction." Uses the same Push API + Notifications API + Service Workers; no Apple Developer Program membership needed. — [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- Consequence for Cadence: an iPhone user browsing in a Safari tab **cannot** get push; they must first "Add to Home Screen". That is a UX step Cadence would need to explain. This applies equally to the vendor options — OneSignal's docs repeat the same iOS 16.4 + manifest + Home Screen requirement. — [OneSignal quickstart](https://documentation.onesignal.com/docs/web-push-quickstart)
- Modern Safari uses VAPID; OneSignal notes no certificate upload is needed for macOS 13+/iOS 16.4+. — [OneSignal quickstart](https://documentation.onesignal.com/docs/web-push-quickstart)

### Option A: standard VAPID + `web-push` npm library (no vendor)

- `web-push` sends Web Push Protocol messages and encrypts payloads. API: `generateVAPIDKeys()` (once, store them), `setVapidDetails(subject, publicKey, privateKey)` where subject is `https:` or `mailto:` (a localhost subject can be rejected by Apple with `403 BadJwtToken`), `sendNotification(subscription, payload, { TTL, urgency, topic, ... })`. — [web-push-libs/web-push](https://github.com/web-push-libs/web-push)
- Package facts (npm registry, checked 2026-11-25): v4.0.0, license **MPL-2.0**, `engines.node >= 16`, four small deps (`jws`, `asn1.js`, `http_ece`, `https-proxy-agent`).
- Cost: no vendor bill; the browser vendors' push services (Google, Mozilla, Apple) receive the request.
- What we build ourselves: manifest, service worker, subscribe/unsubscribe UI, a subscriptions table (endpoint, `p256dh`, `auth`, user id) in SQLite/Drizzle, deletion on 404/410, and any retry/queue. No delivery analytics dashboard.
- Server fit: plain Node call from a React Router action/loader or a background job; data stays in our DB.

### Option B: OneSignal

- Pricing: Free plan lists "10,000 free web push" / "Max 10,000 subscribers per send" and 10,000 email sends/month. Growth "starts at $19/mo", web push $0.004 per web push subscriber, email 20,000 free then $1.50/1,000. Professional/Enterprise custom. — [OneSignal pricing](https://onesignal.com/pricing)
- Setup: add their SDK `<script>` with app ID; host `OneSignalSDKWorker.js` on our own origin (cannot be on a CDN or redirected, must be `application/javascript`; can be one `importScripts` line). "Typical Site" lets prompts be configured in their dashboard; "Custom Code" for control. — [OneSignal web push quickstart](https://documentation.onesignal.com/docs/web-push-quickstart)
- Sending: `POST https://api.onesignal.com/notifications` with `Authorization: Key <App API Key>`, `app_id`, `target_channel: "push"`, targeting segments or users. — [OneSignal web push quickstart](https://documentation.onesignal.com/docs/web-push-quickstart)
- Trade-offs: least client code and a ready dashboard/prompt UI; also offers email in the same product. But subscriber data and targeting live in a third party, a third-party script runs on every page, and cost scales per subscriber on paid tiers.

### Option C: Firebase Cloud Messaging (FCM)

- Cost: FCM is listed among Firebase's no-cost products. — [Firebase pricing](https://firebase.google.com/pricing)
- Client: Firebase JS SDK, HTTPS only, works in browsers implementing the Push API. Needs `firebase-messaging-sw.js` at the domain root, a VAPID key pair generated/imported in the Firebase console, `Notification.requestPermission()`, then `register(messaging, { vapidKey })` returning a Firebase Installation ID (FID) to send to our server. `getToken` is deprecated. — [FCM JS client setup](https://firebase.google.com/docs/cloud-messaging/js/client)
- Server: `firebase-admin` with a service-account credential (`GOOGLE_APPLICATION_CREDENTIALS`); `getMessaging().send()`; multicast up to 500 FIDs/tokens per call. — [FCM send with Admin SDK](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk)
- Package facts (npm registry, 2026-11-25): `firebase-admin` 14.5.1 requires **Node >= 22**.
- Trade-offs: free and gives one API if native mobile apps came later (out of scope per map #1). For web-only, it wraps the same standard Web Push that Option A uses directly, while adding a Google Cloud project, a service-account secret, and a larger client SDK.

## Email

All three need a verified sending domain (SPF/DKIM DNS records) and give every user a channel with no browser/device restrictions.

### Resend

- Free: 3,000 emails/month, **100/day**, 3 domains. Pro: $20/mo for 50,000 or $35/mo for 100,000; $0.90 per 1,000 over; no daily limit; 10 domains. — [Resend pricing](https://resend.com/pricing)
- Node: `npm install resend`, `RESEND_API_KEY`, verify domain, `resend.emails.send({ from, to, subject, html | text | react })`, returns `{ data, error }`. Accepts a `react` element as the body. `onboarding@resend.dev` is test-only; test recipients like `delivered@resend.dev`/`bounced@resend.dev` simulate events. — [Resend Node.js guide](https://resend.com/docs/send-with-nodejs)
- `resend` npm: v6.39.0, MIT.

### Postmark

- Free: 100 emails/month, no overage, doesn't expire. Basic: $15/mo from 10,000 emails, then $1.80/1,000. — [Postmark pricing](https://postmarkapp.com/pricing)
- API: `X-Postmark-Server-Token` header per server; From must be a confirmed sender signature (else 422); default "outbound" transactional stream, separate broadcast stream for bulk; `POSTMARK_API_TEST` token for non-delivering tests. — [Postmark send with API](https://postmarkapp.com/developer/user-guide/send-email-with-api)
- New accounts are manually reviewed (< 24 hours on weekdays); before approval you can only send to your own verified domains. — [Postmark account approval](https://postmarkapp.com/support/article/1084-how-does-the-account-approval-process-work)
- `postmark` npm: v5.1.1, MIT.

### Amazon SES

- Price per 1,000 outbound emails (0–10M tier): $0.10 à la carte, $0.16 Essentials, $0.22 Pro (+$105/mo fixed), $0.23 Enterprise (+$500/mo). Attachments $0.12/GB. New AWS customers get up to $200 free-tier credits (6-month free plan). Dedicated IPs optional ($24.95/IP/mo). — [SES pricing](https://aws.amazon.com/ses/pricing/)
- New accounts start in a per-region **sandbox**: only verified recipients, max 200 messages/24h, 1 msg/s. Production access is a reviewed request (website URL, transactional vs marketing, confirm bounce/complaint handling); initial response within 96 hours. — [SES: request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- Node: `@aws-sdk/client-sesv2` (v3.1177.0 on npm). Requires AWS account + IAM credentials.
- Trade-offs: cheapest per email at volume, but most setup and operational work (sandbox, IAM, bounce/complaint processing via SNS or similar), and no free monthly allowance beyond credits.

## Rough cost at Cadence-like scale (illustrative)

Assume ~500 users and ~5,000 outside notifications/month.

- Web Push, `web-push`: $0.
- Web Push, FCM: $0.
- Web Push, OneSignal: inside the free plan's 10,000-subscriber web push allowance.
- Email, Resend: 5,000/mo exceeds the Free plan (3,000/mo, 100/day) → Pro $20/mo.
- Email, Postmark: exceeds Free (100/mo) → Basic $15/mo.
- Email, SES: ~$0.50–$0.80/mo at $0.10–$0.16/1k, after sandbox exit.

## Trade-offs to weigh in #7

- **Reach vs friction:** email reaches everyone with no install step; Web Push on iPhone requires Add to Home Screen first, and needs a manifest + service worker Cadence does not have yet.
- **Data ownership:** `web-push` and FCM keep subscriber rows in our SQLite; OneSignal keeps the audience on their side.
- **Moving parts:** `web-push` = one small npm package; FCM = Google project + service account + Node >= 22 for `firebase-admin`; OneSignal = third-party script on every page.
- **Approval lead time (email):** Resend — domain verify only; Postmark — manual approval < 24h; SES — sandbox exit up to ~96h.
- **Free-tier ceilings (email):** Resend's 100/day cap is the binding limit for bursts (e.g. one announcement to 150 Students); Postmark free is 100/month; SES has no monthly free allowance beyond new-account credits.
- **Opt-out:** any outside channel makes the "Muting / opt-out" open question on map #1 more pressing (per-channel preferences, unsubscribe links in email).

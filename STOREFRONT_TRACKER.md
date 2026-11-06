# Storefront build tracker (Stella + bramp.shop)

The checklist for building Storefront. Tick items as they land and add a line to the log at the bottom, so the next session can pick up from here.
Spec: *Bramp Storefront: Product and System Spec (v1)*, 6 Nov 2026.

**Ground rules**
- Stella (WhatsApp) and bramp.shop (web) are one product. **Stella is built first.**
- Stella runs on the existing Bramp WhatsApp number and Meta app (`AI/whatsapp.js`), using Claude.
- Customers do KYC once, through the existing Dojah handler (`routes/KYC.js` → `biometricVerification`). That KYC counts for Stella and bramp.shop, and for every desk.
- Code follows Bramp-server's existing style: mongoose, `node-cron`, flat folders. Ignore the spec's Postgres, BullMQ and SQL samples.
- In code a desk is a `StorefrontMerchant`, and its `@username` is the `slug`.
- A desk's NGNB float and coin balances are the trader's own Bramp balances (`services/portfolio.js`). The only new money record is reservations.
- `routes/nairawebhook.js`, `routes/obiexwebhooktrx.js` and `routes/chatbotwebhook.js` are live payment paths. Change them one at a time, and show the diff before deploying.

Legend: `[x]` done · `[~]` written, not switched on · `[ ]` to do

---

## Milestones

- [x] **M1. Storefront server code committed.** `3358259`, local, not pushed.
- [x] **M2. Stella webhook rework** (`AI/whatsapp.js`): Meta signature checked on every request, reply 200 first, body parsed from `req.rawBody`, duplicates checked in Mongo, one sender. Committed locally, **not deployed**. Tested locally: 11/11 checks (signature, ack first, duplicates, statuses, Flows ping).
- [ ] **M3. Mount in `server.js`:**
  - storefront routes and jobs
  - take `/whatsapp` off `webhookLimiter` (50 per 15 minutes per IP is too low for Meta)
- [ ] **M4. Customer identity:** a WhatsApp number is linked to a Bramp `User`, with a short sign-up in the chat. Customers are tagged `source: 'stella'` and left out of Bramp's own marketing.
- [ ] **M5. One-time KYC:** Stella sends a one-time link to bramp.shop `/verify` (ID number and a camera selfie), which runs `biometricVerification`.
- [ ] **M6. Desk routing:** `@username`, the sticky desk, confirm before switching, "this trade only".
- [ ] **M7. Claude agent, read-only tools:** desk info, rates, order status.
- [ ] **M8. Webhooks hand storefront events over**, one at a time:
  - Glyde payments (`nairawebhook.js`)
  - Obiex withdrawals (`obiexwebhooktrx.js`, `chatbotwebhook.js`)
- [ ] **M9. Buy on Stella, end to end:**
  - quote → PIN through a Flow → Glyde account → payment → crypto sent → webhook to the desk
- [ ] **M10. Rate cards and reservations.**
- [ ] **M11. Sell on Stella**, end to end.
- [ ] **M12. Desk takeover** (relayed through Stella).
- [ ] **M13. bramp.shop on the real API:**
  - desk linking
  - store pages and checkout
  - trader dashboard
- [ ] **M14. Bramp app link-approval screen and bramp-admin Storefront pages.**
- [ ] **M15. Floating switch** (top-ups and sweeps).
- [ ] **M16. Gift cards.**
- [ ] **M17. Automatic refunds.**
- [ ] **M18. More coins** (BTC, ETH, SOL, BNB).

---

## Files

### Bramp-server: models/
- [x] `storefrontMerchant.js`: the desk
  - [ ] add `suspended` status, store profile (brand, logo, bio, contacts, bank), opening hours, low-balance levels
- [x] `storefrontOrder.js`: buy orders
  - [ ] add `channel: web | whatsapp`, set at creation and never changed
- [x] `storefrontLedger.js`: held margin
- [x] `storefrontLinkRequest.js`: desk linking
- [ ] `storefrontRateCard.js`
- [ ] `storefrontReservation.js`
- [ ] `storefrontSellOrder.js`
- [ ] `storefrontGiftcardOrder.js`
- [ ] `storefrontSwitch.js`
- [ ] `stellaCustomer.js`: WhatsApp ID ↔ `User`, the sticky desk, switch history
- [ ] `stellaConversation.js`: 24-hour window, takeover, order in progress
- [x] `stellaMessage.js`: messages in and out, duplicate check, delivery status

### Bramp-server: services/
- [x] `storefrontBuy.js`
  - [ ] quote from the rate card, reserve on confirm, set the channel
- [x] `storefrontLedger.js`, `storefrontNotify.js`, `storefrontOnboarding.js`
- [x] `storefrontJobs.js`
  - [ ] add sell expiry, top-ups and sweeps, stale-rate and low-balance pause
- [x] `ObiexWithdraw.js`: `withdrawStablecoin` (USDT and USDC)
- [ ] `storefrontRates.js`
- [ ] `storefrontReservations.js`
- [ ] `storefrontSell.js`
- [ ] `storefrontGiftcard.js`
- [ ] `storefrontSwitch.js`
- [ ] `storefrontRefund.js`

### Bramp-server: AI/ (Stella)
- [x] `whatsapp.js`: the webhook (setup check, Flows encryption, messages)
  - [ ] replace the placeholder Flow handlers (`/signin/signin-pin` accepts any PIN, so it must not be wired to anything)
- [x] `stellaSender.js`: the only file that calls Meta's send API
- [ ] `stellaRouter.js`
- [ ] `stellaAgent.js`
- [ ] `stellaTakeover.js`

### Bramp-server: routes/, adminRoutes/, auth/, server.js
- [x] `routes/storefront.js`, `storefrontLink.js`, `storefrontOnboarding.js`
  - [ ] store profile read and update
- [ ] `routes/storefrontRates.js`, `storefrontSell.js`, `storefrontGiftcard.js`, `storefrontSwitch.js`
- [ ] `routes/stellaVerify.js`: one-time KYC link token → `biometricVerification`
- [ ] `routes/nairawebhook.js`: pass Glyde payments to storefront buys
- [ ] `routes/obiexwebhooktrx.js`, `routes/chatbotwebhook.js`: pass withdrawals and sell deposits to storefront
- [x] `adminRoutes/storefront.js`
  - [ ] add sells, gift cards, refunds, rate cards, Stella conversations
- [x] `auth/storefrontAuth.js`, `auth/storefrontPlatformAuth.js`
- [ ] `server.js`: mount storefront routes and jobs, take `/whatsapp` off `webhookLimiter`

### Chatbramp-app (the Bramp app)
- [ ] `app/storefront-link.tsx`, `services/storefrontLinkService.js`, `hooks/useStorefrontLink.js`
- [ ] notification tap handler: open the screen for `STOREFRONT_LINK` pushes

### bramp-admin
- [ ] `src/features/storefront/{pages,services,types}`, plus the router and sidebar entry

### bramp-storefront (bramp.shop)
- [x] landing page, sample store, setup form (mock data)
- [ ] `src/app/verify/*`: customer KYC page (camera selfie)
- [ ] `src/lib/bramp.ts`: server-only API client
- [ ] `src/lib/stores.ts`: load stores from the API
- [ ] `src/app/api/link/*`, `api/orders/*`, `api/webhooks/bramp`
- [ ] `src/app/Onboarding.tsx`, `[slug]/CheckoutSheet.tsx`, `[slug]/StoreView.tsx`: real data, Stella link
- [ ] `src/app/dashboard/*`, `src/lib/session.ts`: trader dashboard

---

## Open decisions
- In-chat sign-up: WhatsApp number plus email with a code (recommended), or number only.
- Trader dashboard login on bramp.shop.
- Static or one-time Glyde account for buys. The code uses a one-time account per order.
- Fee per trade and per gift card; security deposit per desk tier; gift card verification provider.
- Stella display name "Stella by Bramp" (Meta review). The Meta app is still in Development mode.

## Known issues found
- Before M2, `/whatsapp` ignored every message. `server.js` reads the raw body first, so `req.body` was empty. M2 parses `req.rawBody`.
- `webhookLimiter` (50 per 15 minutes per IP) also covers `/whatsapp`. Fix in M3.
- Webhook URL to set in Meta: `https://<server>/whatsapp/whatsapp`. It's mounted at `/whatsapp`, and the router path is also `/whatsapp`.
- Local `.env` has no Obiex settings, so `services/networkService.js` (and the storefront and Metusela code) can't load on this PC without a placeholder `OBIEX` base URL.

## Log
- **2026-11-06:** M1 committed (`3358259`, local). Tracker created.
- **2026-11-06:** M2 committed locally. `AI/whatsapp.js` now refuses requests without a valid Meta signature, including Flows; check `META_APP_SECRET` is set on the server before deploying. The OpenAI import is removed (it was never used). The welcome message is unchanged until M4.

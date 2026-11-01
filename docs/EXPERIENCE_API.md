# MediLink Experience API (`/me/*`)

The experience layer is everything a beginner-friendly UI needs. A UI built on it has almost no logic of its own:
it shows what the backend says, renders the buttons it is given, and posts them back. Every screen answers two
questions: **what is happening** and **what do I do next**.

> All data in this prototype is synthetic. Examples below are real responses from the development stack
> (`npm run dev`), shortened where marked `…`.

---

## 1. Basics

| | |
|---|---|
| Base URL | development `http://localhost:4004` · production: your HTTPS address ([HOSTING.md](HOSTING.md)) |
| Sign-in | MediLink accounts only: `POST /auth/login {"username","password"}` → `{ token, tokenType: "Bearer", expiresAt, user: { username, role, hospital } }` (pharmacists, approvers and admins only; every refusal is the same `LOGIN_FAILED`); send `Authorization: Bearer <token>`; `POST /auth/logout` ends it; `GET /auth/me`. Development demo users: `asha`, `ravi`, `meera`, `kiran`, `admin`, …, password `demo`. Scripts may send HTTP Basic instead. A 401 `SESSION_EXPIRED` means: show the sign-in screen again. A 429 `RATE_LIMITED` (or `TOO_MANY_LOGIN_ATTEMPTS`) carries `Retry-After` in seconds. |
| Format | JSON in, JSON out. Dates `YYYY-MM-DD`, timestamps ISO-8601 UTC. Every text meant for people is already written for them (times shown in India time, e.g. `2:15 pm`). |
| Language | `Accept-Language` picks the text bundle. Today only English exists; other languages fall back to English (see §11). |
| Roles | `pharmacist`, `approver`, `admin` (plus the API-only `system` user for SAP Build Process Automation). A user acts for one hospital (`hospital` attribute). Everything is filtered to that. **Couriers have no account**: they use a per-delivery courier link (§14). |

### Endpoints

| Method + path | What it returns | Who |
|---|---|---|
| `GET /me/home` | The home screen: hospital status, onboarding, alerts, task cards, journeys, cover and stock summary | everyone |
| `GET /me/onboarding` | The onboarding checklist with the single next action | pharmacist (others get `{ done: true }`) |
| `GET /me/journeys/{id}` | One journey (by request ID or transfer ID) | the parties of that journey |
| `GET /me/journeys/{id}/tracking` | Live delivery tracking: steps, map route, rider position, ETA, temperature (§14) | receiving hospital + admin (full), supplying hospital (summary) |
| `GET /me/city` | Aggregated, anonymised city view (no hospital names) | everyone |
| `POST /me/actions/{actionId}` | Runs a button. Body = the action's `body` + the user's `fields` | see §5 |
| `POST /auth/ws-ticket` | `{ ticket, expiresIn: 30 }`: single-use ticket for the WebSocket (§9) | everyone signed in |
| `WS /ws/tracking?ticket=…` | Live updates for the user's own deliveries, including `tracking` and `journey.updated` (§9) | everyone |
| `GET/POST /courier/*` | The courier's page: job, pickup scan, GPS / temperature, road closed (§14). `Authorization: Courier <token>`, no sign-in | holder of the delivery's courier link |
| `GET /me/stock` | Stock levels, reorder levels, expiring and expired lots (§13) | pharmacist, approver; admin with `?hospital=` |
| `GET /me/notifications` | The alert inbox, `?status=open\|all` (§13) | pharmacist, approver (own hospital), admin (all) |
| `GET /health/integrations` · `GET /admin/metrics` · `GET /admin/overview` · `GET /admin/courier-links` | Which integrations are on / on fallback (§12); PRD success metrics; dashboard numbers; live courier links (§14) | admin |

---

## 2. `GET /me/home`

```jsonc
{
  "user": { "id": "asha", "role": "pharmacist" },
  "greeting": "Your pharmacy today",
  "hospital": {
    "id": "H1", "name": "City Cancer Hospital, Jayanagar",
    "licence": { "status": "valid", "validTill": "2028-03-31", "text": "Licence valid till 31 Mar 2028" },
    "connection": { "status": "connected", "connected": true, "lastSyncedAt": "2026-11-01T08:45:07.450Z", "text": "Connected · synced just now" }
  },
  "onboarding": null,                       // or { current, step, message, nextAction } while setting up
  "alerts": [
    { "kind": "SHORTFALL", "severity": "red", "drugId": "D-CARB450", "message": "Carboplatin 450 mg: 16 of 40 doses short by 10 Nov" },
    { "kind": "BELOW_MARGIN", "severity": "amber", "drugId": "D-CISP50", "message": "Cisplatin 50 mg is covered, but below your safety margin." }
  ],
  "tasks": [
    {
      "id": "shortfall:D-CARB450:send_request", "kind": "send_request", "journeyId": "shortfall:D-CARB450",
      "title": "Request 16 doses of Carboplatin 450 mg",
      "subtitle": "Needed by 10 Nov. 9 booked patients are affected first.",
      "urgency": "medium", "dueBy": "2026-11-10", "colour": "red",
      "primaryAction": {
        "id": "send-request", "label": "Request 16 doses", "style": "primary", "method": "POST", "path": "/me/actions/send-request",
        "body": { "drugId": "D-CARB450", "qty": 16, "neededBy": "2026-11-10" },
        "fields": [
          { "name": "allowBrandSwitch", "label": "Accept another brand of the same medicine?", "type": "boolean", "required": true, "default": false },
          { "name": "note", "label": "Note for the supplier (optional)", "type": "text", "required": false }
        ],
        "confirm": "Request 16 doses of Carboplatin 450 mg by 10 Nov?"
      },
      "secondaryAction": null
    }
  ],
  "journeys": [ /* §3, newest first */ ],
  "coverSummary": { "red": 1, "amber": 1, "green": 5, "windowDays": 14, "drugs": [{ "id": "D-CARB450", "name": "Carboplatin 450 mg", "status": "short", "booked": 16, "covered": 10, "shortfall": 6, "stock": 10, "firstAffectedDate": "2026-11-09" }], "text": "1 short, 1 low, 5 covered", "emptyText": null },
  "empty": {}                               // friendly text for every list that is empty, e.g. { "tasks": "Nothing needs you right now." }
}
```

| Field | Meaning |
|---|---|
| `hospital.connection.status` | `connected` · `stale` (no update for over an hour; stock greyed out) · `never` (waiting for first sync) · `disconnected` (then `connection.action` is the button to connect) |
| `hospital.licence.status` | `valid` · `expiring` (within 30 days) · `expired` |
| `alerts[]` | Already sorted: red first; within a colour, what can hurt a patient today first. `kind`: `EXCURSION`, `RECALL`, `SHORTFALL`, `LICENCE_EXPIRY`, `STALE_FEED`, `BELOW_MARGIN`, then the stock kinds `EXPIRED`, `OUT_OF_STOCK`, `EXPIRING`, `LOW_STOCK` (§13, with `notificationId` + an `ack-alert` button). Show `message` as is. |
| `stockSummary` | Counts of out-of-stock, low, expiring and expired (§13); `null` for users without a hospital |
| `tasks[]` | Things this user must act on now, sorted by `urgency` (`high` · `medium` · `low`) then `dueBy`. Exactly one `primaryAction`, optional `secondaryAction`. |
| `coverSummary` | Counts of red (short), amber (covered but below the safety margin) and green drugs; `drugs` lists each critical drug (worst first) with `status` short · low · covered · none, booked / covered / shortfall doses and usable stock. `emptyText` when nothing is short. |

### What each role sees

| Role | `hospital` | Typical tasks | Journeys |
|---|---|---|---|
| pharmacist (requesting) | own hospital | `send_request`, `choose_plan`, `find_again`, `arrival`, `repay`, `connect` | own requests (receiver view) + stage-1 shortfalls |
| pharmacist (supplying) | own hospital | `accept_request` | requests sent to the hospital (supplier view) |
| approver | own hospital | `approve` (hidden once this person has signed) | the hospital's journeys, read-only |
| admin | `null` | none | every active journey (receiver wording, prefixed with the hospital) |

Examples from the demo:

```jsonc
// ravi (supplying pharmacist, Banashankari) — tasks[0]
{
  "kind": "accept_request", "title": "Accept or decline a request",
  "subtitle": "City Cancer Hospital needs 16 vials of Carboplatin 450 mg. You'll still cover your own patients.",
  "urgency": "high", "dueBy": "2026-11-01T09:15:08.168Z",
  "primaryAction": {
    "id": "accept-request", "label": "Accept", "path": "/me/actions/accept-request", "body": { "transferId": "25e5db67-…" },
    "fields": [
      { "name": "quantity", "label": "How many vials can you give?", "type": "number", "required": true, "default": 16, "min": 1, "max": 16 },
      { "name": "repaymentMode", "label": "How should you be repaid?", "type": "choice", "required": true, "default": "IN_KIND",
        "options": [ { "value": "IN_KIND", "label": "Get the same medicine back later" }, { "value": "LANDED_COST", "label": "Get paid the landed cost (₹29,600)" } ] }
    ],
    "confirm": "Give 16 vials to City Cancer Hospital?"
  },
  "secondaryAction": { "id": "decline-request", "label": "Decline", "fields": [ { "name": "reasonCode", "type": "choice", "options": [ … ] }, { "name": "note", "required": false, … } ], … }
}
// meera (approver) — tasks[0]
{ "kind": "approve", "title": "Approve transfer of 16 vials", "subtitle": "Carboplatin 450 mg to City Cancer Hospital. Check: near-expiry stock.",
  "primaryAction": { "id": "approve-transfer", "label": "Approve", "fields": [], "confirm": "Approve 16 vials of Carboplatin 450 mg to City Cancer Hospital?", … },
  "secondaryAction": { "id": "reject-transfer", "label": "Reject", "fields": [ { "name": "reason", "label": "Why are you rejecting it?", "type": "text", "required": true } ], … } }
// couriers have no account and no home screen: the supplier shares the delivery's courier link (§14)
```

---

## 3. Journeys

One journey per medicine request, the same object for every party, worded for whoever is looking (`perspective`:
`receiver`, `supplier`, `admin`). It is **derived** from the request, transfer, approval, delivery, receipt
and ledger records on every read, so it can never disagree with them.

```jsonc
{
  "id": "ea6daac3-…",            // request ID ("shortfall:<drugId>" for stage 1, before a request exists)
  "requestId": "ea6daac3-…", "transferId": "25e5db67-…", "perspective": "receiver",
  "drug": { "id": "D-CARB450", "name": "Carboplatin 450 mg" }, "qty": 16, "neededBy": "2026-11-10",
  "stage": 5, "of": 7, "stageLabel": "On the way", "key": "on_the_way", "colour": "green",
  "headline": "On the way, arriving ~2:42 pm, 5.4 °C",
  "counterpart": "Banashankari Care Hospital", "from": "Banashankari Care Hospital", "to": "City Cancer Hospital",
  "respondBy": null, "risks": ["NEAR_EXPIRY"], "eta": "2026-11-01T09:12:…Z", "temperatureC": 5.4,
  "note": "Carboplatin 450 mg/45 mL injection: 16 vials (batch SOL24B077 x 12, SOL25A015 x 4). Keep between 2 and 30 °C, …",
  "loan": { "id": "…", "status": "OPEN", "qty": 16, "amount": 29600, "mode": "IN_KIND", "lender": "H5", "borrower": "H1" },
  "timeline": [
    { "at": "2026-11-01T08:45:07.703Z", "time": "2:15 pm", "kind": "requested", "text": "You asked for 16 doses of Carboplatin 450 mg" },
    { "at": "…", "time": "2:15 pm", "kind": "asked", "text": "Asked Banashankari Care Hospital" },
    { "at": "…", "time": "2:15 pm", "kind": "accepted", "text": "Banashankari Care Hospital said yes (repay in kind)" },
    { "at": "…", "time": "2:15 pm", "kind": "signed", "text": "Signed off by an approver (1 of 2)" },
    { "at": "…", "time": "2:15 pm", "kind": "signed", "text": "Signed off by an approver (2 of 2)" },
    { "at": "…", "time": "2:15 pm", "kind": "partner", "text": "Courier CoolRoute Logistics (synthetic) assigned" },
    { "at": "…", "time": "2:15 pm", "kind": "picked_up", "text": "Picked up by CoolRoute Logistics (synthetic)" }
  ],
  "updatedAt": "…",
  "actions": [ { "id": "report-road-closed", "label": "Road closed", "style": "secondary", … } ]
}
```

Render it as: a progress bar `stage / of` with `stageLabel`, a coloured dot (`colour`), the `headline` in large
text, the `timeline` underneath, and one button per `actions[]` entry. When a `journey.updated` event arrives
(§9), replace the card with the same `id`.

### The seven stages

| # | `stageLabel` | Requesting hospital sees | Supplying hospital sees |
|---|---|---|---|
| 1 | Shortfall found | You're short 16 doses of Carboplatin 450 mg by 10 Nov | – |
| 2 | Request sent | Finding the nearest safe supplier… · Found a safe supplier: Banashankari Care Hospital. Tap to ask them. | – |
| 3 | Waiting for supplier | Asked Banashankari Care Hospital | City Cancer Hospital needs 16 vials. You'll still cover your own patients. |
| 4 | Waiting for approval | Supplier said yes, waiting for sign-off | Waiting for sign-off |
| 5 | On the way | Approved. CoolRoute Logistics will pick it up soon · On the way, arriving ~2:42 pm, 5.4 °C | Approved. CoolRoute Logistics is coming to pick up 16 vials · Picked up |
| 6 | Arrived | Arrived. Check and accept | Delivered |
| 7 | Done | 40 of 40 doses covered | Loan of 16 vials open: repay in kind or at cost |

The courier sees only its own delivery on the courier page (§14).

### Every `key`, including the side paths

`key` tells the UI exactly which situation it is in (for icons or analytics); the `headline` already says it in words.

| `key` | Stage | Colour | Requesting hospital (`receiver`) headline | Notes |
|---|---|---|---|---|
| `shortfall` | 1 | red | You're short {qty} doses of {drug} by {date} | before any request exists |
| `finding` | 2 | amber | Finding the nearest safe supplier… | request being ranked |
| `choose_supplier` | 2 | amber | Found a safe supplier: {hospital}. Tap to ask them. | task `choose_plan` |
| `no_match` | 2 | red | No safe supplier can help right now | task `find_again` |
| `recalled` | 2 | red | This batch was recalled. Transfer cancelled | the courier link is revoked; task `find_again` |
| `cancelled` | ≤4 | grey | You cancelled this request | supplier: "{hospital} no longer needs it" |
| `waiting_supplier` | 3 | amber | Asked {hospital} | supplier: "… You'll still cover your own patients." (or "Giving all of them would leave your own patients short.") |
| `waiting_supplier_fallback` | 3 | amber | {hospital} said no. Asking the next nearest hospital: {next} | also "… didn't answer in time." / "Sign-off refused at {hospital} ({reason})." |
| `declined` · `timed_out` · `rejected` | 3–4 | grey | – | supplier's own view: "You said no" · "No answer in time, so another hospital was asked" · "Sign-off refused: {reason}" |
| `waiting_approval` · `waiting_second_approval` | 4 | amber | Supplier said yes, waiting for (a second) sign-off | approver task `approve` |
| `finding_partner` | 4 | amber | Approved. Finding a licensed courier | no certified courier free yet |
| `waiting_pickup` | 5 | green | Approved. {courier} will pick it up soon | courier link sent; supplier and admin get `courier-link` / `reissue-courier-link` |
| `on_the_way` | 5 | green | On the way, arriving ~{time}, {temp} | |
| `rerouted` | 5 | amber | Re-routed around {closure}, new ETA {time} | after "Road closed" or heavy rain |
| `road_blocked` | 5–6 | red | Road closed. The courier will wait at a safe place | no open road |
| `excursion` | 5–6 | red | Temperature went out of range. Don't use until checked | supplier: "Temperature went out of range on the way"; at stage 6 the primary button becomes **Set aside (quarantine)** |
| `arrived` | 6 | amber | Arrived. Check and accept | task `arrival` |
| `done` | 7 | green | {covered} of {booked} doses covered | supplier: loan open / repaid; task `repay` for the borrower |
| `quarantined` | 7 | red | Set aside (quarantined). Don't use until checked | |

Colours: **green** all good · **amber** waiting on someone · **red** a problem or something to act on now · **grey** finished without delivery.

---

## 4. Task cards

| `kind` | Who | When | Primary → secondary button | Urgency |
|---|---|---|---|---|
| `connect` | pharmacist | onboarding not finished | the checklist's next action → first fallback | medium |
| `send_request` | pharmacist | a drug is red and nothing is requested yet | `send-request` | high if needed within 3 days, else medium |
| `choose_plan` | pharmacist | safe suppliers found | `choose-plan` → `cancel-request` | high |
| `find_again` | pharmacist | no supplier / batch recalled | `find-supplier-again` → `cancel-request` | medium |
| `accept_request` | supplying pharmacist | a hospital asked you (30 minutes to answer, `dueBy`) | `accept-request` → `decline-request` | high |
| `approve` | approver of the supplying hospital | waiting for (second) sign-off and you have not signed yet | `approve-transfer` → `reject-transfer` | high |
| `arrival` | receiving pharmacist | the delivery is at your door (GPS within 500 m, or ETA passed) | `accept-delivery` → `quarantine-delivery` (only `quarantine-delivery` after an excursion) | high |
| `repay` | borrowing pharmacist | a loan is open after delivery | `mark-loan-paid` → `repay-in-kind` (if a return delivery exists) | low |

---

## 5. Actions (buttons as data)

```jsonc
{ "id": "accept-request", "label": "Accept", "style": "primary",          // primary | secondary
  "method": "POST", "path": "/me/actions/accept-request",
  "body": { "transferId": "25e5db67-…" },                                  // send back unchanged
  "fields": [ { "name": "quantity", "label": "How many vials can you give?", "type": "number", "default": 16, "min": 1, "max": 16, "required": true } ],
  "confirm": "Give 16 vials to City Cancer Hospital?" }                   // ask before posting, if present
```

**How to render:** show `label` on a button. If there are `fields`, open a small form with each field prefilled with
`default`; if there are none, post straight away (after `confirm`, if present). Some actions also carry
`available: false` + `unavailableReason` (e.g. photo upload while the AI service is off): show the button disabled
with the reason.

**How to submit:** `POST path` with JSON `{ ...body, ...fieldValues }` and a fresh `Idempotency-Key` header per tap. At most 60 actions a minute per user (`429 RATE_LIMITED`, `Retry-After`).

| Field `type` | Render as | Value |
|---|---|---|
| `text` | text box (`placeholder` if given) | string |
| `number` | number input with `min` / `max` | number |
| `boolean` | yes / no switch | `true` / `false` |
| `choice` | radio list / dropdown of `options[]` (`{ value, label }`, plan options also have `reason`) | `value` |
| `date` | date picker | `YYYY-MM-DD` |
| `barcode` | camera scanner button with manual entry (`hint` = what is expected) | string (several batches: comma separated) |
| `file` | file / camera picker (`accept`) | CSV text for `csv`; base64 image for `imageBase64` |

### Idempotency (double taps)

Send `Idempotency-Key: <random string>` with every `POST`. The same key from the same user for the same action
runs **once**: a repeat returns the stored response with header `Idempotent-Replay: true`; a repeat while the first
tap is still running gets `409 ACTION_IN_PROGRESS` (retryable). Without a key, natural guards still apply: one live
request per medicine, a transfer can be accepted once, an approver can sign once.

### Response

```jsonc
{
  "ok": true, "action": "send-request",
  "message": "Request sent. We found 3 safe supplier options.",        // show as a toast
  "journey": { /* the updated journey: replace the card */ },
  "onboarding": { /* the updated checklist, for onboarding actions */ },
  "next": { "type": "open", "url": "https://…/oauth/authorize?…", "label": "Allow MediLink to read stock and chemo bookings" },
  "result": { /* action-specific data, e.g. photo preview rows */ }
}
```

`next.type`: `open` (open `url` in a popup, e.g. the hospital software's sign-in) · `show` (display `pairingCode` and
`setupLink` for the IT team) · `action` (render `next.action` as the follow-up button, e.g. "Save these rows").

### All actions

| `id` | Roles | `body` (from the backend) | `fields` (user decides) | Runs |
|---|---|---|---|---|
| `enter-licence` | pharmacist, admin | – | `licenceNo` | `OnboardingService.licence` |
| `allow-access` | pharmacist | – | – | `OnboardingService.licence` → `next.open` sign-in |
| `pick-software` | pharmacist | – | `software` (MEDISOFT, SAP_SANDBOX, CONNECTOR, SHEET, IT), `itContact`? | `OnboardingService.licence` |
| `ask-it-team` | pharmacist | – | `itContact` | `OnboardingService.licence` (connector + pairing code) |
| `upload-sheet` | pharmacist | (`mapping`, `confirm` on the follow-up) | `csv` | `SyncService.uploadSheet` |
| `upload-photo` | pharmacist | – | `imageBase64`, `mimeType`? | `SyncService.uploadPhoto` (preview only, saves nothing) |
| `confirm-photo` | pharmacist | `previewId` | – | `SyncService.uploadPhoto(confirm)` → normal stock ingest |
| `disconnect` | pharmacist | – | – | `OnboardingService.revokeAccess` |
| `send-request` | pharmacist | `drugId`, `qty`, `neededBy` | `allowBrandSwitch`, `note`? | `RequestService.createRequest` (ranks at once) |
| `choose-plan` | pharmacist | `requestId`, `plan: 1` | `plan` (only when there is more than one option) | `RequestService.choosePlan` |
| `find-supplier-again` | pharmacist | `requestId` | – | `RequestService.rank` (skips hospitals that already said no) |
| `cancel-request` | pharmacist | `requestId` | – | `RequestService.cancelRequest` |
| `accept-request` | pharmacist (supplier) | `transferId` | `quantity`, `repaymentMode` | `SupplierService.accept` |
| `decline-request` | pharmacist (supplier) | `transferId` | `reasonCode`, `note`? | `SupplierService.decline` → next supplier |
| `approve-transfer` | approver, admin | `transferId` | – | `ApprovalService.approveTransfer` (writes the transfer note, assigns a courier) |
| `reject-transfer` | approver, admin | `transferId` | `reason` | `ApprovalService.rejectTransfer` → next supplier |
| `courier-link` | pharmacist / approver of the **supplying** hospital, admin | `transferId` | – | returns `result: { url, expiresAt }` for copy / QR (§14); never stored as an idempotent replay |
| `reissue-courier-link` | pharmacist / approver of the supplying hospital, admin | `transferId` | – (`confirm`) | revokes the old link, mints and emails a new one; `result: { url, expiresAt }` |
| `report-road-closed` | pharmacist, admin | `transferId` | `note`? | `RouteService.setRouteClosed` → re-route (the courier uses `POST /courier/road-closed`) |
| `accept-delivery` | pharmacist, admin | `transferId` | `batchNo`, `sealIntact`, `qtyReceived` | `ReceiptService.arrivalScan(ACCEPT)` |
| `quarantine-delivery` | pharmacist, admin | `transferId` | `batchNo`, `sealIntact`, `qtyReceived` | `ReceiptService.arrivalScan(QUARANTINE)` |
| `mark-loan-paid` | pharmacist, admin | `loanId` | `reference` | `LedgerService.settleLoan(LANDED_COST)` |
| `repay-in-kind` | pharmacist, admin | `loanId` | `settlementTransfer` | `LedgerService.settleLoan(IN_KIND)` |
| `ack-alert` | pharmacist, approver, admin | `notificationId` | – | Hides a stock alert from home; it stays in the inbox (§13) |
| `set-reorder-level` | pharmacist, approver, admin | `drugId` (+ `hospital` for admin) | `minUnits` | Saves the hospital's reorder level and re-checks at once (§13) |
| `set-alert-email` | pharmacist, approver, admin (own account) | – | `email` (empty = stop) | Where this person's hospital alerts are emailed (§13) |

Every action runs the existing CAP service as the signed-in user, so all hard rules, ownership checks and the audit
log apply exactly as before. `?` = optional.

---

## 6. Errors

Every error from `/me/*` has the same five fields. Show `title` as a heading, `message` under it, `fix` as the
hint, and a **Try again** button only when `retryable` is true.

```json
{ "code": "LICENCE_EXPIRED", "title": "Your licence has expired",
  "message": "Your drug licence KA-BLR-20B-1004 expired on 31 Aug 2026.",
  "fix": "Renew it with the Karnataka Drugs Control Department, then try again.", "retryable": false }
```

HTTP status follows the error (`400` input, `401` not signed in, `403` not allowed, `404` not found, `409` state
changed / rule failed, `422` unreadable upload, `5xx` server or partner system). `INVALID_INPUT` messages name the
field label, e.g. `Please fill in "Drug licence number".`. No message ever contains a stack trace, an internal ID or
a rule number; `code` stays for logs and tests.

### Message catalogue (errors)

<!-- generated from backend/_i18n/messages.properties -->
| Code | Title | Fix | Retry? |
|---|---|---|---|
| `LICENCE_REQUIRED` | Enter your licence number | Type the number exactly as printed, for example KA-BLR-20B-1001. | no |
| `LICENCE_UNKNOWN` | We could not find this licence | Check the number on your displayed licence. If it is correct, contact MediLink support. | no |
| `LICENCE_EXPIRED` | Your licence has expired | Renew it with the Karnataka Drugs Control Department, then try again. | no |
| `FORBIDDEN_HOSPITAL` | This belongs to another hospital | Sign in with your own hospital account, or ask your admin to fix your account. | no |
| `NO_HOSPITAL` | Your account has no hospital | Ask your MediLink admin to link your account to your hospital. | no |
| `MEDISOFT_TOKEN_FAILED` | Your hospital software did not answer | Tap Allow again. If it keeps failing, ask your IT team to check the software is online. | yes |
| `PAIRING_CODE_REQUIRED` | Pairing code missing | Ask the pharmacist for the code shown after entering the licence number. | no |
| `PAIRING_CODE_INVALID` | Pairing code not valid | Enter your licence number again in MediLink to get a fresh code. | no |
| `PAIR_FAILED` | Pairing did not finish | Wait a minute and try again. | yes |
| `CONNECTOR_TOKEN_REQUIRED` | Connector not paired | Pair it once with the code from onboarding. | no |
| `CONNECTOR_TOKEN_INVALID` | Connector access was removed | Enter your licence number again to get a new pairing code for your IT team. | no |
| `SHEET_COLUMNS_UNMAPPED` | We could not read some columns | Add those columns, or ask your admin to confirm which column is which. | no |
| `PATIENT_REF_NOT_HASHED` | Patient details were not protected | Your IT team must send only the protected (hashed) patient reference. | no |
| `HOSPITAL_UNKNOWN` | Hospital not found | Contact MediLink support. | no |
| `INGEST_FAILED` | Stock update failed | It will retry automatically. If it keeps failing, contact your IT team. | yes |
| `STALE_FEED` | Stock is out of date | Its stock is set aside until the feed comes back. Ask its IT team to check the connection. | no |
| `LLM_DISABLED` | Reading documents is switched off | Upload your stock sheet instead, or ask your admin to switch the AI service on. | no |
| `LLM_UNPARSEABLE` | We could not read that | Take a clearer, well-lit photo of one register page, or upload a sheet. | yes |
| `PHOTO_NOTHING_READABLE` | No stock rows found | Take a clearer photo where every batch number is visible, or upload a sheet. | no |
| `PREVIEW_NOT_FOUND` | This preview has expired | Upload the photo again. | no |
| `IMAGE_REQUIRED` | Add a photo | Take a photo of the stock register page and try again. | no |
| `PDF_PARSER_MISSING` | Cannot read PDF files here | Paste the alert text instead. | no |
| `EMPTY_ALERT` | The alert is empty | Check the file and try again. | no |
| `FLAG_TARGET_REQUIRED` | Say what to flag | Enter the batch number from the alert. | no |
| `INVALID_REASON` | Choose a reason | Pick one of the three reasons. | no |
| `FLAGS_NOT_DELETABLE` | Alerts cannot be deleted | Switch the alert off instead. | no |
| `UNKNOWN_DRUG` | Medicine not found | Open the medicine from your cover board and try again. | no |
| `UNKNOWN_DRUG_OR_HOSPITAL` | Medicine not found | Open the medicine from your cover board and try again. | no |
| `NO_SHORTFALL` | Nothing to request | No action needed. We will alert you if that changes. | no |
| `INVALID_NEEDED_BY` | Pick a later date | Choose today or a later date. | no |
| `REQUEST_NOT_FOUND` | Request not found | Go back to your home screen and open it again. | no |
| `REQUEST_IN_FLIGHT` | Already on the way | Wait for the delivery and check it on arrival. | no |
| `PLAN_ALREADY_CHOSEN` | Supplier already asked | No action needed. Follow it on your home screen. | no |
| `PLAN_NOT_FOUND` | That option is gone | Tap "Find a supplier again" to get fresh options. | no |
| `MATCHER_UNAVAILABLE` | Ranking is busy | Try again in a minute. | yes |
| `NO_GENUINE_SURPLUS` | That would leave your patients short | Lower the quantity, or decline the request. | no |
| `FLAGGED_BATCH` | This batch is on a drug alert | Keep it aside. MediLink will look for safe stock elsewhere. | no |
| `FLAGGED_MANUFACTURER` | This maker is on a drug alert | Keep it aside. MediLink will look for safe stock elsewhere. | no |
| `NOT_SEALED` | The pack is opened | Use opened packs in your own pharmacy. | no |
| `EXPIRES_TOO_SOON` | Expires too soon | MediLink will offer stock with a later expiry date. | no |
| `STORAGE_MISMATCH` | Storage does not match | Correct the storage in your pharmacy system. | no |
| `NO_COLD_CHAIN_PARTNER` | No cold-chain courier | Try again later, or contact MediLink support. | no |
| `SUPPLIER_LICENCE_INVALID` | Supplier licence not valid | MediLink will ask a licensed hospital instead. | no |
| `RECEIVER_LICENCE_INVALID` | Your licence is not valid | Renew it with the Karnataka Drugs Control Department. | no |
| `NO_LICENSED_PARTNER` | No licensed courier | Try again later, or contact MediLink support. | no |
| `DIFFERENT_MEDICINE` | Not the same medicine | MediLink only offers the exact same medicine. | no |
| `BRAND_SWITCH_NOT_ALLOWED` | Different brand | Allow another brand of the same medicine to see more suppliers. | no |
| `ROUTE_CLOSED` | Road closed | MediLink re-checks the roads and will re-route when possible. | no |
| `ETA_AFTER_NEEDED_BY` | Would arrive too late | MediLink will look for a nearer supplier. | no |
| `TRANSFER_NOT_FOUND` | Delivery not found | Go back to your home screen and open it again. | no |
| `INVALID_STATUS` | Already handled | Refresh your home screen to see the latest state. | no |
| `NOT_SUPPLIER` | Not your request | No action needed from you. | no |
| `NOT_APPROVER` | Not yours to sign | No action needed from you. | no |
| `NOT_RECEIVER` | Not your delivery | No action needed from you. | no |
| `NOT_A_PARTY` | Not your delivery | No action needed from you. | no |
| `WRONG_PARTNER` | Assigned to another courier | Check the delivery list in your app. | no |
| `REPAYMENT_MODE_REQUIRED` | Choose how to be repaid | Choose one option and tap Accept again. | no |
| `INVALID_QUANTITY` | Check the quantity | Enter a number in that range. | no |
| `DECLINE_REASON_REQUIRED` | Tell us why | Pick a reason and tap Decline again. | no |
| `REJECT_REASON_REQUIRED` | Tell us why | Type a short reason and tap Reject again. | no |
| `SECOND_SIGNOFF_SAME_USER` | A second person must sign | Ask another approver at your hospital to sign. | no |
| `INVALID_DECISION` | Choose an option | Tap one of the buttons shown. | no |
| `SCAN_INCOMPLETE` | Scan everything | Scan the missing labels and try again. | no |
| `BATCH_MISMATCH` | Wrong batch | Check you have the right boxes and scan every batch label. | no |
| `STOCK_CHANGED` | Stock changed | Ask the supplying pharmacist to check, then try again. | yes |
| `SHIPMENT_NOT_FOUND` | No active delivery | Check the logger was scanned at pickup. | no |
| `INVALID_TELEMETRY` | Bad reading | Check the logger is working. | no |
| `PROOF_OF_CONDITION_FAILED` | Cannot accept into stock | Set it aside (quarantine) and ask the supplier and courier what happened. | no |
| `NO_PARTNER` | No courier available | MediLink keeps trying. Contact support if this lasts. | no |
| `LOAN_NOT_FOUND` | Loan not found | Refresh your home screen. | no |
| `LOAN_NOT_OPEN` | Loan already closed | No action needed. | no |
| `INVALID_MODE` | Choose how to repay | Pick one option. | no |
| `SETTLEMENT_TRANSFER_REQUIRED` | Pick the return delivery | Choose that delivery from the list. | no |
| `REPAYMENT_NOT_DELIVERED` | Return not delivered yet | Wait until it is accepted at the lending hospital. | no |
| `REPAYMENT_WRONG_PARTIES` | Wrong delivery | Pick the right delivery. | no |
| `REPAYMENT_WRONG_DRUG` | Wrong medicine | Pick the right delivery. | no |
| `REPAYMENT_SHORT` | Not enough returned | Send the rest, or mark the difference as paid. | no |
| `REPAYMENT_ALREADY_USED` | Delivery already counted | Pick another return delivery, or mark the loan as paid. | no |
| `REPAYMENT_WRONG_LOAN` | Not a loan you owe | Accept without linking a loan, or pick the right loan. | no |
| `PAYMENT_REFERENCE_REQUIRED` | Add the payment reference | Type the reference from your payment. | no |
| `INVALID_MARGIN` | Check the safety margin | Enter a number from 0 to 100. | no |
| `INVALID_REORDER_LEVEL` | Check the reorder level | Enter a whole number of units. | no |
| `INVALID_EMAIL` | Check the email address | Type one address, like name@hospital.org, or leave it empty. | no |
| `CHOOSE_HOSPITAL` | Choose a hospital | Choose a hospital from the list and try again. | no |
| `AUDIT_APPEND_ONLY` | Records cannot be changed | No action possible. | no |
| `UNKNOWN_ACTION` | Unknown action | Refresh the app and try again. | no |
| `INVALID_INPUT` | Check what you entered | Correct the highlighted field and try again. | no |
| `ACTION_IN_PROGRESS` | Still working on it | Wait a moment, then refresh. | yes |
| `NOT_ALLOWED` | Not available for your role | Ask your MediLink admin if you think you should. | no |
| `NOT_SIGNED_IN` | Please sign in | Sign in and try again. | no |
| `LOGIN_FAILED` | Wrong username or password | Check both and try again. Your MediLink admin can reset your password. | no |
| `TOO_MANY_LOGIN_ATTEMPTS` | Too many tries | Wait 15 minutes, then try again, or ask your MediLink admin to reset your password. | no |
| `SESSION_EXPIRED` | Please sign in again | Sign in again to continue. | no |
| `RATE_LIMITED` | Too many requests | Wait a few minutes, then try again. | yes |
| `COURIER_LINK_INVALID` | This link does not work | Ask the hospital that is sending the medicine for a new link. | no |
| `COURIER_LINK_NOT_FOUND` | No working courier link | Tap "New courier link" to make a fresh one. | no |
| `COURIER_LINK_NOT_YOURS` | Not your delivery | No action needed from you. | no |
| `COURIER_TOO_MANY_REQUESTS` | Too many updates | Wait a minute, then try again. | no |
| `WEAK_PASSWORD` / `USER_EXISTS` / `USER_NOT_FOUND` / `CANNOT_DISABLE_SELF` | (admin user management) | see `backend/_i18n/messages.properties` | no |
| `NOT_FOUND` | Not found | Go back to your home screen. | no |
| `NOTHING_TO_REQUEST` | Already requested | Follow it on your home screen. | no |
| `UNEXPECTED` | Something went wrong | Try again in a minute. If it keeps happening, contact MediLink support. | yes |

---

## 7. `GET /me/onboarding`

```jsonc
{
  "done": false, "current": "licence",
  "steps": [
    { "id": "licence", "label": "Enter licence",       "status": "current", "detail": "Type the drug licence number printed on the licence in your pharmacy." },
    { "id": "checked", "label": "Licence checked",     "status": "todo",    "detail": "City Cancer Hospital, Jayanagar · Licence valid till 2028" },
    { "id": "connect", "label": "Connect your system", "status": "todo",    "detail": "Your stock is in MediSoft HIS. Tap Allow and sign in as you do every day." },
    { "id": "sync",    "label": "First sync",          "status": "todo",    "detail": "Your board will be ready in a few minutes." },
    { "id": "ready",   "label": "Ready",               "status": "todo",    "detail": "All set. MediLink checks your stock every 15 minutes." }
  ],
  "nextAction": { "id": "enter-licence", "label": "Check licence", "fields": [ { "name": "licenceNo", "label": "Drug licence number", "type": "text", "placeholder": "KA-BLR-20B-1001" } ], … },
  "fallbacks": [],
  "message": "Type the drug licence number printed on the licence in your pharmacy."
}
```

`status`: `done` · `current` (highlight it) · `todo` · `blocked` (e.g. expired licence; then `error` carries the
plain-language reason). The licence number is the only thing a pharmacist types. At **Connect your system**,
`nextAction` depends on the hospital's software and `fallbacks` offers the alternatives:

| Software | `nextAction` | Fallbacks |
|---|---|---|
| MediSoft (partner HIS) | `allow-access` → `next.open` sign-in popup | `pick-software`, `ask-it-team`, `upload-sheet`, `upload-photo` |
| SAP | `allow-access` (the hospital's SAP admin connected MediLink once) | same |
| In-house database | `ask-it-team` (sends the IT team a setup link; `next.show` has the pairing code) | same |
| Sheet | `upload-sheet` | `pick-software`, `ask-it-team`, `upload-photo` |
| Not recognised | `pick-software` (dropdown incl. "Ask my IT team") | the rest |

`upload-photo` is shown with `available: false` while the AI service is off.

---

## 8. `GET /me/journeys/{id}` and `GET /me/city`

`/me/journeys/{id}` returns one journey (§3) by request or transfer ID, or `404 NOT_FOUND` if the user has no part in it.

```jsonc
// GET /me/city — counts only, never a hospital name or patient data
{ "windowDays": 14,
  "rows": [ { "drugId": "D-TRAS440", "drug": "Trastuzumab 440 mg", "hospitalsShort": 1, "dosesShort": 2, "dosesBooked": 3, "citySurplus": 6, "earliestNeed": "2026-11-04",
              "text": "Trastuzumab 440 mg: 1 hospital(s) short of 2 doses; 6 spare across the city" }, … ],
  "emptyText": null }
```

---

## 9. Live updates (WebSocket)

Browsers cannot set headers on a WebSocket, and a sign-in token in a URL ends up in proxy logs. So first trade the
sign-in for a ticket: `POST /auth/ws-ticket` (Bearer or Basic) → `{ "ticket": "<43 chars>", "expiresIn": 30 }`, then
connect to `wss://<host>/ws/tracking?ticket=<ticket>` within 30 s. A ticket works **once**; reconnecting needs a new one.
`?access_token=` is not accepted. Scripts may instead send `Authorization: Bearer|Basic` on the upgrade request.
On connect the server puts the socket into the user's own contexts (`hospital:<id>`, `hospital:<id>:<role>`, `admin`);
a client cannot join any other. Each event reaches only the supplying and receiving hospital of that delivery (plus admins).

Messages are JSON `{ "event": "...", "data": { ... } }`:

| `event` | `data` | Use |
|---|---|---|
| `journey.updated` | `{ journeyId, perspective, journey }`, where `journey` is exactly the §3 object for this user; sent on status changes and when a tracking step changes (first fix, nearby, arrived) | replace the card with the same `id`; re-fetch `/tracking` |
| `tracking` | receiver + admin: `{ transferId, requestId, status, position: { lat, long, at, accuracyM }, temperature: { current, inRange, range: { minC, maxC } }, eta, etaText, remainingKm }`; supplier: `{ transferId, requestId, status }` | move the rider marker, update ETA / temperature (after every GPS or logger fix) |
| `excursion` | `{ transferId, temperatureC, range, message, quarantineSuggested, hospitals }` | optional banner (also arrives as an alert + `journey.updated`) |
| `replan` | `{ transferId, distanceKm, etaMin, open, note }` | redraw the route |
| `status` | `{ transferId, status, message }` | optional |
| `alert` | `{ hospitalId, kind, severity, message, ref }` | refresh `GET /me/home` |

```js
const { ticket } = await (await fetch('/auth/ws-ticket', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })).json();
const ws = new WebSocket(`wss://${location.host}/ws/tracking?ticket=${ticket}`);
ws.onmessage = e => {
  const { event, data } = JSON.parse(e.data);
  if (event === 'journey.updated') replaceCard(data.journey.id, data.journey);
  if (event === 'alert') reloadHome();
};
```

Known limit: a `journey.updated` pushed to all approvers of a hospital still shows **Approve** to the approver who
already signed; tapping it returns `SECOND_SIGNOFF_SAME_USER` ("A second person must sign"). `GET /me/home` is always exact.

---

## 10. A complete beginner UI in a dozen lines

```js
async function render() {
  const home = await api('GET', '/me/home');
  header(home.greeting, home.hospital?.connection.text, home.hospital?.licence.text);
  if (home.onboarding) banner(home.onboarding.message, button(home.onboarding.nextAction));
  list(home.alerts.map(a => alert(a.severity, a.message)), home.empty.alerts);
  list(home.tasks.map(t => card(t.title, t.subtitle, button(t.primaryAction), t.secondaryAction && button(t.secondaryAction))), home.empty.tasks);
  list(home.journeys.map(j => journeyCard(j.stage, j.of, j.stageLabel, j.colour, j.headline, j.timeline, j.actions.map(button))), home.empty.journeys);
}
async function tap(action, values) {
  if (action.confirm && !confirm(action.confirm)) return;
  const r = await api('POST', action.path, { ...action.body, ...values }, { 'Idempotency-Key': crypto.randomUUID() });
  if (r.code) return showError(r.title, r.message, r.fix, r.retryable);
  toast(r.message);
  if (r.next?.type === 'open') window.open(r.next.url, 'medilink-allow', 'width=480,height=640');
  render();
}
```

---

## 11. Text, languages and empty states

All user-facing text comes from the CAP i18n bundle `backend/_i18n/messages.properties` (keys `error.*`,
`journey.*`, `timeline.*`, `home.*`, `alert.*`, `task.*`, `onboarding.*`, `action.*`, `confirm.*`, `field.*`,
`empty.*`, …). To add Kannada or Hindi, copy it to `messages_kn.properties` / `messages_hi.properties`, keep the keys,
translate the values (keep `{placeholders}`), and send `Accept-Language: kn` / `hi`. Missing keys fall back to English.

Empty states the API already provides: "Nothing needs you right now." · "No alerts. All clear." ·
"No medicine on the move for you right now." ·
"All your critical drugs are covered for the next 14 days." · "No hospital in the city is short right now."

---

## 12. Admin

- `GET /health` (no sign-in) → `{ status, profile, synthetic, services }`, `services` = one line, e.g. "Database: SQLite file · Logins: MediLink accounts · Approvals: built-in · Alerts: in-app · AI: off".
- `GET /health/integrations` → `{ checkedAt, headline, summary, approvalMode, llmProvider, items: [{ service, status: connected|fallback|misconfigured, mode, text }] }`. Items: Database, Logins, Hospital access tokens, Email alerts (SMTP), SAP Alert Notification, AI (LLM), SAP Build Process Automation, SAP Business Accelerator Hub (sandbox), OR-Tools ranking service, OpenRouteService (roads), Open-Meteo (rain check), MediSoft HIS. E.g. "SAP Build Process Automation — fallback — Off (optional): MediLink runs supplier answers, sign-offs and the 30-minute timer itself (APPROVAL_MODE=cap)."
- `GET /admin/metrics` → `{ metrics: [{ id, label, value, unit, target, goal: { value, dir: min|max }, met, count, text }] }` for alert lead time, request-to-acceptance time, flagged lots moved (must stay 0), temperature-trace completeness and onboarding time.
- `GET /admin/overview` → `{ generatedAt, kpis, hospitals, cover, expiry, alerts, coldChain, activity }`: the admin dashboard's numbers (feed state, units by expiry, hospital × medicine cover grid, open alerts by kind, temperature traces on the road, latest audit entries). Derived from existing state.
- Accounts: `GET /auth/users` · `POST /auth/users {username, password, role, hospital, email?}` · `POST /auth/users/{username}/reset-password|disable|enable|email`.
- `GET /admin/courier-links` (§14). Audit log entries are admin-only; approvers keep `GET /audit/verify`.

---

## 13. Stock and expiry monitoring

MediLink checks every hospital's stock after each stock update (sheet, photo, connector push, MediSoft / SAP pull),
in the scheduled sync cycle and once at start-up. Each condition alerts **once**: it alerts again only when it gets worse
(low → out, expiry tier 30 → 7 → expired) or comes back after it cleared, and it closes itself when it is gone.

| Alert `kind` | When | Severity (home colour) |
|---|---|---|
| `OUT_OF_STOCK` | 0 usable units (sealed, not quarantined, in date, not on a recall) and a reorder level is set | HIGH (red) |
| `LOW_STOCK` | usable units ≤ reorder level (hospital level, else the medicine's default; none = not watched) | MEDIUM (amber) |
| `EXPIRING` | a usable lot inside a tier of `EXPIRY_ALERT_DAYS` (default 90, 60, 30, 7); only the tightest tier reached | tier 7 HIGH (red), 30 MEDIUM, 60/90 LOW (amber) |
| `EXPIRED` | a lot at or past its expiry date, units left, not quarantined yet | HIGH (red) |

Lots inside `NEAR_EXPIRY_DAYS` that the hospital can spare without uncovering its own bookings get "offer it as surplus
to nearby hospitals". Email: one digest per hospital per check, to that hospital's pharmacists and approvers who saved an
email, else the hospital's admin email, else `ALERT_EMAIL_TO` (SMTP or SAP Alert Notification; console when neither).

**`GET /me/home`** adds the open, not acknowledged stock alerts to `alerts[]` (after the existing kinds within a colour)
and a summary:

```jsonc
"alerts": [ { "kind": "EXPIRED", "severity": "red", "lotId": "H5-TRAS-X", "notificationId": "e8bec0b3-…",
              "message": "Batch NB24T019 of Trastuzumab 440 mg (1 vial) expired on 29 Oct 2026. Take it off the shelf and quarantine it.",
              "actions": [ { "id": "ack-alert", "label": "Got it", "style": "secondary", "method": "POST", "path": "/me/actions/ack-alert", "body": { "notificationId": "e8bec0b3-…" }, "fields": [] } ] },
            { "kind": "LOW_STOCK", "severity": "amber", "drugId": "D-5FU500", "notificationId": "…", "message": "Fluorouracil 500 mg is running low: 5 left (reorder level 8). Reorder soon.", "actions": [ … ] } ],
"stockSummary": { "out": 1, "low": 1, "expiring": 4, "expired": 1, "text": "1 out of stock, 1 low, 4 expiring soon, 1 expired", "emptyText": null }
```
`stockSummary` is `null` for users without a hospital (admin). Stock alerts carry `drugId` (`LOW_STOCK`, `OUT_OF_STOCK`) or `lotId` (`EXPIRING`, `EXPIRED`).

**`GET /me/stock`** (own hospital; admin must add `?hospital=H5`) — every medicine the hospital holds or has a level for, worst first:

```jsonc
{
  "hospital": { "id": "H1", "name": "City Cancer Hospital, Jayanagar" },
  "summary": { "out": 1, "low": 1, "expiring": 1, "expired": 1, "text": "1 out of stock, 1 low, 1 expiring soon, 1 expired", "emptyText": null },
  "drugs": [
    { "drugId": "D-GEMC1G", "drug": "Gemcitabine 1 g", "onHand": 0, "threshold": 4, "thresholdSource": "default",   // "hospital" | "default" | null
      "status": "out",                                   // out | low | ok | untracked (no level)
      "severity": "HIGH", "text": "Out of stock. Reorder level 4.",
      "lots": [ { "lotId": "H1-GEMC1G-X", "batchNo": "GEMC24S997", "brandName": "Gemzora", "qty": 3, "expiryDate": "2026-10-29", "daysLeft": -3,
                  "tier": 0,                             // 90 | 60 | 30 | 7 (EXPIRY_ALERT_DAYS), 0 = expired
                  "status": "expired", "nearExpiry": false, "spare": 0, "severity": "HIGH",
                  "text": "Expired on 29 Oct 2026. Take it off the shelf and quarantine it." } ],
      "actions": [ { "id": "set-reorder-level", "label": "Set reorder level", "body": { "drugId": "D-GEMC1G" },   // admin: body also has "hospital"
                     "fields": [ { "name": "minUnits", "label": "Alert me when stock falls to (units)", "type": "number", "required": true, "min": 0, "max": 100000, "default": 4 } ], … } ] },
    { "drugId": "D-CARB450", "onHand": 26, "threshold": 10, "status": "ok", "severity": "HIGH", "text": "26 in stock. Reorder level 10.",
      "lots": [ { "batchNo": "SOL24A031", "qty": 6, "daysLeft": 4, "tier": 7, "status": "expiring", "nearExpiry": true, "spare": 0, "text": "Expires in 4 days (5 Nov 2026). Use it first." } ], … }
  ],
  "emptyText": null                                      // "No stock recorded for your hospital yet." when drugs is empty
}
```
`lots` lists only expiring (inside a tier) and expired lots. Errors: `CHOOSE_HOSPITAL` (admin without `?hospital=`), `FORBIDDEN_HOSPITAL` (another hospital), `NO_HOSPITAL`, `NOT_FOUND`.

**`GET /me/notifications?status=open|all`** (default `open` = not resolved and not acknowledged) — the in-app inbox of the
user's own hospital (admin: every hospital), newest first, at most 200:

```jsonc
{ "status": "open",
  "notifications": [ { "id": "…", "hospitalId": "H5", "kind": "EXPIRED", "severity": "HIGH", "colour": "red", "message": "…", "ref": "H5-TRAS-X", "tier": 0,
                       "dueDate": "2026-10-29", "createdAt": "…", "open": true, "resolvedAt": null, "ackedAt": null, "ackedBy": null,
                       "actions": [ { "id": "ack-alert", … } ] } ],          // [] once acknowledged or resolved
  "alertEmail": { "email": null, "text": "Add your email to get your hospital's alerts by email.",
                  "action": { "id": "set-alert-email", "label": "Save my email", "fields": [ { "name": "email", "type": "text", "required": false } ], … } },
  "emptyText": null }                                                         // "No open alerts." / "No alerts yet."
```
The inbox shows every kind (shortfall, recall, excursion, licence, stale feed, supplier messages, stock, expiry).

**Actions** (`POST /me/actions/{id}`, §5):

| id | Body | Who | Does |
|---|---|---|---|
| `ack-alert` | `{ notificationId }` | pharmacist, approver (own hospital), admin | Hides the alert from home; it stays in the inbox. Another hospital's alert → 404 `NOT_FOUND` |
| `set-reorder-level` | `{ drugId, minUnits, hospital? }` (`hospital` admin only) | pharmacist, approver (own hospital), admin | Saves the hospital's level (whole number 0–100000) and re-checks at once. `INVALID_REORDER_LEVEL`, `FORBIDDEN_HOSPITAL`, `CHOOSE_HOSPITAL` |
| `set-alert-email` | `{ email }` (empty = stop emails) | pharmacist, approver, admin (own account) | Where this person's hospital alerts are emailed. `INVALID_EMAIL` |

Admins set emails with `POST /auth/users` (`email` field) and `POST /auth/users/{username}/email { email }`; `GET /auth/me`
returns `email` when set. The safety margin (`POST /odata/v4/settings/setSafetyMargin`) is approver or admin only.

**WebSocket**: every new alert is an `alert` event `{ hospitalId, kind, severity, message, ref, notificationId }` for that hospital's sockets (and admins).

**Settings**: `EXPIRY_ALERT_DAYS` (default `90,60,30,7`), `NEAR_EXPIRY_DAYS` (60), `ALERT_EMAIL_TO` (fallback list).

---

## 14. Courier links and live tracking (Swiggy / Zomato style)

Delivery partners have **no MediLink account**. When a partner is assigned (second sign-off done), MediLink mints a
**courier link** for that one delivery: `${APP_BASE_URL}/courier.html#t=<token>` (256-bit random, base64url, 43 chars).
The token is in the URL **fragment**, so it never reaches a server log or a `Referer`. MediLink stores only its SHA-256
and an AES-256-GCM copy bound to the delivery (so the supplier can show it again). Hand-off: emailed to the partner's
dispatch address when SMTP is on, and the supplying hospital's `courier-link` action returns it for copy / QR.

| The link works… | |
|---|---|
| while the delivery is `ASSIGNED` or `IN_TRANSIT` | full courier steps |
| after `DELIVERED` / `QUARANTINED` | read-only `GET /courier/job` (`readOnly: true`) for 2 h |
| never after | `COURIER_LINK_TTL_HOURS` (24), cancel, recall, `reissue-courier-link` |

### The courier page (`frontend/courier.html`)

Read the token from `location.hash` (`#t=…`) and send `Authorization: Courier <token>` on every call. Responses carry
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Bodies are JSON, at most 2 kB; unknown fields, wrong types
and out-of-range values get `400 INVALID_INPUT`. A bad, expired, revoked or finished link always gets the same
`401 COURIER_LINK_INVALID` ("This link does not work … Ask the hospital that is sending the medicine for a new link.").
More than 60 calls a minute per link, or 1200 per IP address, get `429 COURIER_TOO_MANY_REQUESTS`: send at most one
fix every 5 s from the phone (throttle `watchPosition`), and refresh the job at most every 15 s.

| Call | Body | Answer |
|---|---|---|
| `GET /courier/job` | – | the job (below) |
| `POST /courier/pickup` | `{ batchNo, sealId, loggerId, riderName?, riderPhone? }` (several batches: comma separated) | `{ message: "Pickup recorded. Tracking is live.", job }`; `409 BATCH_MISMATCH` "Wrong batch", `409 INVALID_STATUS` if already picked up |
| `POST /courier/location` | `{ lat, long, accuracyM?, ts?, temperatureC?, sealStatus? }`: the phone sends GPS only, the logger adds `temperatureC` | `{ accepted: true, excursion: false }`; `409 INVALID_STATUS` before pickup or after delivery. `ts` (ISO) is clamped to [pickup, now + 60 s] |
| `POST /courier/road-closed` | `{ note? }` | `{ message: "Thanks. We found a new route.", open, distanceKm, etaMin }` |

```jsonc
// GET /courier/job — this one delivery; no batch numbers (the pickup scan proves them), no patient data
{ "status": "ASSIGNED", "readOnly": false, "next": "pickup",            // next: pickup | deliver | done
  "drug": { "name": "Carboplatin", "strength": "450 mg/45 mL", "form": "Injection" }, "qty": 16,
  "storageClass": "AMBIENT", "temperatureRange": { "minC": 2, "maxC": 30 },
  "pickup": { "name": "Banashankari Care Hospital, Banashankari", "address": "2nd Stage, Banashankari, Bengaluru 560070", "lat": 12.9255, "long": 77.5468 },
  "drop":   { "name": "City Cancer Hospital, Jayanagar", "address": "9th Block, Jayanagar, Bengaluru 560069", "lat": 12.9299, "long": 77.5826 },
  "handlingNote": "Carboplatin 450 mg/45 mL injection: 16 vials (batch •••• x 12, •••• x 4). Keep between 2 and 30 °C, …",
  "partner": { "name": "CoolRoute Logistics (synthetic)" }, "rider": { "name": null, "phone": null },
  "pickedUpAt": null, "eta": null, "etaMin": 34, "routeNote": null,
  "route": { "points": [[12.9255, 77.5468], [12.9299, 77.5826]],        // openrouteservice geometry when ORS_API_KEY is set
             "steps": [ { "instruction": "Collect the medicine at Banashankari Care Hospital, Banashankari" },
                        { "instruction": "Deliver to the pharmacy at City Cancer Hospital, Jayanagar" } ] },
  "expiresAt": "2026-11-02T12:41:35.915Z" }
```

Browser limits to plan for: `navigator.geolocation.watchPosition` needs HTTPS (or `localhost`) and the user's
permission, and browsers throttle or stop it when the tab is in the background or the screen is off (a Screen Wake Lock
helps only while the page is visible). The temperature logger posting through the same link is the source of truth for
the temperature trace; GPS-only fixes never count towards it.

### `GET /me/journeys/{id}/tracking` (the receiving hospital's map)

`{id}` = journey (request) ID or a transfer ID. The receiving hospital (pharmacist / approver) and admins get everything;
the supplying hospital gets a summary (`riderPhone`, `position`, `trail`, `route`, `temperature.readings` empty);
anyone else gets `404 NOT_FOUND`, exactly like an unknown ID. One entry per leg that is `ASSIGNED` or `IN_TRANSIT`, or
delivered less than 2 h ago. Poll it every 15–30 s, or re-fetch on a `journey.updated` and move the marker on `tracking`.

```jsonc
{ "journeyId": "7c1d…", "requestId": "7c1d…", "perspective": "receiver",
  "legs": [ {
    "transferId": "25e5…", "status": "IN_TRANSIT", "drug": { "name": "Carboplatin 450 mg" }, "qty": 16,
    "steps": [
      { "key": "confirmed",  "label": "Courier assigned", "done": true,  "at": "2026-11-01T09:20:11.000Z" },
      { "key": "picked_up",  "label": "Picked up",        "done": true,  "at": "2026-11-01T09:31:40.000Z" },
      { "key": "on_the_way", "label": "On the way",       "done": true,  "at": "2026-11-01T09:32:05.000Z" },
      { "key": "nearby",     "label": "Nearby",           "done": false, "at": null },    // within NEARBY_KM (1 km)
      { "key": "arrived",    "label": "Arrived",          "done": false, "at": null },    // within 500 m
      { "key": "delivered",  "label": "Delivered",        "done": false, "at": null } ],
    "partner": { "name": "CoolRoute Logistics (synthetic)" }, "riderName": "Asif (synthetic)", "riderPhone": "+91 90000 00002",
    "origin":      { "name": "Banashankari Care Hospital, Banashankari", "lat": 12.9255, "long": 77.5468 },
    "destination": { "name": "City Cancer Hospital, Jayanagar",          "lat": 12.9299, "long": 77.5826 },
    "route": [[12.9255, 77.5468], [12.9299, 77.5826]],                    // ORS geometry when keyed, else pickup -> detours -> drop
    "position": { "lat": 12.9264, "long": 77.554, "at": "2026-11-01T09:40:02.000Z", "accuracyM": 8 },   // null before the first fix
    "trail": [[12.9258, 77.5476], [12.9261, 77.5504], [12.9264, 77.554]],   // last 20 fixes, oldest first
    "eta": "2026-11-01T09:52:00.000Z", "etaText": "~12 min · 3:22 pm", "remainingKm": 3.94,
    "temperature": { "current": 24.1, "at": "2026-11-01T09:40:02.000Z", "min": 23.8, "max": 24.6,
                     "range": { "minC": 2, "maxC": 30 }, "inRange": true, "readings": [ { "at": "…", "c": 24.1 } ] },   // last 20
    "excursion": false, "delayed": false, "routeNote": null } ] }
```

`eta` is recomputed from the latest fix at most once a minute (openrouteservice when `ORS_API_KEY` is set, else
straight line × `ROAD_FACTOR` at `CITY_SPEED_KMH`) and saved; `etaText` is `"Arriving now"` once it has passed.
`delayed` = the ETA has passed without an "arrived" fix, or it falls after the needed-by date.

### Admin

`GET /admin/courier-links` (admin only, `no-store`) → `{ links: [{ transferId, requestId, status, partnerId, url, token, createdAt, expiresAt, batches }] }`
for every delivery waiting for pickup or on the road. The simulator uses it; support can use it to resend a link.

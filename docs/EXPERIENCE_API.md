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
| Base URL | development `http://localhost:4004` · Cloud Foundry: the **app router** URL (`medilink-approuter`) |
| Sign-in | development: HTTP Basic with a demo user (`asha`, `ravi`, `meera`, `kiran`, `partner`, `admin`, …, password `demo`). Production: the app router logs the user in with XSUAA and forwards the token; send no credentials yourself. |
| CSRF (production only) | the app router protects `POST`. Fetch a token once with `GET /me/home` + header `X-CSRF-Token: Fetch`, then send `X-CSRF-Token: <value>` on every `POST`. |
| Format | JSON in, JSON out. Dates `YYYY-MM-DD`, timestamps ISO-8601 UTC. Every text meant for people is already written for them (times shown in India time, e.g. `2:15 pm`). |
| Language | `Accept-Language` picks the text bundle. Today only English exists; other languages fall back to English (see §11). |
| Roles | `pharmacist`, `approver`, `partner` (courier), `admin`. A user acts for one hospital (`hospital` attribute) or one courier company (`partner`). Everything is filtered to that. |

### Endpoints

| Method + path | What it returns | Who |
|---|---|---|
| `GET /me/home` | The home screen: hospital/courier status, onboarding, alerts, task cards, journeys, cover summary | everyone |
| `GET /me/onboarding` | The onboarding checklist with the single next action | pharmacist (others get `{ done: true }`) |
| `GET /me/journeys/{id}` | One journey (by request ID or transfer ID) | the parties of that journey |
| `GET /me/city` | Aggregated, anonymised city view (no hospital names) | everyone |
| `POST /me/actions/{actionId}` | Runs a button. Body = the action's `body` + the user's `fields` | see §6 |
| `WS /ws/tracking` | Live updates for the user's own deliveries, including `journey.updated` | everyone |
| `GET /health/integrations` · `GET /admin/metrics` | Which SAP services are live / on fallback; PRD success metrics | admin |

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
  "partner": null,
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
  "coverSummary": { "red": 1, "amber": 1, "green": 5, "windowDays": 14, "text": "1 short, 1 low, 5 covered", "emptyText": null },
  "empty": {}                               // friendly text for every list that is empty, e.g. { "tasks": "Nothing needs you right now." }
}
```

| Field | Meaning |
|---|---|
| `hospital.connection.status` | `connected` · `stale` (no update for over an hour; stock greyed out) · `never` (waiting for first sync) · `disconnected` (then `connection.action` is the button to connect) |
| `hospital.licence.status` | `valid` · `expiring` (within 30 days) · `expired` |
| `alerts[]` | Already sorted: red first; within a colour, what can hurt a patient today first. `kind`: `EXCURSION`, `RECALL`, `SHORTFALL`, `LICENCE_EXPIRY`, `STALE_FEED`, `BELOW_MARGIN`. Show `message` as is. |
| `tasks[]` | Things this user must act on now, sorted by `urgency` (`high` · `medium` · `low`) then `dueBy`. Exactly one `primaryAction`, optional `secondaryAction`. |
| `coverSummary` | Counts of red (short), amber (covered but below the safety margin) and green drugs. `emptyText` when nothing is short. |

### What each role sees

| Role | `hospital` / `partner` | Typical tasks | Journeys |
|---|---|---|---|
| pharmacist (requesting) | own hospital | `send_request`, `choose_plan`, `find_again`, `arrival`, `repay`, `connect` | own requests (receiver view) + stage-1 shortfalls |
| pharmacist (supplying) | own hospital | `accept_request` | requests sent to the hospital (supplier view) |
| approver | own hospital | `approve` (hidden once this person has signed) | the hospital's journeys, read-only |
| partner (courier) | own company | `pickup` | deliveries assigned to the company |
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
// partner (courier) — tasks[0]
{ "kind": "pickup", "title": "Pick up 16 vials at Banashankari Care Hospital",
  "subtitle": "Deliver to City Cancer Hospital. Carboplatin 450 mg/45 mL injection: 16 vials (batch SOL24B077 x 12, SOL25A015 x 4). Keep between 2 and 30 °C, …",
  "primaryAction": { "id": "pickup-scan", "label": "Scan pickup",
    "fields": [ { "name": "batchNo", "label": "Scan the batch label(s)", "type": "barcode", "hint": "Expected: SOL24B077, SOL25A015" },
                { "name": "sealId", "label": "Scan the seal", "type": "barcode" }, { "name": "loggerId", "label": "Scan the temperature logger", "type": "barcode" } ], … } }
```

---

## 3. Journeys

One journey per medicine request, the same object for every party, worded for whoever is looking (`perspective`:
`receiver`, `supplier`, `partner`, `admin`). It is **derived** from the request, transfer, approval, delivery, receipt
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

| # | `stageLabel` | Requesting hospital sees | Supplying hospital sees | Courier sees |
|---|---|---|---|---|
| 1 | Shortfall found | You're short 16 doses of Carboplatin 450 mg by 10 Nov | – | – |
| 2 | Request sent | Finding the nearest safe supplier… · Found a safe supplier: Banashankari Care Hospital. Tap to ask them. | – | – |
| 3 | Waiting for supplier | Asked Banashankari Care Hospital | City Cancer Hospital needs 16 vials. You'll still cover your own patients. | – |
| 4 | Waiting for approval | Supplier said yes, waiting for sign-off | Waiting for sign-off | – |
| 5 | On the way | Approved. CoolRoute Logistics will pick it up soon · On the way, arriving ~2:42 pm, 5.4 °C | Approved. CoolRoute Logistics is coming to pick up 16 vials · Picked up | Pick up 16 vials at Banashankari Care Hospital · Deliver to City Cancer Hospital by ~2:42 pm |
| 6 | Arrived | Arrived. Check and accept | Delivered | At City Cancer Hospital: hand it to the pharmacist |
| 7 | Done | 40 of 40 doses covered | Loan of 16 vials open: repay in kind or at cost | Delivered |

### Every `key`, including the side paths

`key` tells the UI exactly which situation it is in (for icons or analytics); the `headline` already says it in words.

| `key` | Stage | Colour | Requesting hospital (`receiver`) headline | Notes |
|---|---|---|---|---|
| `shortfall` | 1 | red | You're short {qty} doses of {drug} by {date} | before any request exists |
| `finding` | 2 | amber | Finding the nearest safe supplier… | request being ranked |
| `choose_supplier` | 2 | amber | Found a safe supplier: {hospital}. Tap to ask them. | task `choose_plan` |
| `no_match` | 2 | red | No safe supplier can help right now | task `find_again` |
| `recalled` | 2 | red | This batch was recalled. Transfer cancelled | courier: "This batch was recalled. Do not pick it up"; task `find_again` |
| `cancelled` | ≤4 | grey | You cancelled this request | supplier: "{hospital} no longer needs it" |
| `waiting_supplier` | 3 | amber | Asked {hospital} | supplier: "… You'll still cover your own patients." (or "Giving all of them would leave your own patients short.") |
| `waiting_supplier_fallback` | 3 | amber | {hospital} said no. Asking the next nearest hospital: {next} | also "… didn't answer in time." / "Sign-off refused at {hospital} ({reason})." |
| `declined` · `timed_out` · `rejected` | 3–4 | grey | – | supplier's own view: "You said no" · "No answer in time, so another hospital was asked" · "Sign-off refused: {reason}" |
| `waiting_approval` · `waiting_second_approval` | 4 | amber | Supplier said yes, waiting for (a second) sign-off | approver task `approve` |
| `finding_partner` | 4 | amber | Approved. Finding a licensed courier | no certified courier free yet |
| `waiting_pickup` | 5 | green | Approved. {courier} will pick it up soon | courier task `pickup` |
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
| `pickup` | courier | approved and assigned to your company | `pickup-scan` | high |
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

**How to submit:** `POST path` with JSON `{ ...body, ...fieldValues }` and a fresh `Idempotency-Key` header per tap.

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
| `pickup-scan` | partner, admin | `transferId` | `batchNo`, `sealId`, `loggerId` | `DeliveryService.pickupScan` |
| `report-road-closed` | partner, pharmacist, admin | `transferId` | `note`? | `RouteService.setRouteClosed` → re-route |
| `accept-delivery` | pharmacist, admin | `transferId` | `batchNo`, `sealIntact`, `qtyReceived` | `ReceiptService.arrivalScan(ACCEPT)` |
| `quarantine-delivery` | pharmacist, admin | `transferId` | `batchNo`, `sealIntact`, `qtyReceived` | `ReceiptService.arrivalScan(QUARANTINE)` |
| `mark-loan-paid` | pharmacist, admin | `loanId` | `reference` | `LedgerService.settleLoan(LANDED_COST)` |
| `repay-in-kind` | pharmacist, admin | `loanId` | `settlementTransfer` | `LedgerService.settleLoan(IN_KIND)` |

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
| `PAYMENT_REFERENCE_REQUIRED` | Add the payment reference | Type the reference from your payment. | no |
| `INVALID_MARGIN` | Check the safety margin | Enter a number from 0 to 100. | no |
| `AUDIT_APPEND_ONLY` | Records cannot be changed | No action possible. | no |
| `UNKNOWN_ACTION` | Unknown action | Refresh the app and try again. | no |
| `INVALID_INPUT` | Check what you entered | Correct the highlighted field and try again. | no |
| `ACTION_IN_PROGRESS` | Still working on it | Wait a moment, then refresh. | yes |
| `NOT_ALLOWED` | Not available for your role | Ask your MediLink admin if you think you should. | no |
| `NOT_SIGNED_IN` | Please sign in | Sign in and try again. | no |
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

Connect to `ws://<host>/ws/tracking` (behind the app router: `wss://<router>/ws/tracking`; development: send the
Basic `Authorization` header on the upgrade request). On connect the server puts the socket into the user's own
contexts (`hospital:<id>`, `hospital:<id>:<role>`, `partner:<id>`, `admin`); a client cannot join any other.
Each event reaches only the supplier, the receiver and the courier of that delivery (plus admins).

Messages are JSON `{ "event": "...", "data": { ... } }`:

| `event` | `data` | Use |
|---|---|---|
| `journey.updated` | `{ journeyId, perspective, journey }`, where `journey` is exactly the §3 object for this user | replace the card with the same `id` |
| `telemetry` | `{ transferId, lat, long, temperatureC, sealStatus, excursion, loggedAt }` | live map dot |
| `excursion` | `{ transferId, temperatureC, range, message, quarantineSuggested, hospitals }` | optional banner (also arrives as an alert + `journey.updated`) |
| `replan` | `{ transferId, distanceKm, etaMin, open, note }` | redraw the route |
| `status` | `{ transferId, status, message }` | optional |
| `alert` | `{ hospitalId, kind, severity, message, ref }` | refresh `GET /me/home` |

```js
const ws = new WebSocket(`wss://${location.host}/ws/tracking`);
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
"No medicine on the move for you right now." · "No pickups assigned to you right now." ·
"All your critical drugs are covered for the next 14 days." · "No hospital in the city is short right now."

---

## 12. Admin

- `GET /health/integrations` → `{ summary, approvalMode, llmProvider, items: [{ service, status: connected|fallback|misconfigured, mode, text }] }`, e.g. "SAP Build Process Automation — fallback — MediLink runs approvals and the 30-minute timer itself (APPROVAL_MODE=cap)."
- `GET /admin/metrics` → `{ metrics: [{ id, label, value, unit, target, met, count, text }] }` for alert lead time, request-to-acceptance time, flagged lots moved (must stay 0), temperature-trace completeness and onboarding time.

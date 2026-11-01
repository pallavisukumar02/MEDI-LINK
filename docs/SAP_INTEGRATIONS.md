# Optional SAP integrations

MediLink is built on SAP CAP and runs fully without any SAP service. Four SAP services can be switched on, **one at a time,
by environment variables only** (`backend/.env` or the host's environment). Each needs its own SAP service instance on a
**free plan** (AI Core, Build Process Automation and Alert Notification live in an SAP BTP subaccount; MediLink itself does
not run on BTP). Never pick a paid plan.

> **Prepared, not verified against a real SAP account.** The code paths, configuration checks and fallbacks are tested offline
> (`npm test`, with fakes). SAP menu labels change: expect small differences.

After each switch: restart MediLink, run `npm run env:check`, then open `GET /health/integrations` as admin. Each item shows
`connected` (configured), `fallback` (off, built-in way used) or `misconfigured` (switched on but incomplete; MediLink keeps
using the fallback). "connected" for AI, BPA and Alert Notification means configured: the check does not call them.

| Integration | Switch on | Used for | When off |
|---|---|---|---|
| [SAP Business Accelerator Hub sandbox](#1-sap-business-accelerator-hub-sandbox) | `SAP_API_HUB_KEY` | Stock + batches of the "SAP hospital" (H2) | Offline copy `seed/sap-sandbox-fixture.json` |
| [SAP AI Core](#2-sap-ai-core-generative-ai-hub) | `LLM_PROVIDER=aicore` | Photo reading, alert parsing, note and plan wording | Templates; photo reading and alert parsing off |
| [SAP Build Process Automation](#3-sap-build-process-automation) | `APPROVAL_MODE=bpa` | Supplier answer, sign-offs, 30-minute timer | Built-in CAP workflow and timer |
| [SAP Alert Notification](#4-sap-alert-notification) | `ALERT_NOTIFICATION_URL` | Every alert to Alert Notification channels | In-app + SMTP email |

---

## 1. SAP Business Accelerator Hub sandbox

Not a BTP service: a free key from api.sap.com.

1. api.sap.com → log in → **Settings → Show API Key** → copy.
2. Open the *Material Stock* and *Batch* APIs (S/4HANA Cloud) and confirm the paths with **Try out**.

| Variable | Value |
|---|---|
| `SAP_API_HUB_KEY` | the key (sent as `APIKey` header) |
| `SAP_API_HUB_SANDBOX_BASE` | `https://sandbox.api.sap.com/s4hanacloud` (default) |
| `SAP_API_MATERIAL_STOCK_PATH`, `SAP_API_BATCH_PATH` | defaults in `backend/.env.example`; change only if Try out shows other paths |

Check: "SAP Business Accelerator Hub (sandbox): connected". If the sandbox is down, MediLink falls back to the offline copy.

## 2. SAP AI Core (generative AI hub)

The LLM never decides a match or overrides a hard rule. Guards apply to every provider: a rewritten note that changes a
number or batch is discarded; photo rows whose batch is not in the transcription are dropped; photo rows are saved only after
the pharmacist confirms the preview.

1. Create an **SAP AI Core** instance (free / trial plan) and open **SAP AI Launchpad → Generative AI Hub**.
2. Deploy a chat model **with vision** (needed for stock-register photos; e.g. a GPT-4o family model) in resource group `default`.
3. Create a **service key** for the AI Core instance and save its JSON as `backend/aicore-key.json` (git-ignored).

| Variable | Value |
|---|---|
| `LLM_PROVIDER` | `aicore` |
| `AICORE_MODEL_NAME` | the model name you deployed |
| `AICORE_SERVICE_KEY_PATH` | `./aicore-key.json` (default; relative to `backend/`) |
| `AICORE_RESOURCE_GROUP` | `default` (default) |

CAP calls AI Core through the SAP Cloud SDK for AI (`@sap-ai-sdk/foundation-models`). The matcher writes its "why this plan"
text with the same variables: give its process `LLM_PROVIDER`, `AICORE_MODEL_NAME`, `AICORE_RESOURCE_GROUP` and
`AICORE_SERVICE_KEY_PATH` too (`npm run dev` passes `backend/.env` to it).

Check: "AI (LLM): connected", and the onboarding **photo** fallback is no longer greyed out. Missing model name or key file →
`misconfigured`. Not on SAP? `LLM_PROVIDER=openai-compatible` with `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` does the same.

## 3. SAP Build Process Automation

With `APPROVAL_MODE=bpa`, CAP starts a BPA process when a plan is chosen, and BPA drives the supplier answer, the approver
sign-off(s) and the 30-minute timer by calling MediLink back.

1. In the subaccount, **Boosters → Set up account for SAP Build Process Automation** (free plan).
2. Create a service key for the BPA instance. You need its API URL, token URL, client id and client secret.
3. MediLink must be reachable from BPA over HTTPS ([HOSTING.md](HOSTING.md)). Create a MediLink account with role `system`
   for BPA (admin: `POST /auth/users {"username":"bpa-prod","password":"…","role":"system"}`; the demo database has `bpa`).
   BPA calls MediLink with HTTP Basic as that account.
4. Model a process in SAP Build with this contract:

| Step | Call |
|---|---|
| Process start (CAP calls BPA) | `POST {BPA_API_URL}/workflow/rest/v1/workflow-instances` with `{definitionId, context}` (client-credentials token from `BPA_TOKEN_URL`); context = `GET /workflow/context(transfer=<id>)` |
| Supplier form result | `POST /workflow/supplierDecision` `{transfer, decision: ACCEPT\|DECLINE, qty, repaymentMode: IN_KIND\|LANDED_COST, reason, actor}` |
| Approver form result | `POST /workflow/approvalDecision` `{transfer, decision: APPROVE\|REJECT, reason, actor}` (twice when `requiresSecondSignoff`) |
| 30-minute timer boundary event | `POST /workflow/timeout` `{transfer}` → next-ranked supplier |

| Variable | Value |
|---|---|
| `APPROVAL_MODE` | `bpa` |
| `BPA_API_URL` | API base URL from the service key (CAP appends `/workflow/rest/v1/workflow-instances`) |
| `BPA_DEFINITION_ID` | the process definition ID |
| `BPA_TOKEN_URL` | OAuth token endpoint from the service key (CAP posts `grant_type=client_credentials`) |
| `BPA_CLIENT_ID`, `BPA_CLIENT_SECRET` | from the service key |

Behaviour: if starting the BPA process fails, that transfer stays on the built-in flow (logged). CAP's own timer skips
transfers a BPA instance owns. Known gap: cancelling a request does not cancel its BPA instance.

Check: "SAP Build Process Automation: connected"; any `BPA_*` missing → `misconfigured`, built-in approvals continue.

## 4. SAP Alert Notification

When `ALERT_NOTIFICATION_URL` is set, SAP Alert Notification **replaces SMTP** as the outbound channel (priority:
Alert Notification, then SMTP, then console). In-app alerts always stay. Every alert kind goes there, one event per hospital
per check.

1. Create an **Alert Notification** instance (free / lite plan).
2. Create a service key with Basic credentials (parameter `{"type": "BASIC"}`); it holds `url`, `client_id`, `client_secret`.
3. In Alert Notification create an action (e.g. email), a condition on **event type starting with `MediLink`**, and a
   subscription linking them.

| Variable | Value |
|---|---|
| `ALERT_NOTIFICATION_URL` | `url` from the service key (CAP posts to `{url}/cf/producer/v1/resource-events`) |
| `ALERT_NOTIFICATION_CLIENT_ID`, `ALERT_NOTIFICATION_CLIENT_SECRET` | `client_id`, `client_secret` |

Event MediLink sends:

| Field | Value |
|---|---|
| `eventType` | `MediLink<KIND>` for one alert (`MediLinkSHORTFALL`, `MediLinkEXPIRED`, `MediLinkLOW_STOCK`, …), `MediLinkDIGEST` for several |
| `severity` / `category` | `ERROR` / `ALERT` if any alert is high, else `INFO` / `NOTIFICATION` |
| `subject`, `body` | `MediLink <KIND>`; the alert messages, one per line |
| `resource.tags` | `hospital` (e.g. `H5`), `ref` (single alert), `to` (that hospital's recipients: pharmacy staff emails, else its admin email, else `ALERT_EMAIL_TO`) |

Route per hospital with conditions on the `hospital` tag. Check: "SAP Alert Notification: connected"; URL set but id or
secret missing → `misconfigured`.

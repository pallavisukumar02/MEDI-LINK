# MediLink handover

Who this is for: the next developer. Read this, then `README.md` (commands, env vars), then `docs/EXPERIENCE_API.md`
(the contract a UI builds on) and `docs/SAP_GO_LIVE.md` (BTP set-up). The product spec is `docs/MediLink_PRD.md`;
sections 5, 6, 8–12 and 18 are binding.

## Rules (also in `CLAUDE.md`)

- Free SAP/BTP plans only. No Integration Suite, no Event Mesh, nothing paid.
- Never print, log or commit secrets. Config comes from `backend/.env` (git-ignored) or `cds bind` (`.cdsrc-private.json`).
- Development runs with no SAP credentials: SQLite, mocked users, `LLM_PROVIDER=none`, `APPROVAL_MODE=cap`, offline SAP fixture, straight-line distances.
- Patient names never enter MediLink; patient refs are `SHA-256(PATIENT_REF_HASH_SALT:mrn)` hashed at the source.
- All seed data is synthetic and labelled as such.
- No Docker, no database servers for development. Node, Python and the SAP CLIs only. Scripts are Node so they run in PowerShell and bash.
- Run `npm test` at the repo root after every change. All of it must stay green.

## Code map

| Where | What |
|---|---|
| `backend/db/schema.cds` | Data model (PRD §11) + support tables (`CoverSnapshots`, `Notifications`, `TokenVault`, `IdempotencyKeys`, `PhotoPreviews`, …) |
| `backend/srv/services.cds`, `impl.cds` | 16 CAP services (all `@requires`) and their handler files |
| `backend/srv/handlers/*.js` | Thin service handlers: authorisation checks, then call `lib/` |
| `backend/srv/lib/cover.js`, `coverdb.js` | Cover / shortfall / surplus engine (pure + DB) |
| `backend/srv/lib/rules.js`, `matching.js` | The 8 hard rules, ranking via the OR-Tools matcher (greedy fallback) |
| `backend/srv/lib/routing.js`, `geo.js` | ORS or Haversine routes with closures; `geo.distancesKm` = HANA `ST_Distance` on HANA, Haversine elsewhere |
| `backend/srv/lib/workflow.js` | Supplier accept/decline, approvals (second sign-off), 30-min fallback, BPA start |
| `backend/srv/lib/delivery.js`, `receipt.js`, `ledger.js` | Courier assignment, pickup, telemetry/excursions, re-plan; arrival + proof of condition; loans |
| `backend/srv/lib/notes.js` | Transfer note written on approval (template; LLM rewording only if numbers and batches are unchanged) |
| `backend/srv/lib/photo.js` | Stock-register photo: AI Core reads it → preview (batch-visibility guard) → confirm → normal ingest |
| `backend/srv/lib/llm.js` | SAP AI Core through the SAP Cloud SDK for AI (`@sap-ai-sdk/foundation-models`); `setClient` injects a fake in tests |
| **Experience layer** | |
| `backend/srv/lib/journey.js` | One plain-language journey per request (stages 1–7, colour, timeline), derived on every read for receiver / supplier / partner / admin |
| `backend/srv/lib/home.js` | `/me/home` (alerts, task cards from journeys, cover summary), `/me/onboarding` checklist, `/me/city` |
| `backend/srv/lib/actions.js` | Action descriptors (buttons as data) and the dispatcher registry; each action calls an existing CAP service as the user |
| `backend/srv/lib/messages.js` + `backend/_i18n/messages.properties` | Message catalogue: every error code → `{code, title, message, fix, retryable}`; all journey/home/task texts |
| `backend/srv/lib/http-routes.js` | Express routes behind CAP auth: `/me/*` (Idempotency-Key), `/health/integrations`, `/admin/metrics` |
| `backend/srv/lib/ws.js`, `handlers/tracking.js` | WebSocket push filtered per party (contexts), `journey.updated` |
| `backend/srv/lib/integrations.js`, `metrics.js` | Which SAP services are live/fallback/misconfigured; PRD §3 success metrics |
| `matcher/` | Python FastAPI + OR-Tools `POST /rank` |
| `connector/` | Python read-only DB connector; `seed_sqlite.py` builds the SQLite demo DB |
| `mock-medisoft/`, `simulator/` | Mock partner HIS (OAuth) and courier telemetry |
| `seed/generate.js` | Synthetic, date-relative seed for every component; `scale()` adds hospitals for performance tests |
| `scripts/` | `dev.js`, `demo.js`, `demo-experience.js`, `py.js` (cross-platform Python launcher) |
| `app/router/` | SAP app router for Cloud Foundry (XSUAA login, routes); the MTA build copies `frontend/` into `resources/` |
| `frontend/index.html` | Landing page (neumorphic grey + root beer, Three.js r128 blister pack, pill-bottle "How it works") |
| `frontend/app.html` | Sign-in (glass bottle, Three.js tablet pile with bounded physics) and the signed-in app: home, onboarding checklist in the bottle, journey detail, city, admin. Renders every button and form from the API's action descriptors; errors show title / message / fix, never the code |

## Tests (`npm test`)

| Suite | Covers |
|---|---|
| `backend/test/experience-e2e.test.js` | **Acceptance:** PRD §18 demo through `/me/*` only, as each demo user; journey stage, task cards and messages at every beat |
| `backend/test/experience-paths.test.js` | Side paths: decline → next supplier, reject with reason, no match → try again → cancel, recall → transfer cancelled, supplier silence; dispatcher (concurrent double tap, unknown action, bad JSON, auth) |
| `backend/test/messages.test.js` | Every error code raised in `srv/` has catalogue text; no jargon / IDs / rule numbers; language fallback |
| `backend/test/ws-filter.test.js` | Real WebSocket clients: events only reach the parties; `journey.updated` shape; clients cannot join other contexts |
| `backend/test/llm-and-switches.test.js` | Photo preview/confirm + guard, transfer-note guard, `/health/integrations`, `APPROVAL_MODE=bpa` / `LLM_PROVIDER=aicore` misconfigured but working |
| `backend/test/hana-compat.test.js` | HANA DDL, every captured query rendered as HANA SQL, SQLite-only lint, timestamp comparisons, spatial switch |
| `backend/test/perf.test.js` | 50 hospitals: board < 2 s, ranking < 10 s (OR-Tools), `/me/home` < 1 s |
| `backend/test/deployment.test.js` | mta.yaml free plans, app router + XSUAA + destination wiring, xs-app.json routes |
| older suites | cover, rules, routing, audit chain, onboarding/ingest, workflow/ledger, delivery, receipt, trust feed, security, original e2e |
| `matcher/tests`, `connector/tests`, `mock-medisoft/test`, `simulator/test` | Python and Node component tests (connector now reads the seed DB on SQLite, no skips) |

Counts at handover: backend Jest 122, mock-medisoft 3, simulator 5, matcher 12, connector 8 = **150, all passing, none skipped** (Windows 11).

## Decisions made in the experience layer

- **Journeys are derived, never stored.** A journey is the request plus its transfers seen from one side. With several legs it moves at the pace of the slowest active leg.
- **Stage 6 "Arrived"** = an in-transit delivery whose last GPS fix is within 500 m of the receiver, or whose ETA has passed. Receivers can still scan earlier (the scan button is on the journey from stage 5).
- **Tasks come from journeys** (one primary + one optional secondary button), so a card and its journey never disagree. Stage-1 shortfall journeys exist only for red drugs with no live request.
- **"Find a supplier again"** re-ranks without the hospitals that already said no, timed out or were rejected for that request (additive `excludeRefused` parameter on `RequestService.rank`). A recalled transfer's supplier is not excluded (it may have other safe stock).
- **Idempotency:** `Idempotency-Key` + user + action are hashed into `IdempotencyKeys`; stored responses replay, a still-running key returns `409 ACTION_IN_PROGRESS`. Without a key, `send-request` returns the live request for the same medicine instead of creating a second one.
- **Photo rows** are ingested as source `SHEET` (a photo is another way to send the daily stock sheet), only after the pharmacist confirms the server-held preview; the client cannot edit rows in between.
- **Errors** are mapped by code to the catalogue; parameters (licence number, expiry date, max quantity, batch) are filled by the dispatcher where it knows them.

## Known limitations

- **UI sign-in is a mock** of `POST /auth/login` (`frontend/app.html`, `authLogin`, one-line swap once the endpoint exists): it accepts the development demo users with password `demo` and then calls `/me/home` with Basic auth. Behind the app router (any non-localhost host) the page skips it and uses the SAP login session.
- The UI refreshes by polling `/me/home` every 10 s in development; it does not open the WebSocket there, because browsers cannot send the Basic header on a WebSocket upgrade. Behind the app router the session cookie would allow it (not wired yet).
- Hybrid/CF browser checks were not possible here; the UI was verified in headless Chrome on this PC (layout centring at 390×844, 1024×768, 1440×900, 1920×1080, onboarding through MediSoft Allow, actions, no console errors).

- `IdempotencyKeys` rows are never cleaned up (marked `shortcut:` in `http-routes.js`); add a daily cleanup job before real traffic.
- A `journey.updated` pushed to all approvers of a hospital still shows **Approve** to the one who already signed; tapping it gives the friendly "A second person must sign". `GET /me/home` is exact.
- CAP registers handlers of a dotted event under its last segment, so `ws.js` emits `updated` to publish `journey.updated` (comment in code; `ws-filter.test.js` fails if CAP changes this).
- Only English text exists; Kannada / Hindi bundles still need translating.
- On Windows, stopping `npm run dev` with Ctrl+C now kills the whole process tree (`taskkill /T`); this path was code-reviewed but not exercised by a real Ctrl+C in this session.
- Linux was not run in this session (the code is POSIX-safe: Node scripts, `path`, no shell syntax); run `npm test` once on Linux.

## Prepared, not verified against real SAP (no account yet)

| Item | State |
|---|---|
| SAP HANA Cloud | Model compiles to HANA DDL; every query renders as HANA SQL (`test:hana-compat`). Not run on a live instance. |
| HANA spatial `ST_Distance` | Query text and switch tested with a stubbed HANA; real results unverified. |
| XSUAA, app router, role collections | Config tested statically (`deployment.test.js`); no login performed. |
| Destination service token store | Code path exists since round 1; unverified. |
| SAP Build Process Automation | `APPROVAL_MODE=bpa` start call + REST contract; misconfiguration reported and CAP fallback proven; no real BPA process. |
| SAP AI Core via SAP Cloud SDK for AI | `@sap-ai-sdk/foundation-models` `AzureOpenAiChatClient` wired for chat + vision; all LLM features tested with an injected fake; no real model call. |
| SAP Alert Notification | Producer call exists; no binding tested. |
| SAP Business Accelerator Hub sandbox | Offline fixture used; live sandbox unverified. |
| `mbt build` / `cf deploy` | Not run (no CF account, `mbt`/`make` not installed here). |
| HANA Cloud performance | Not measured (SQLite numbers in README §10). |

## How to continue

1. Follow `docs/SAP_GO_LIVE.md` Part 1–3, run `npm run test:hana-compat` and `npm run demo:experience` in hybrid mode.
2. Build the UI on `docs/EXPERIENCE_API.md` (UI5 / Fiori in `app/`, served by the app router).
3. Translate `backend/_i18n/messages.properties` to `messages_kn.properties` and `messages_hi.properties`.

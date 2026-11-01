# MediLink

Critical-drug shortfall detection and safe inter-hospital transfer for Bengaluru hospitals.
SAP Hackfest 2026 prototype, built on **free** SAP BTP services only. Product spec: [`docs/MediLink_PRD.md`](docs/MediLink_PRD.md).

**Building a UI?** Start with [`docs/EXPERIENCE_API.md`](docs/EXPERIENCE_API.md): a handful of `/me/*` calls give every user their home screen,
one plain-language journey per request and self-describing buttons. **Going live on SAP BTP?** Follow [`docs/SAP_GO_LIVE.md`](docs/SAP_GO_LIVE.md).
**Taking over the code?** Read [`HANDOVER.md`](HANDOVER.md).

> **All data in this repo is synthetic.** Hospital names, stock, batches, licences and patients are invented;
> hospital coordinates are real Bengaluru localities. Patient names never enter MediLink: patient refs are
> `SHA-256(PATIENT_REF_HASH_SALT:mrn)`, hashed at the source (MediSoft, connector).

---

## 1. Repo layout

| Folder | What it is | Tech |
|---|---|---|
| `backend/` | CAP service: cover, onboarding/OAuth client, ingestion, hard rules, workflow, delivery, receipt, ledger, audit, trust feed | SAP CAP (Node.js, CDS), SQLite (dev) / HANA Cloud (hybrid, prod) |
| `backend/db/` | `schema.cds` (PRD §11 data model) + synthetic seed CSVs in `db/data/` | CDS |
| `backend/srv/` | `services.cds` (16 services, all with `@requires`), handlers, `lib/` business logic, `server.js` (REST endpoints) | |
| `backend/srv/lib/{journey,home,actions,messages,http-routes}.js` | Experience layer: `/me/*` (journeys, home inbox, onboarding checklist, actions as data, plain-language errors) | CAP + Express |
| `backend/_i18n/messages.properties` | Every user-facing text and error message (CAP i18n bundle; add `_kn` / `_hi` files to translate) | |
| `backend/test/` | Jest: unit + integration + PRD §18 end-to-end | Jest, `@cap-js/cds-test` |
| `matcher/` | `POST /rank`: plan ranking with Google OR-Tools CP-SAT | Python, FastAPI |
| `mock-medisoft/` | Mock partner HIS "MediSoft": login, consent screen, OAuth 2.0 auth-code + token endpoints, `/stock`, `/schedule` | Node, Express |
| `connector/` | Read-only connector for an in-house pharmacy DB: pairing code, SQLAlchemy over 2 views (any SQLAlchemy URL), hashes MRNs, pushes to `/ingest`. Demo DB = SQLite file built by `seed_sqlite.py` | Python |
| `simulator/` | Delivery-partner telemetry (GPS + temperature), one deliberate excursion | Node (no dependencies) |
| `seed/` | `generate.js` (date-relative synthetic seed for every component), SAP sandbox offline fixture, sample sheet, sample CDSCO-style alert | Node |
| `scripts/` | `dev.js` (`npm run dev`), `demo.js` (`npm run demo`), `demo-experience.js` (`npm run demo:experience`) | Node |
| `frontend/` | The UI, no build step: `index.html` (landing page, 3D blister pack) and `app.html` (sign-in with the 3D tablet bottle, then home / onboarding / journey / city / admin on the `/me/*` API). Served by CAP in development, by the app router on Cloud Foundry | HTML, CSS, vanilla JS, Three.js r128 |
| `app/router/` | SAP app router: single URL, XSUAA login, forwards `/me`, `/odata`, `/ws` … to CAP, serves future UI apps from `resources/` | `@sap/approuter` |
| `mta.yaml`, `secrets.mtaext.example` | Cloud Foundry deployment (free plans) | MTA |
| `docs/` | PRD, `EXPERIENCE_API.md` (UI contract), `SAP_GO_LIVE.md` (click-by-click BTP checklist) | |

## 2. Prerequisites

- Node.js 20+ and `npm i -g @sap/cds-dk` (gives `cds` and `cds bind`)
- Python 3.11+
- No Docker, no database server: development uses in-memory SQLite and the connector demo uses a SQLite file
- For deployment only: Cloud Foundry CLI v8 (`cf`) with the MultiApps plugin (`cf install-plugin multiapps`), and `npm i -g mbt`

## 3. Quick start (development profile: no SAP credentials)

```bash
npm run setup                 # npm install in backend, mock-medisoft, simulator + pip install matcher & connector deps
cp backend/.env.example backend/.env   # Windows: copy backend\.env.example backend\.env
#   then in backend/.env set LLM_PROVIDER=none and replace every change-me-random-32-chars (openssl rand -hex 16)
npm run dev                   # CAP :4004 + matcher :5001 + mock MediSoft :4100 + simulator
npm run demo                  # in a second terminal: runs the PRD §18 3-minute demo script against the running stack
# or, after restarting npm run dev:
npm run demo:experience       # the same demo through /me/* only, printing each user's home screen at every beat
```

**The UI:** with `npm run dev` running open http://localhost:4004/ (landing page) and http://localhost:4004/app.html (sign in).
On the sign-in page the *Demo Role* links fill in a demo account: **Pharmacist** = `ravi` (Banashankari, supplier side),
**Admin** = `admin`, **Unconnected** = `asha` (City Cancer Hospital, starts onboarding). Any demo user works as `<name>@anything` with password `demo`
(`meera`, `kiran`, `partner`, `lata`, …). Sign-in is a mock of `POST /auth/login` (not in the API yet); on Cloud Foundry the app router's SAP login replaces it.

`npm run dev` uses SQLite in memory, mocked users and `LLM_PROVIDER=none` behaviour, so it needs **no** SAP account.
The database resets on every restart: **restart `npm run dev` before running `npm run demo` again.**
Without a `backend/.env` everything still runs on built-in dev defaults.

### Demo users (mocked, development/hybrid/test only; password `demo` for all)

| User | Role | Acts for |
|---|---|---|
| `asha` | pharmacist | H1 City Cancer Hospital, Jayanagar (onboards live via MediSoft) |
| `sunil` | pharmacist | H2 Sanjeevani Hospital, Whitefield (SAP sandbox) |
| `lata` | pharmacist | H3 Lakeside Oncology Centre, Koramangala (DB connector) |
| `hari` | pharmacist | H4 Hebbal Community Hospital (sheet upload; **expired licence**) |
| `ravi` | pharmacist | H5 Banashankari Care Hospital (MediSoft; near-expiry donor) |
| `meera`, `kiran` | approver | H5 (two people, for the second sign-off) |
| `anil` / `deepa` | approver | H2 / H1 |
| `partner`, `sim` | partner | P1 CoolRoute Logistics (cold-chain certified) |
| `courier2` | partner | P2 QuickMeds Couriers (ambient only) |
| `bpa` | system | SAP Build Process Automation technical user |
| `admin` | admin | everything |

MediSoft login (inside the mock HIS consent popup): `pharm.jayanagar` / `medisoft-demo` (H1), `pharm.banashankari` / `medisoft-demo` (H5).

### Licence numbers for onboarding

`KA-BLR-20B-1001` (H1, MediSoft, Allow flow) · `KA-BLR-20B-1002` (H2, SAP) · `KA-BLR-20B-1003` (H3, connector → pairing code) ·
`KA-BLR-20B-1004` (H4, **expired → refused**) · `KA-BLR-20B-1005` (H5, MediSoft).

## 4. Every command

| Command (repo root) | What it does |
|---|---|
| `npm run setup` | Install all Node + Python dependencies |
| `npm run seed` | Regenerate the date-relative synthetic seed (CAP CSVs, MediSoft data, connector SQL, SAP fixture). Runs automatically in dev when stale |
| `npm run dev` | Start CAP + matcher + mock MediSoft + simulator (`--no-sim`, `--no-matcher` to skip one) |
| `npm run demo` | Run the PRD §18 demo script against the running dev stack |
| `npm run demo:experience` | The same demo through the experience layer (`/me/*`) only; prints every user's home screen in plain language |
| `npm test` | All test suites (backend Jest incl. experience e2e, HANA compatibility and 50-hospital performance; mock-medisoft, simulator, matcher pytest, connector pytest) |
| `npm run test:hana-compat` | HANA readiness without an account: model → HANA DDL, every query the app runs rendered as HANA SQL, SQLite-only lint, spatial switch |
| `npm run test:backend` / `test:medisoft` / `test:simulator` / `test:matcher` / `test:connector` | One suite |
| `npm run connector:seed` | Build the demo "Hospital C" pharmacy database as `connector/hospital_c.db` (SQLite, from the generated seed SQL) |
| `npm run seed -- --hospitals 50` | Seed 45 extra synthetic hospitals (scale tests). Run plain `npm run seed` to return to the 5-hospital demo set |
| `npm run connector:run` | Run the connector loop (`cd connector && python connector.py`) |
| `npm run watch:hybrid` | `cds watch --profile hybrid` against bound HANA Cloud |
| `npm run build:mta` | `mbt build -t mta_archives` |
| `npm run deploy:cf` | `cf deploy mta_archives/medilink_1.0.0.mtar` (add `-e secrets.mtaext`, see §7) |

| Command (`backend/`) | |
|---|---|
| `npm run start:dev` | CAP only, development profile |
| `npm test` / `npm run test:unit` | All Jest tests / pure unit tests only |
| `cds deploy --to hana --profile hybrid` | Deploy schema + seed to the bound HDI container |
| `npm run build` | `cds build --production` → `backend/gen/` |

| Connector (`connector/`) | |
|---|---|
| `python connector.py --pair <CODE>` | Exchange the one-time pairing code (from onboarding with licence `KA-BLR-20B-1003`) for a token |
| `python connector.py --once` / `--dry-run` / *(no flag = loop)* | One sync / read+hash without pushing / sync every `CONNECTOR_SYNC_INTERVAL_SEC` |

### Connector demo (database path, no Docker)
```bash
npm run connector:seed                                # SQLite file connector/hospital_c.db from seed/init.sql (opened read-only)
# with npm run dev running, onboard H3 as lata to get a pairing code:
curl -u lata:demo -H "Content-Type: application/json" -d "{\"licenceNo\":\"KA-BLR-20B-1003\"}" http://localhost:4004/onboarding/licence
cd connector && python connector.py --pair <pairingCode> --once
```

## 5. Environment variables

All live in `backend/.env` (git-ignored; template `backend/.env.example`). SAP service credentials are **not** env vars:
they come from `cds bind` (`.cdsrc-private.json`) or Cloud Foundry bindings. Every variable has a safe dev default.

**App & BTP (reference)**: `NODE_ENV`, `PORT` (4004), `APP_BASE_URL`, `CDS_ENV`, `BTP_GLOBAL_ACCOUNT_SUBDOMAIN`, `BTP_SUBACCOUNT_SUBDOMAIN`, `BTP_REGION`, `CF_API_ENDPOINT`, `CF_ORG`, `CF_SPACE`, `HANA_INSTANCE_NAME`, `HDI_CONTAINER_SERVICE` (names only, used by the README commands)

| Variable | Default | Used by / meaning |
|---|---|---|
| `SAP_API_HUB_KEY` | *(empty)* | SAP Business Accelerator Hub key (`APIKey` header). Empty = offline fixture `seed/sap-sandbox-fixture.json` |
| `SAP_API_HUB_SANDBOX_BASE`, `SAP_API_MATERIAL_STOCK_PATH`, `SAP_API_BATCH_PATH` | see template | Sandbox stock / batch OData paths |
| `MEDISOFT_BASE_URL` | `http://localhost:4100` | Mock HIS URL (CAP) |
| `MEDISOFT_OAUTH_CLIENT_ID`, `MEDISOFT_OAUTH_CLIENT_SECRET` | `medilink-client`, dev value | OAuth client (CAP **and** mock-medisoft read the same values) |
| `MEDISOFT_OAUTH_REDIRECT_URI` | `…:4004/oauth/medisoft/callback` | OAuth redirect |
| `MEDISOFT_SCOPES` | `stock.read schedule.read` | Read-only scopes requested |
| `MEDISOFT_PORT`, `MEDISOFT_ALLOWED_REDIRECTS` | 4100, redirect URI | mock-medisoft listen port / allowed redirect URIs (comma separated) |
| `CONNECTOR_DB_URL` | `sqlite:///connector/hospital_c.db` | Connector source DB: any SQLAlchemy URL (`postgresql://`, `mysql+pymysql://`, `mssql+pyodbc://` …); relative SQLite paths are under the repo and opened read-only. `CONNECTOR_PG_URL` is still read as a fallback; `connector/seed/readonly.sql` = least-privilege PostgreSQL role for real hospitals |
| `CONNECTOR_INGEST_URL` | `http://localhost:4004/ingest` | Connector push target |
| `CONNECTOR_SYNC_INTERVAL_SEC` | 900 | Connector loop interval |
| `CONNECTOR_TOKEN_FILE`, `CONNECTOR_HTTP_TIMEOUT_SEC` | `connector/.connector-token`, 30 | Where the paired token is stored (0600) / HTTP timeout |
| `CONNECTOR_PAIRING_SECRET` | dev value | HMAC key for stored pairing-code hashes (CAP) |
| `MATCHER_URL`, `MATCHER_TIMEOUT_MS` | `http://localhost:5001`, 10000 | OR-Tools service |
| `MATCHER_TOKEN` | *(empty)* | Shared secret CAP sends as `X-Matcher-Token`; set on both sides when deployed |
| `MATCHER_FALLBACK_ENABLED` | true | If the matcher is down, CAP ranks with a built-in greedy fallback |
| `ORS_API_KEY`, `ORS_BASE_URL` | *(empty)* | OpenRouteService; empty = Haversine × road factor |
| `ROAD_FACTOR`, `CITY_SPEED_KMH`, `ROUTE_HANDLING_MIN` | 1.3, 22, 20 | Haversine fallback distance/ETA model |
| `OPEN_METEO_BASE_URL`, `WEATHER_CHECK_ENABLED`, `WEATHER_CHECK_SEC`, `WEATHER_CLOSE_MM_PER_H` | see template, true, 600, 20 | Rain/flood check that re-plans routes |
| `LLM_PROVIDER` | `none` | `aicore` or `none`. **Everything works with `none`** (template explanations, manual flags) |
| `AICORE_RESOURCE_GROUP`, `AICORE_MODEL_NAME`, `AICORE_SERVICE_KEY_PATH` | `default`, *(empty)*, `./aicore-key.json` | SAP AI Core generative AI hub |
| `TRUST_FEED_LLM_ENABLED` | true | Allow LLM parsing of CDSCO alerts (only effective when the LLM is enabled) |
| `APPROVAL_MODE` | `cap` | `cap` = CAP-native approval flow + timer; `bpa` = SAP Build Process Automation drives it |
| `BPA_API_URL`, `BPA_DEFINITION_ID`, `BPA_TOKEN_URL`, `BPA_CLIENT_ID`, `BPA_CLIENT_SECRET`, `BPA_DESTINATION` | *(empty)* | BPA workflow-instance API (only for `APPROVAL_MODE=bpa`) |
| `ALERT_NOTIFICATION_ENABLED`, `ALERT_EMAIL_TO` | false | SAP Alert Notification (optional); otherwise in-app notifications only |
| `DEFAULT_SAFETY_MARGIN_PCT`, `DEFAULT_COVER_WINDOW_DAYS` | 20, 14 | Cover defaults (overridable per hospital) |
| `EXPIRY_BUFFER_DAYS`, `NEAR_EXPIRY_DAYS` | 7, 60 | Rule 4 buffer / near-expiry threshold |
| `SUPPLIER_RESPONSE_TIMEOUT_MIN`, `TIMER_SWEEP_SEC` | 30, 60 | Supplier silence → next supplier |
| `LONG_ROUTE_KM`, `LONG_ROUTE_MIN` | 25, 90 | Second sign-off "long route" risk rule |
| `SYNC_INTERVAL_SEC`, `STALE_FEED_MINUTES`, `LICENCE_REMINDER_DAYS` | 900, 60, 30 | Recompute/sync job, stale-feed greying, licence reminders |
| `COLD_CHAIN_MIN_C`, `COLD_CHAIN_MAX_C`, `AMBIENT_MIN_C`, `AMBIENT_MAX_C`, `FROZEN_MIN_C`, `FROZEN_MAX_C` | 2, 8, 2, 30, -25, -15 | Storage ranges for excursions |
| `TRACE_MAX_GAP_MIN` | 15 | Max gap in the temperature trace for proof of condition |
| `PATIENT_REF_HASH_SALT` | dev value | Salt for hashing MRNs at source (mock-medisoft, connector) |
| `TOKEN_STORE`, `TOKEN_STORE_KEY` | auto, *(derived)* | `local` (AES-256-GCM table, dev) or `destination` (BTP Destination service); auto = destination if bound. Set `TOKEN_STORE_KEY` to keep local tokens across restarts |
| `JOBS_ENABLED`, `DEMO_FRESH_SEED` | true, true | Background jobs / mark seeded hospitals freshly synced at dev start |
| `APP_TIME_ZONE` | `Asia/Kolkata` | Time zone for times shown to users ("arriving ~3:40 pm") |
| `SEED_AUTO_REFRESH`, `SEED_ANCHOR_DATE` | true, today | Re-run the seed when the date changes / pin the seed date (YYYY-MM-DD) |
| `SIM_TELEMETRY_INTERVAL_SEC`, `SIM_EXCURSION_ENABLED`, `SIM_EXCURSION_AFTER_TICKS`, `SIM_SPEEDUP` | 5, true, 3, 10 | Simulator cadence / one deliberate excursion / speed |
| `SIM_USER`, `SIM_PASSWORD`, `SIM_BEARER_TOKEN` | `sim`, `demo`, *(empty)* | Simulator credentials (bearer token for a deployed app) |
| `PYTHON` | auto | Python executable for `npm run dev` / e2e test |

## 6. Hybrid mode (bound SAP HANA Cloud)

Click-by-click, from an empty BTP account: [`docs/SAP_GO_LIVE.md`](docs/SAP_GO_LIVE.md). Short version, after the HANA Cloud
`hana-free` instance is mapped to your CF space:
```bash
cf login -a <CF_API_ENDPOINT>
cf create-service hana hdi-shared medilink-db
cf create-service destination lite medilink-destination
cd backend
cds bind -2 medilink-db
cds bind -2 medilink-destination
cds deploy --to hana --profile hybrid
cds watch --profile hybrid
```
Hybrid keeps the **mocked users** (so you can log in locally with the demo users) but uses HANA Cloud (straight-line distances via
HANA `ST_Distance`) and stores OAuth tokens in the Destination service. XSUAA is created by the deployment (§7), not here. HANA Cloud free tier auto-stops when idle: start it in HANA Cloud Central before working.

## 7. Deploy to Cloud Foundry (free plans only)

```bash
npm run seed                                   # refresh the date-relative seed right before building
cp secrets.mtaext.example secrets.mtaext       # fill in random values; never commit it
mbt build -t mta_archives
cf deploy mta_archives/medilink_1.0.0.mtar -e secrets.mtaext
```
Deploys `medilink-approuter` (the one URL users open: XSUAA login, forwards to CAP incl. WebSockets, serves future UI apps, 128 MB),
`medilink-srv` (CAP, 256 MB), `medilink-db-deployer` (HDI, runs once), `medilink-matcher` (Python, 512 MB),
`medilink-medisoft` (mock HIS, 128 MB) and creates/binds `hana/hdi-shared`, `xsuaa/application`, `destination/lite`.
Check the result with `GET /health/integrations` as an admin.
Production uses **XSUAA** (no mocked users). Run the simulator locally against the deployed app with
`APP_BASE_URL=https://<srv-url> SIM_BEARER_TOKEN=<token of a partner user> node simulator/index.js`.

## 8. SAP Build Process Automation contract (or use the CAP-native fallback)

`APPROVAL_MODE=cap` (default) needs nothing: CAP runs supplier accept/decline, approver sign-off with second sign-off,
and the 30-minute fallback timer itself. To let BPA drive it, set `APPROVAL_MODE=bpa` and model a process that calls
the MediLink REST API with a technical user holding the `system` scope (a client-credentials token of `medilink-uaa`):

| Step | Call |
|---|---|
| Process start (CAP calls BPA) | `POST {BPA_API_URL}/workflow/rest/v1/workflow-instances` with `{definitionId, context}`; context = `GET /workflow/context(transfer=<id>)` |
| Supplier form result | `POST /workflow/supplierDecision` `{transfer, decision: ACCEPT\|DECLINE, qty, repaymentMode: IN_KIND\|LANDED_COST, reason, actor}` |
| Approver form result | `POST /workflow/approvalDecision` `{transfer, decision: APPROVE\|REJECT, reason, actor}` (call twice when `requiresSecondSignoff`) |
| 30-minute timer boundary event | `POST /workflow/timeout` `{transfer}` → next-ranked supplier |

## 9. API overview

**Experience layer (for UIs): `GET /me/home` · `GET /me/onboarding` · `GET /me/journeys/{id}` · `GET /me/city` · `POST /me/actions/{actionId}`**
(Idempotency-Key aware) and the WebSocket event `journey.updated`; full contract in [`docs/EXPERIENCE_API.md`](docs/EXPERIENCE_API.md).
Admin: `GET /health/integrations` (which SAP services are connected / on fallback / misconfigured) · `GET /admin/metrics` (PRD §3 success metrics).

Underlying services:

OData v4 under `/odata/v4/<service>`; REST services at their own paths. Highlights:
`POST /onboarding/licence` · `GET /oauth/medisoft/callback` · `POST /onboarding/revokeAccess` · `POST /connector/pair` · `POST /ingest` (connector token) ·
`POST /sync/uploadSheet` · `POST /sync/uploadPhoto` (stock-register photo, LLM; preview then confirm) · `POST /sync/syncNow` · `cover/board(window=7|14|21)` · `cover/shortfall(drug=…)` · `cover/cityView` ·
`requests/createRequest` · `requests/rank` · `requests/choosePlan` · `supplier/review|accept|decline` · `approval/approveTransfer|rejectTransfer` ·
`delivery/pickupScan|telemetry|activeShipments` · `routes/setRouteClosed|checkWeather` · `receipt/arrivalScan` · `ledger/settleLoan` ·
`GET /audit/verify` · `trust/recall|parseAlert` · WebSocket `ws://<host>/ws/tracking` (events `telemetry`, `excursion`, `replan`, `status`, `alert`, `journey.updated`; each user only receives their own deliveries) ·
matcher `POST /rank`. Every hard-rule exclusion is returned as `{rule, ruleName, code, detail}`.

## 10. Performance (PRD §12, 50 hospitals)

Measured by `backend/test/perf.test.js` (part of `npm test`): 5 demo + 45 synthetic hospitals (`seed/generate.js` `scale()`),
real OR-Tools matcher, in-memory SQLite, end-to-end HTTP, Windows 11 laptop, 1 Nov 2026.

| Call | Target | Measured (best / worst of 3-5 runs) |
|---|---|---|
| Cover board `cover/board(window=14)` | < 2 s | 25 ms / 114 ms |
| Plan ranking `requests/rank` incl. forced re-sync, OR-Tools CP-SAT, 20+ eligible lots | < 10 s | 250 ms / 277 ms |
| Home screen `GET /me/home` (pharmacist with an active journey) | < 1 s | 36 ms / 95 ms |
| Home screen `GET /me/home` (admin, all journeys) | < 1 s | 26 ms / 32 ms |
| City view `GET /me/city` over 50 hospitals | < 2 s | 68 ms / 84 ms |

Nothing needed fixing. HANA Cloud latency is not measured here (no account yet).

## 11. Interpretation choices (where the PRD left room)

- Cover window = today + next N−1 days; a lot covers a dose only if it expires **strictly after** the dose date; allocation is earliest-expiry-first (exact for this deadline structure).
- Safety margin = `ceil(booked × pct / 100)` on own booked demand; surplus is 0 while any own dose is short.
- "Licence valid on transfer date" uses today's date; rule 8 compares ETA with end of the needed-by day (UTC).
- A stale supplier feed excludes its lots (`STALE_FEED`, reported under rule 1).
- Lowering the offered quantity trims the longest-expiry lots first and routes the remainder to the next supplier.
- Second sign-off must be a different approver than the first.
- Landed cost = quantity × drug unit cost (synthetic INR); the real formula is a PRD open question.

## 12. Manual steps you still have to do

1. BTP cockpit work from [`docs/SAP_GO_LIVE.md`](docs/SAP_GO_LIVE.md) (account, entitlements, HANA Cloud instance + mapping, boosters). Cannot be scripted from here.
2. Fill `backend/.env` (random secrets; `LLM_PROVIDER=none` unless AI Core is set up) and, for deployment, `secrets.mtaext`.
3. Optional keys: SAP Business Accelerator Hub API key (confirm the sandbox paths with *Try out*), OpenRouteService token.
4. After deploying: in BTP cockpit → Security → Roles, create roles from the `pharmacist` / `approver` templates with a `hospital` value (e.g. `H1`) and from `partner` with a `partner` value (e.g. `P1`), put them in role collections and assign users. `MediLink_Admin` is predefined.
5. Optional BPA: model the process in the BPA editor using the contract in §8, then set `APPROVAL_MODE=bpa` and the `BPA_*` variables.
6. Optional AI Core: download the service key to `backend/aicore-key.json`, set `LLM_PROVIDER=aicore` and `AICORE_MODEL_NAME`.
7. Before a demo: start HANA Cloud (it auto-stops), and rebuild/redeploy after `npm run seed` if the seed dates are old.

# MediLink

Critical-drug shortfall detection, stock and expiry monitoring, and safe inter-hospital transfer for Bengaluru hospitals.
SAP Hackfest 2026 prototype. **SAP CAP on one SQLite file, MediLink's own accounts, free software only**; no SAP BTP account needed.
SAP AI Core, SAP Build Process Automation, SAP Alert Notification and the SAP Business Accelerator Hub sandbox are optional
integrations, off by default.

| Read | For |
|---|---|
| [`docs/MediLink_PRD.md`](docs/MediLink_PRD.md) | Product spec (v1.1) |
| [`docs/EXPERIENCE_API.md`](docs/EXPERIENCE_API.md) | The `/me/*` API a UI builds on |
| [`docs/HOSTING.md`](docs/HOSTING.md) | Running it in production: disk, backups, HTTPS, secrets |
| [`docs/SAP_INTEGRATIONS.md`](docs/SAP_INTEGRATIONS.md) | Switching on the optional SAP services |
| [`HANDOVER.md`](HANDOVER.md) | Taking over the code |
| [`docs/AUDIT.md`](docs/AUDIT.md) | Audit of the code before this build, with status after it |

> **All data in this repo is synthetic.** Hospital names, stock, batches, licences and patients are invented;
> hospital coordinates are real Bengaluru localities. Patient names never enter MediLink: patient refs are
> `SHA-256(PATIENT_REF_HASH_SALT:mrn)`, hashed at the source (MediSoft, connector).

---

## 1. Quick start (zero set-up)

Needs **Node.js 22.12+** (SAP CAP 10 requires it) and **Python 3.11+**. No Docker, no database server, no SAP account.

```bash
npm run setup     # npm install in backend, mock-medisoft, simulator + pip install for matcher and connector
npm run dev       # CAP :4004 + matcher :5001 + mock MediSoft :4100 + courier simulator
```

On the first run `npm run dev` creates `backend/.env` from `backend/.env.example` with fresh random secrets (file mode 0600,
never printed; `DEMO_PASSWORD=demo`) and the database `backend/db/medilink.sqlite` with the synthetic seed and demo users.
The database **persists** across restarts. Start over with `npm run db:reset` (stop `npm run dev` first).

| Open | What |
|---|---|
| http://localhost:4004/ | Landing page |
| http://localhost:4004/app.html | Sign in as a demo user (password `demo`) |
| http://localhost:4004/health | `{ status, profile, synthetic, services }` |

Run the PRD §18 demo in a second terminal, on a fresh database (stop `npm run dev`, `npm run db:reset`, start it again):

```bash
npm run demo                # the 3-minute demo script, HTTP Basic as the demo users
npm run demo:experience     # the same demo through /me/* only, signing in with POST /auth/login; prints every home screen
```

### Demo users (synthetic; password = `DEMO_PASSWORD`, `demo` in development)

Only pharmacy staff and the admin sign in. Delivery partners (P1 CoolRoute Logistics, cold-chain; P2 QuickMeds Couriers, ambient) have
no accounts: each delivery gets a courier link ([`docs/EXPERIENCE_API.md`](docs/EXPERIENCE_API.md)).

| User | Role | Acts for |
|---|---|---|
| `asha` | pharmacist | H1 City Cancer Hospital, Jayanagar (onboards live via MediSoft; after connecting: gemcitabine out + an expired lot, doxorubicin low) |
| `sunil` | pharmacist | H2 Sanjeevani Hospital, Whitefield (SAP sandbox) |
| `lata` | pharmacist | H3 Lakeside Oncology Centre, Koramangala (DB connector) |
| `hari` | pharmacist | H4 Hebbal Community Hospital (sheet upload; **expired licence**) |
| `ravi` | pharmacist | H5 Banashankari Care Hospital (MediSoft; near-expiry donor; trastuzumab out + an expired lot, fluorouracil low, lots expiring in 5/25/85 days) |
| `meera`, `kiran` | approver | H5 (two people, for the second sign-off) |
| `anil` / `deepa` | approver | H2 / H1 |
| `bpa` | system | Technical user for the optional SAP Build Process Automation (API only, HTTP Basic) |
| `admin` | admin | everything |

MediSoft login (inside the mock HIS consent popup): `pharm.jayanagar` / `medisoft-demo` (H1), `pharm.banashankari` / `medisoft-demo` (H5).

Licence numbers for onboarding: `KA-BLR-20B-1001` (H1, MediSoft) · `KA-BLR-20B-1002` (H2, SAP) · `KA-BLR-20B-1003` (H3, connector → pairing code) ·
`KA-BLR-20B-1004` (H4, **expired → refused**) · `KA-BLR-20B-1005` (H5, MediSoft).

## 2. Repo layout

| Folder | What it is | Tech |
|---|---|---|
| `backend/` | CAP service: cover, stock and expiry monitoring, onboarding/OAuth client, ingestion, hard rules, workflow, delivery, receipt, ledger, audit, trust feed, accounts | SAP CAP 10 (Node.js, CDS), SQLite |
| `backend/db/` | `schema.cds` (PRD §11 data model) + synthetic seed CSVs in `db/data/`; the database file `medilink.sqlite` (git-ignored) | CDS |
| `backend/srv/` | `services.cds` (CAP services, all with `@requires`), handlers, `lib/` business logic, `server.js` (REST endpoints), `auth.js` (MediLink accounts) | |
| `backend/srv/lib/{journey,home,monitor,tracking,actions,messages,http-routes}.js` | Experience layer `/me/*`: journeys, home inbox, stock, notifications, live tracking, onboarding checklist, actions as data, plain-language errors | CAP + Express |
| `backend/srv/lib/courier.js` | Courier links and the public `/courier/*` endpoints (no sign-in) | Express |
| `backend/_i18n/messages.properties` | Every user-facing text and error message | |
| `backend/test/` | Jest: unit + integration + PRD §18 end-to-end | Jest, `@cap-js/cds-test` |
| `matcher/` | `POST /rank`: plan ranking with Google OR-Tools CP-SAT | Python, FastAPI |
| `mock-medisoft/` | Mock partner HIS "MediSoft": login, consent screen, OAuth 2.0 auth-code (PKCE) + token endpoints, `/stock`, `/schedule` | Node, Express |
| `connector/` | Read-only connector for an in-house pharmacy DB (any SQLAlchemy URL): pairing code, hashes MRNs, pushes to `/ingest`. Demo DB = SQLite file | Python |
| `simulator/` | Plays the courier through each delivery's courier link: pickup, GPS + temperature, one deliberate excursion | Node (no dependencies) |
| `seed/` | `generate.js` (date-relative synthetic seed for every component), SAP sandbox offline fixture, sample sheet, sample CDSCO-style alert | Node |
| `scripts/` | `dev.js`, `start.js`, `db.js`, `env-check.js`, `demo.js`, `demo-experience.js`, `py.js` (cross-platform Python launcher) | Node |
| `frontend/` | The UI, no build step, served by CAP: `index.html` (landing) and `app.html` (sign-in and the signed-in app on `/me/*`) | HTML, CSS, vanilla JS |
| `docs/` | PRD, experience API, hosting, SAP integrations, audit | |

## 3. Commands

| Command (repo root) | What it does |
|---|---|
| `npm run setup` | Install all Node + Python dependencies |
| `npm run dev` | Development: CAP + matcher + mock MediSoft + courier simulator (`npm run dev -- --no-sim` / `--no-matcher` skips one). Creates `backend/.env` and the database on first run |
| `npm start` | Production: the CAP server only, with `NODE_ENV=production`. Needs a filled `backend/.env` (or host variables) and a database from `npm run db:init`. Refuses to start while enabled demo accounts still use the password `demo`. Run the matcher separately ([`docs/HOSTING.md`](docs/HOSTING.md)) |
| `npm run db:init` | Create the SQLite database: schema + synthetic seed + demo users (password = `DEMO_PASSWORD`). Keeps an existing database; only adds missing demo users |
| `npm run db:reset` | Delete the database and create it again (**all data lost**; stop MediLink first). Needed after an update that adds columns (there are no migrations) |
| `npm run env:check` | Which variables are missing or too weak, and which optional integrations are on, in plain words; never prints values. Production rules when `NODE_ENV=production`. Exit code 1 if something required is missing |
| `npm run demo` / `npm run demo:experience` | PRD §18 demo against the running `npm run dev` stack, on a fresh database (§1) |
| `npm run seed` | Regenerate the date-relative synthetic seed. Runs by itself when stale (`npm run dev`, `db:init`) |
| `npm run seed -- --hospitals 50` | 45 extra synthetic hospitals for scale tests; plain `npm run seed` returns to the 5-hospital set |
| `npm test` | All suites: backend Jest, mock-medisoft, simulator, matcher pytest, connector pytest |
| `npm run test:backend` / `test:medisoft` / `test:simulator` / `test:matcher` / `test:connector` | One suite |
| `npm run connector:seed` | Build the demo "Hospital C" pharmacy database `connector/hospital_c.db` (SQLite) |
| `npm run connector:run` | Run the connector loop |

| Command (`backend/`) | |
|---|---|
| `npm start` | `cds-serve` (profile from `NODE_ENV`: development unless `production`) |
| `npm test` / `npm run test:unit` | All Jest tests / pure unit tests only |

| Connector (`connector/`) | |
|---|---|
| `python connector.py --pair <CODE>` | Exchange the one-time pairing code (onboarding with licence `KA-BLR-20B-1003`) for a token |
| `python connector.py --once` / `--dry-run` / *(no flag = loop)* | One sync / read + hash without pushing / sync every `CONNECTOR_SYNC_INTERVAL_SEC` |

Connector demo (database path):
```bash
npm run connector:seed
# with npm run dev running, onboard H3 as lata to get a pairing code:
curl -u lata:demo -H "Content-Type: application/json" -d "{\"licenceNo\":\"KA-BLR-20B-1003\"}" http://localhost:4004/onboarding/licence
cd connector && python connector.py --pair <pairingCode> --once
```

## 4. Profiles

| Profile | Selected by | Database | Demo users |
|---|---|---|---|
| `development` | default (`npm run dev`) | SQLite file `backend/db/medilink.sqlite` | created on a database without users (`DEMO_PASSWORD`) |
| `test` | Jest | SQLite in memory | created per run |
| `production` | `NODE_ENV=production` (`npm start` sets it) | SQLite file `backend/db/medilink.sqlite` | never created by the server; `db:init` creates them with a strong `DEMO_PASSWORD` |

Move the file with `CDS_REQUIRES_DB_CREDENTIALS_URL=/absolute/path/medilink.sqlite` (CAP reads it from the environment or `backend/.env`;
`npm run dev`, `db:init` and `db:reset` honour it). Keep it on a persistent disk: [`docs/HOSTING.md`](docs/HOSTING.md).

## 5. Environment variables

All in `backend/.env` (git-ignored; template `backend/.env.example`; `npm run dev` creates it) or the host's environment.
`npm run env:check` reports what is missing. The list the operator must supply for production is in [`HANDOVER.md` → ENV](HANDOVER.md#env).

**Required** (MediLink will not start without the first two; `env:check` flags the rest):

| Variable | Meaning |
|---|---|
| `AUTH_JWT_SECRET` | Signs login tokens. 32+ random characters; changing it signs everyone out |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for hospital OAuth tokens. 32+ random characters; keep it stable or hospitals must reconnect |
| `DEMO_PASSWORD` | Password of the demo users `db:init` creates (8+ characters in production) |
| `PATIENT_REF_HASH_SALT` | Salt for hashing patient numbers at the source (same value for MediSoft and the connector) |
| `MEDISOFT_OAUTH_CLIENT_SECRET` | OAuth client secret shared by CAP and MediSoft |
| `CONNECTOR_PAIRING_SECRET` | HMAC key for stored pairing-code hashes |

Make a random value: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**Everything else** (safe defaults):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 4004 | CAP port (hosts usually set it) |
| `APP_BASE_URL` | `http://localhost:4004` | Public URL of CAP: links in emails, OAuth callback page origin, connector set-up page |
| `AUTH_JWT_TTL` | `8h` | Login lifetime (`30m`, `8h`, `2d`, or seconds) |
| `TRUST_PROXY` | `false` | Express "trust proxy" behind a reverse proxy: hop count (`1`) or the proxy IPs/CIDRs, never `true`. Needed so rate limits see the client IP |
| `APP_TIME_ZONE` | `Asia/Kolkata` | Time zone of times shown to users |
| `CDS_REQUIRES_DB_CREDENTIALS_URL` | `db/medilink.sqlite` | Database file (§4) |
| `MEDISOFT_BASE_URL`, `MEDISOFT_OAUTH_CLIENT_ID`, `MEDISOFT_OAUTH_REDIRECT_URI`, `MEDISOFT_SCOPES` | `http://localhost:4100`, `medilink-client`, `…:4004/oauth/medisoft/callback`, `stock.read schedule.read` | Mock HIS OAuth client (CAP **and** mock-medisoft read the same values) |
| `MEDISOFT_PORT`, `MEDISOFT_ALLOWED_REDIRECTS` | 4100, the redirect URI | mock-medisoft only: listen port / allowed callback URLs (comma separated) |
| `CONNECTOR_DB_URL` | `sqlite:///connector/hospital_c.db` | Connector source DB, any SQLAlchemy URL (`postgresql://`, `mysql+pymysql://`, `mssql+pyodbc://`); `CONNECTOR_PG_URL` is read as a fallback |
| `CONNECTOR_INGEST_URL`, `CONNECTOR_SYNC_INTERVAL_SEC` | `http://localhost:4004/ingest`, 900 | Connector push target / loop interval |
| `CONNECTOR_TOKEN_FILE`, `CONNECTOR_HTTP_TIMEOUT_SEC` | `connector/.connector-token`, 30 | Where the paired token is stored / HTTP timeout |
| `MATCHER_URL`, `MATCHER_TIMEOUT_MS` | `http://localhost:5001`, 10000 | Where CAP finds the OR-Tools service |
| `MATCHER_TOKEN` | *(empty)* | Shared secret CAP sends as `X-Matcher-Token`; set the same value on the matcher. A matcher with `NODE_ENV=production` answers 503 without it (CAP then ranks with its greedy fallback) |
| `MATCHER_HOST` | `127.0.0.1` | Matcher only (`python app.py`): listen address. `0.0.0.0` only when it runs on its own host |
| `MATCHER_FALLBACK_ENABLED` | true | Rank with the built-in greedy method when the matcher is down |
| `ORS_API_KEY`, `ORS_BASE_URL` | *(empty)* | OpenRouteService; empty = Haversine × road factor |
| `ROAD_FACTOR`, `CITY_SPEED_KMH`, `ROUTE_HANDLING_MIN` | 1.3, 22, 20 | Fallback distance/ETA model |
| `OPEN_METEO_BASE_URL`, `WEATHER_CHECK_ENABLED`, `WEATHER_CHECK_SEC`, `WEATHER_CLOSE_MM_PER_H` | see template, true, 600, 20 | Rain check that re-plans routes |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL_FROM` | *(empty)*, 587 | Email alerts; off while `SMTP_HOST` is empty, needs `ALERT_EMAIL_FROM`. One digest per hospital per check to its pharmacists and approvers that saved an email, else the hospital's admin email |
| `ALERT_EMAIL_TO` | *(empty)* | Fallback recipients (ops list, comma separated): hospitals with no email on file, partner licence reminders |
| `COURIER_LINK_TTL_HOURS` | 24 | Hard expiry of a courier link |
| `NEARBY_KM` | 1 | Live tracking: courier this close to the receiver = "Nearby" step |
| `EXPIRY_ALERT_DAYS` | `90,60,30,7` | Expiry alert tiers in days (one alert per lot for the tightest tier reached, plus one when expired) |
| `LLM_PROVIDER` | `none` | `none`, `openai-compatible` or `aicore`. **Everything works with `none`** |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | *(empty)* | `openai-compatible`: `POST {LLM_BASE_URL}/chat/completions` |
| `AICORE_SERVICE_KEY_PATH`, `AICORE_MODEL_NAME`, `AICORE_RESOURCE_GROUP` | `./aicore-key.json`, *(empty)*, `default` | `aicore`: optional SAP AI Core ([SAP_INTEGRATIONS](docs/SAP_INTEGRATIONS.md)) |
| `TRUST_FEED_LLM_ENABLED` | true | Allow LLM parsing of CDSCO alerts (only when an LLM is on) |
| `APPROVAL_MODE` | `cap` | `cap` = built-in approvals + timer; `bpa` = optional SAP Build Process Automation |
| `BPA_API_URL`, `BPA_DEFINITION_ID`, `BPA_TOKEN_URL`, `BPA_CLIENT_ID`, `BPA_CLIENT_SECRET` | *(empty)* | `bpa` only |
| `ALERT_NOTIFICATION_URL`, `ALERT_NOTIFICATION_CLIENT_ID`, `ALERT_NOTIFICATION_CLIENT_SECRET` | *(empty)* | Optional SAP Alert Notification; when set it **replaces** email as the outbound channel |
| `SAP_API_HUB_KEY`, `SAP_API_HUB_SANDBOX_BASE`, `SAP_API_MATERIAL_STOCK_PATH`, `SAP_API_BATCH_PATH` | *(empty)*, see template | Optional SAP Business Accelerator Hub sandbox; empty key = offline fixture `seed/sap-sandbox-fixture.json` |
| `DEFAULT_SAFETY_MARGIN_PCT`, `DEFAULT_COVER_WINDOW_DAYS` | 20, 14 | Cover defaults (overridable per hospital) |
| `EXPIRY_BUFFER_DAYS`, `NEAR_EXPIRY_DAYS` | 7, 60 | Rule 4 buffer / near-expiry threshold |
| `SUPPLIER_RESPONSE_TIMEOUT_MIN`, `TIMER_SWEEP_SEC` | 30, 60 | Supplier silence → next supplier |
| `LONG_ROUTE_KM`, `LONG_ROUTE_MIN` | 25, 90 | Second sign-off "long route" rule |
| `SYNC_INTERVAL_SEC`, `STALE_FEED_MINUTES`, `LICENCE_REMINDER_DAYS` | 900, 60, 30 | Sync/recompute job, stale-feed greying, licence reminders |
| `COLD_CHAIN_MIN_C`, `COLD_CHAIN_MAX_C`, `AMBIENT_MIN_C`, `AMBIENT_MAX_C`, `FROZEN_MIN_C`, `FROZEN_MAX_C` | 2, 8, 2, 30, -25, -15 | Storage ranges for excursions |
| `TRACE_MAX_GAP_MIN` | 15 | Max gap in the temperature trace for proof of condition |
| `JOBS_ENABLED`, `DEMO_FRESH_SEED` | true, true | Background jobs (sync + stock check, timeouts, weather, daily cleanup) / mark seeded hospitals freshly synced at development start |
| `SEED_AUTO_REFRESH`, `SEED_ANCHOR_DATE` | true, today | Re-run the seed when the date changes / pin the seed date (YYYY-MM-DD) |
| `SIM_TELEMETRY_INTERVAL_SEC`, `SIM_EXCURSION_ENABLED`, `SIM_EXCURSION_AFTER_TICKS`, `SIM_SPEEDUP` | 5, true, 3, 10 | Simulator cadence / one deliberate excursion / speed |
| `SIM_USER`, `SIM_PASSWORD`, `SIM_BEARER_TOKEN` | `admin`, `DEMO_PASSWORD`, *(empty)* | Simulator: an admin account that lists the courier links (`GET /admin/courier-links`); or an admin's Bearer token |
| `PYTHON` | auto | Python executable for `npm run dev` |

## 6. Accounts and sign-in

MediLink accounts are the only login, in every profile (`srv/auth.js`, `srv/lib/accounts.js`).

| Call | |
|---|---|
| `POST /auth/login {"username","password"}` | `{ token, expiresAt, user }`; then send `Authorization: Bearer <token>` |
| `POST /auth/logout` · `GET /auth/me` | End the session · who am I (includes `email` when set) |
| `POST /auth/ws-ticket` | `{ ticket, expiresIn: 30 }`: single-use ticket for `/ws/tracking?ticket=` |
| admin: `GET /auth/users` · `POST /auth/users` | List · create `{username, password, role, hospital, email?}` |
| admin: `POST /auth/users/<name>/reset-password` · `/disable` · `/enable` · `/email` | Reset, disable, enable (reset and disable end the user's sessions at once), set the alert email |

Portal sign-in (`/auth/login`) is for `pharmacist`, `approver` (each acts for one hospital) and `admin` only; any other account gets
`LOGIN_FAILED`. `system` (technical user for SAP Build Process Automation) is API-only via HTTP Basic; scripts may use Basic too.
Delivery partners have no accounts: courier links are emailed to the partner's dispatch address (when SMTP is on) and shareable by
the supplying hospital (`courier-link` action); 60 calls/min per link, 1200/min per IP.

Limits (in memory, per process; 429 `RATE_LIMITED` with `Retry-After`): 5 wrong passwords pause that IP + username for 15 min, plus a
growing delay per username (250 ms doubling, max 4 s) · `/auth/*` 100 per 5 min per IP · `/ingest` 60/min per IP ·
`/connector/pair` 10 per 15 min per IP · `/me/actions/*` 60/min per user · licence look-up 20 per 15 min, weather check 5 per 10 min,
photo preview 10/hour per user. IPv6 clients count per /64. Behind a proxy set `TRUST_PROXY`.

## 7. Optional SAP integrations

Off by default, each switched on by env only; MediLink works fully without them. Steps: [`docs/SAP_INTEGRATIONS.md`](docs/SAP_INTEGRATIONS.md).

| SAP software | Switch on | When off |
|---|---|---|
| SAP AI Core (generative AI hub) | `LLM_PROVIDER=aicore`, `AICORE_MODEL_NAME`, key file at `AICORE_SERVICE_KEY_PATH` | Templates (or `LLM_PROVIDER=openai-compatible`) |
| SAP Build Process Automation | `APPROVAL_MODE=bpa` + `BPA_*` | Built-in approvals and 30-minute timer |
| SAP Alert Notification | `ALERT_NOTIFICATION_URL`, `ALERT_NOTIFICATION_CLIENT_ID`, `ALERT_NOTIFICATION_CLIENT_SECRET` | In-app + SMTP email |
| SAP Business Accelerator Hub sandbox | `SAP_API_HUB_KEY` | Offline fixture |

`GET /health/integrations` (admin) lists, each as connected / fallback / misconfigured: Database, Logins, Hospital access tokens,
Email alerts (SMTP), SAP Alert Notification, AI (LLM), SAP Build Process Automation, SAP Business Accelerator Hub (sandbox),
OR-Tools ranking service, OpenRouteService, Open-Meteo, MediSoft HIS.

## 8. API overview

**Experience layer (for UIs):** `GET /me/home` · `GET /me/onboarding` · `GET /me/journeys/{id}` · `GET /me/journeys/{id}/tracking` · `GET /me/city` ·
`GET /me/stock` · `GET /me/notifications` · `POST /me/actions/{actionId}` (Idempotency-Key aware) and the WebSocket events `journey.updated`, `tracking`;
contract in [`docs/EXPERIENCE_API.md`](docs/EXPERIENCE_API.md). Courier (no sign-in, `Authorization: Courier <token>`): `GET /courier/job` · `POST /courier/pickup|location|road-closed`.
Admin: `GET /health/integrations` · `GET /admin/metrics` (PRD §3 success metrics) · `GET /admin/courier-links`.

Underlying services: OData v4 under `/odata/v4/<service>`; REST services at their own paths. Highlights:
`POST /onboarding/licence` · `GET /oauth/medisoft/callback` · `POST /onboarding/revokeAccess` · `POST /connector/pair` · `POST /ingest` (connector token) ·
`POST /sync/uploadSheet` · `POST /sync/uploadPhoto` · `POST /sync/syncNow` · `cover/board(window=7|14|21)` · `cover/shortfall(drug=…)` · `cover/cityView` ·
`requests/createRequest` · `requests/rank` · `requests/choosePlan` · `supplier/review|accept|decline` · `approval/approveTransfer|rejectTransfer` ·
`delivery/*` (admin only) · `routes/setRouteClosed|checkWeather` · `receipt/arrivalScan` · `ledger/settleLoan` ·
`GET /audit/verify` · `trust/recall|parseAlert` · `/workflow/*` (SAP Build Process Automation contract) ·
WebSocket `wss://<host>/ws/tracking?ticket=<from POST /auth/ws-ticket>` (events `tracking`, `excursion`, `replan`, `status`, `alert`, `journey.updated`; each user only receives their own hospital's) ·
matcher `POST /rank`. Every hard-rule exclusion is returned as `{rule, ruleName, code, detail}`.

## 9. Performance (PRD §12, 50 hospitals)

Measured by `backend/test/perf.test.js` (part of `npm test`): 5 demo + 45 synthetic hospitals, real OR-Tools matcher,
in-memory SQLite, end-to-end HTTP, Windows 11 laptop, 1 Nov 2026.

| Call | Target | Measured (best / worst of 3-5 runs) |
|---|---|---|
| Cover board `cover/board(window=14)` | < 2 s | 25 ms / 114 ms |
| Plan ranking `requests/rank` incl. forced re-sync, OR-Tools CP-SAT, 20+ eligible lots | < 10 s | 250 ms / 277 ms |
| Home screen `GET /me/home` (pharmacist with an active journey) | < 1 s | 36 ms / 95 ms |
| Home screen `GET /me/home` (admin, all journeys) | < 1 s | 26 ms / 32 ms |
| City view `GET /me/city` over 50 hospitals | < 2 s | 68 ms / 84 ms |

Not yet measured on the SQLite **file** that production uses (WAL mode).

## 10. Interpretation choices (where the PRD left room)

- Cover window = today + next N−1 days; a lot covers a dose only if it expires **strictly after** the dose date; allocation is earliest-expiry-first.
- Safety margin = `ceil(booked × pct / 100)` on own booked demand; surplus is 0 while any own dose is short.
- "Licence valid on transfer date" uses today's date; rule 8 compares ETA with end of the needed-by day (UTC).
- A stale supplier feed excludes its lots (`STALE_FEED`, reported under rule 1); a disconnected hospital's stock is never offered.
- Lowering the offered quantity trims the longest-expiry lots first and routes the remainder to the next supplier.
- Second sign-off must be a different approver than the first.
- Landed cost = quantity × drug unit cost (synthetic INR); the real formula is a PRD open question.
- Low stock = usable units ≤ reorder level (the hospital's level, else the medicine's default; neither = not watched). Expiry alerts only for the tightest tier reached.

# MediLink audit (snapshot `audit-base`, HEAD 329ab5f, read-only)

Date 1 Nov 2026. Method: read every backend/frontend/component file plus the cds 10.2.2 auth source in `backend/node_modules`. Nothing was executed except small read-only `node -e` checks. Test baseline taken from the brief (backend Jest 149/150).
Paths are relative to the repo root. `srv/` means `backend/srv/`. "Test" = file:line of the Jest/pytest case.

Scope decisions applied: (1) **REMOVE** the BTP platform: CF/MTA, HANA Cloud, XSUAA, app router, Destination service, and also PostgreSQL. The target is SQLite only. (2) **KEEP** these as optional, default-off: AI Core / SAP Cloud SDK for AI, BPA, Alert Notification, API Hub sandbox, CAP. (3) New: stock + expiry monitoring. (4) The portal is for pharmacists only, and couriers do not sign in. (5) Live courier tracking goes to the receiving hospital.

---

## A. Summary

- **Backend: strong at the API level.** All 28 FRs have code. Every PRD §18 demo beat is covered end to end by `e2e-demo.test.js` and `experience-e2e.test.js`. The hard rules, cover engine, workflow, ledger and audit chain are pure and well unit-tested.
- **Standalone SQLite profile: works for the backend.** It provides logins, the AES-GCM token vault, SMTP email, a persistent SQLite file and env checks. It does **not** work for the shipped UI:
  - The UI login is a client-side mock that only accepts password `demo`.
  - On any non-localhost host the router enters an infinite 401 → `#/login` → `#/home` loop (F1).
- **BTP-only surface is large but well isolated.** It covers `mta.yaml`, `app/router/`, `xs-security.json`, HANA/PG profiles, the Destination adapter, HANA/PG compat tests and about 400 lines of duplicated mocked users. Removing it is mostly deletion (§D).
- **Optional SAP integrations conflict with standalone mode.** Standalone currently force-disables AI Core, BPA and Alert Notification (`srv/lib/config.js:43,51`, `srv/lib/notify.js:26`). Keeping them optional needs small gate changes.
- **New requirements are mostly missing:**
  - Monitoring: shortfall, licence and stale-feed alerts exist. Low-stock thresholds, expiry tiers, expired-lot alerts and per-user recipients do not. Email goes to one global list.
  - Couriers: they are full portal users today.
  - Tracking: there is no map. GPS is not in the journey payload, and the UI polls instead of using the WebSocket.
- **Real bugs found:**
  - A cancelled request leaves its loan OPEN.
  - In-kind repayment can be reused across loans and creates a mirror loan.
  - A disconnected hospital's frozen stock is still offered city-wide.
  - Duplicate batch rows make ingest fail with 500.
  - Every pharmacist can read city-wide courier GPS.
  - No security headers. Rate limiting exists only on login.
- **HANDOVER says "325 passing, 0 failing". That is not reproducible on a clean clone.** `deployment.test.js` needs the git-ignored `app/router/resources/index.html` (`.gitignore:14`, `mta.yaml:27`). Because the root script uses `&&` (`package.json:19`), five suites never run.

---

## B. PRD checklist

Status values: Delivered / Partial / Missing / BTP-dependent.

### B1. Functional requirements (§8)

| ID | Requirement (short) | Status | Evidence (code · test) | Gap / what's left |
|---|---|---|---|---|
| FR-01 | Onboard with licence no.; resolve hospital, validity, software | Delivered | `srv/handlers/onboarding.js:21-43` · e2e-demo.test.js:42, experience-e2e.test.js:43 | – |
| FR-02 | Expired/unknown licence blocked, plain message | Delivered | onboarding.js:26-35, `_i18n/messages.properties` · e2e-demo.test.js:42, messages.test.js:26 | – |
| FR-03 | Allow = OAuth2 code flow, read-only scopes | Delivered | onboarding.js:45-48, `lib/medisoft.js:12-30`, `server.js:104-134` · mock-medisoft/test/oauth.test.js, e2e-demo.test.js:42 | No PKCE (F20). Tenant check only runs if the HIS returns `tenant` (server.js:119) |
| FR-04 | Fallbacks: software dropdown, IT handoff link, sheet/photo | Partial | home.js:41-52, actions.js:149-189, sheet.js, photo.js, server.js:49-59 · onboarding-ingest.test.js:22,65; llm-and-switches.test.js:31-70 | **The IT link is never sent.** The UI says "We sent your IT team…" (onboarding.js:54), but `itContact` is discarded (:53). Photo needs an LLM. Photo confirm replaces all SHEET stock (F13) |
| FR-05 | Disconnect revokes instantly; logged | Partial | onboarding.js:63-74 · onboarding-ingest.test.js:121 | **No UI button.** The `disconnect` action exists (actions.js:190) but no screen offers it. Old stock is still offered after disconnect (F3) |
| FR-06 | Pull every 15 min + on opening shortfall; last-synced shown | Delivered | jobs.js:36-42, handlers/cover.js:12, matching.js:121, home.js:160-163 · e2e-demo.test.js:61, perf.test.js:59 | Jobs never run in tests (`test/helpers/env.js:11` JOBS_ENABLED=false). `/me` journeys don't re-sync on open |
| FR-07 | Grey out silent feed >1 h, alert its admin | Partial | sync.js:36-52, matching.js:40 · onboarding-ingest.test.js:95 | "Its admin" = the global `ALERT_EMAIL_TO`. `Hospitals.adminEmail` only appears in the message text (sync.js:44). Disconnected hospitals are never checked |
| FR-08 | Batch passport per lot | Delivered | schema.cds:69-83, ingest.js:61-66 · cover.test.js:27 | – |
| FR-09 | Expiry watch ≤60 d listed + offered first | Partial | coverdb.js:85-98 (`nearExpiry` fn), coverdb.js:42-44, solver.py:26-29 · matcher/tests/test_matcher.py:29 | `nearExpiry()` has no test and is not in `/me` or the UI. No near-expiry notification exists |
| FR-10 | Licence renewal reminder 30 d (hospitals + partners) | Partial | sync.js:55-68 | **No test.** Partner reminders have `hospital:null`, so only admin/global email gets them. The same reminder repeats daily for 30 days |
| FR-11 | Scheduled-demand cover 7/14/21 | Delivered | cover.js:42-81, coverdb.js:9-10 · cover.test.js:9-75 | The UI has no 7/14/21 toggle (home shows counts only) |
| FR-12 | Board red-first; alert on new shortfall | Delivered | coverdb.js:64,137; ingest.js:96-103 · experience-e2e.test.js:85, standalone-adapters.test.js:33 | – |
| FR-13 | Shortfall card: affected bookings, curative flagged | Partial | coverdb.js:67-83 · cover.test.js:53, e2e-demo.test.js:61 | OData only. `/me` shortfall journey has `patientsAffected` only (journey.js shortfallJourney), and the UI shows no booking list |
| FR-14 | One-tap prefilled request + brand toggle | Delivered | actions.js:35-38,194-205; requests.js:24-40 · experience-e2e.test.js:103 | – |
| FR-15 | Flag table (CDSCO/recalls); flagged never eligible | Delivered | trust.js:21-90, rules.js:56-59 · trust-feed.test.js:42-99 | Alert parsing needs an LLM (manual recall works) |
| FR-16 | 8 hard rules before ranking | Delivered | rules.js:53-107, matching.js:46-58 · rules.test.js:22-85 | – |
| FR-17 | OR-Tools ranking + reason per plan | Delivered | matcher/solver.py:32-86, matching.js:76-115 · test_matcher.py:22,29; e2e-demo.test.js:75 | – |
| FR-18 | Supplier sees post-transfer cover; accept/decline/qty/repay | Delivered | workflow.js:87-143 · e2e-demo.test.js:102 | – |
| FR-19 | Decline / 30-min silence → next supplier | Delivered | workflow.js:145-191 · workflow-ledger.test.js:35,47; experience-paths.test.js:33,99 | – |
| FR-20 | Approver sign-off; 2nd sign-off on risk | Delivered | workflow.js:42-48,193-210 · e2e-demo.test.js:102 | LONG_ROUTE rule has no test |
| FR-21 | Partner licensed + certified for storage class | Delivered | delivery.js:24-45, rules.js:44-50 · rules.test.js:52,60 | – |
| FR-22 | Pickup scan: batch, seal, logger | Delivered | delivery.js:48-68 · experience-e2e.test.js:178 | Barcode fields are plain text (no camera). Must move to a courier link (§E3) |
| FR-23 | Live GPS + temp to receiver; re-plan on closure | Partial | delivery.js:71-145, ws.js:28-58 · delivery-tracking.test.js:46,66 | No map. The journey has no position (journey.js:248). UI polls every 10 s and never opens the WS |
| FR-24 | Excursion alerts both hospitals, suggests quarantine | Delivered | delivery.js:87-94 · delivery-tracking.test.js:54 | – |
| FR-25 | Arrival scan, seal, qty, proof of condition; cover updates | Delivered | receipt.js:15-75 · receipt-audit.test.js:18,37; e2e-demo.test.js:155 | Trace can be backfilled by courier (F16) |
| FR-26 | Loan on acceptance; settle in kind / landed cost | Partial | workflow.js:135-138, ledger.js:6-29 · workflow-ledger.test.js:90-110 | Ledger bugs F4 and F5 |
| FR-27 | Hash-chained audit + verify | Delivered | audit.js:10-26, audit-chain.js · audit-chain.test.js:7-19; receipt-audit.test.js:46,59 | No verify button in the UI. Every approver reads all entries (F9). Concurrent writes fail (F15) |
| FR-28 | City view, aggregated/anonymised | Delivered | coverdb.js:101-116, home.js:207-212 · e2e-demo.test.js:176 | No distributor/state access or export. Includes disconnected hospitals |

### B2. Non-functional requirements (§12)

| ID | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| NFR-Privacy | No names; refs hashed at source; counts only | Delivered | ingest.js:49-51, schema.cds:88, mock-medisoft/server.js:145, connector hash_ref · onboarding-ingest.test.js:46 | Bookings stay after consent revocation (F3) |
| NFR-Access | Read-only, least-privilege OAuth; RBAC via XSUAA | BTP-dependent → Partial | Scopes in config.js:65. XSUAA replaced by accounts.js (same roles + attrs) · standalone-auth.test.js:87 | Several projections have no row filter (F2, F9, F10) |
| NFR-Security | Tokens in Destination svc; TLS; no creds typed | BTP-dependent → Partial | Replaced by AES-256-GCM TokenVault with AAD (tokens.js:29-59) · standalone-auth.test.js:159 | No CSP/HSTS/headers (F8). TLS is left to the host |
| NFR-Integrity | Append-only hash chain; every exclusion logged | Delivered | audit.js:10-14, matching.js:134,141 · receipt-audit.test.js:46,59 | Chain is not anchored (anyone with DB write can recompute it). Seq race (F15) |
| NFR-Freshness | ≤15 min; forced re-sync before plans | Delivered | jobs.js:38, matching.js:121 · perf.test.js:59 | Push feeds can't be forced. Stale feeds are excluded instead |
| NFR-Performance | Board <2 s; rank <10 s @50 hospitals | Delivered | perf.test.js:52,59,70 (in-memory SQLite) | Not measured on the SQLite **file** with the 10-connection pool |
| NFR-Reliability | Works without LLM | Delivered | `LLM_PROVIDER=none` across all tests (helpers/env.js:10) | – |
| NFR-Usability | No training; prefilled; phone-camera scans | Partial | Actions-as-data (actions.js) | No camera scanning. UI is mostly English-only |
| NFR-Compliance | Licensed parties + licensed carrier | Partial | rules.js:76-83 · rules.test.js:60 | Indian legal checks are still open (PRD §19) |
| NFR-Cost | Free plans only | Delivered | SQLite/OSS. `deployment.test.js:12` becomes moot | – |

### B3. User stories (§7)

| ID | Story | Status | Evidence | Gap |
|---|---|---|---|---|
| US-1 | Licence + Allow | Delivered | experience-e2e.test.js:43 | – |
| US-2 | See uncovered drugs next 14 d | Delivered | home.js:141-149, coverdb.js:56 | UI shows counts, not a per-drug board |
| US-3 | See affected patients first | Partial | coverdb.js:80 | Not exposed in `/me` or the UI |
| US-4 | One-tap prefilled request | Delivered | experience-e2e.test.js:103 | – |
| US-5 | Ranked plans + reason | Delivered | actions.js:52-59 | Exclusions (flagged/unlicensed dropped) not shown in UI |
| US-6 | Supplier sees own bookings covered | Delivered | workflow.js:101; journey `_short` headline | – |
| US-7 | Repay in kind / landed cost | Delivered (buggy) | actions.js:73-79 | F4, F5 |
| US-8 | Approver inbox + 2nd sign-off | Delivered | experience-e2e.test.js:134 | WS push shows Approve to whoever already signed (known) |
| US-9 | Partner scans at pickup | Delivered (to be redesigned) | delivery.js:48 | Couriers no longer sign in (§E3) |
| US-10 | Receiver tracks live + verifies seal/trace | Partial | receipt.js; journey eta/temp | No map/WS/position (§E4) |
| US-11 | Never offered flagged/recalled/expired/unlicensed | Delivered | rules.js; rules.test.js | Stock of a disconnected hospital still offered (F3) |
| US-12 | Hospital admin can disconnect | Partial | onboarding.js:63 | No UI button; no hospital-admin role |

### B4. Demo script (§18)

| Beat | Status | Evidence | Gap (UI level) |
|---|---|---|---|
| 1 Onboard live; expired refused | Delivered | e2e-demo.test.js:42, experience-e2e.test.js:43 | – |
| 2 Carboplatin red 16/40, 9 patients | Delivered | cover.test.js:75, e2e-demo.test.js:61 | Patient list not shown in UI |
| 3 Request; flagged + unlicensed drop out; nearest first | Delivered (API) | e2e-demo.test.js:75 | UI never shows exclusions |
| 4 Supplier covered; accept in kind; approver signs | Delivered | e2e-demo.test.js:102 | – |
| 5 Road flooded re-plan; temp spike quarantine | Delivered | e2e-demo.test.js:128 | No map to *see* the re-route |
| 6 Arrival PoC passes; green; ledger; chain verifies | Delivered (API) | e2e-demo.test.js:155 | No ledger view and no audit-verify button in UI |
| 7 City view | Delivered | e2e-demo.test.js:176 | – |

### B5. Data model (§11)

All entities in `backend/db/schema.cds`. Every one is Delivered and loaded by the CSV seed plus the e2e tests.

| Entity | Lines | Notes / gap |
|---|---|---|
| Hospital | 36-55 | Has `safetyMarginPct`, `coverWindowDays`, `adminEmail` (`adminEmail` is never used to send) |
| Drug | 57-66 | `criticalFlag`, `storageClass`, `unitCost` (synthetic) |
| Lot | 69-83 | Adds `quarantined` and `source`. **New req 2 needs per-lot expiry-alert state** |
| Booking | 85-94 | `patientRef` regex assert |
| Flag | 96-106 | – |
| Licence | 108-115 | – |
| Consent | 128-135 | Adds `provider` |
| Request | 138-150 | Adds `preferredBrand` |
| Transfer | 173-206 (+TransferLots 208, Approvals 215) | Has eta/partner/excursion. **No live-position or courier-link fields** |
| ConditionLog | 224-232 | – |
| Ledger | 245-257 | No `settlementTransfer` FK and no "is repayment" flag on Transfer (F5) |
| AuditLog | 260-268 | – |
| **Missing for new reqs** | – | `Users.email` and notification preferences, stock thresholds, alert dedupe key, courier link tokens |

---

## C. HANDOVER "Known limitations" and "Prepared, not verified"

### C1. Known limitations

| HANDOVER item | Still true? | Relevant after BTP removal? |
|---|---|---|
| UI sign-in is a mock of `POST /auth/login` "not in the API yet" | **Half untrue.** `/auth/login` exists (accounts.js:204) but the UI never calls it (app.html:316-322) | **Critical.** With a real `DEMO_PASSWORD` nobody can sign in via the UI. Off-localhost the UI loops (F1) |
| UI polls `/me/home` every 10 s, no WebSocket | True (app.html:700-702; no `WebSocket` in app.html) | Yes. JWT `?access_token=` now makes WS possible (accounts.js:114) |
| Hybrid/CF browser checks not possible | True | No (CF gone) |
| `IdempotencyKeys` never cleaned | True (http-routes.js:46) | Yes. SQLite file grows; add a cleanup job |
| `journey.updated` shows Approve to an approver who already signed | True (ws.js:41 viewer has no `userId`, actions.js:86) | Yes |
| ws.js emits `updated` for `journey.updated` | True (ws.js:56) | Yes (CAP behaviour) |
| English only | True | Yes |
| Windows Ctrl+C tree-kill not exercised | Not re-verified | Yes (dev only) |
| Login rate limit in memory, per username | True (accounts.js:35-48) | Yes. Also a lockout-DoS vector (F7) |
| Alert emails to one list; accounts have no email | True (notify.js:41, schema.cds:320-329) | **Yes. Core gap for new req 2** |
| Matcher LLM rewrite is AI Core only | True (matcher/explain.py:55) | Yes, if AI Core stays optional |
| `demo:experience` re-sends GPS fix (race) | True (scripts/demo-experience.js:125) | Yes |
| Linux not run | Unknown | Yes (hosting is likely Linux) |

### C2. Prepared, not verified

| Item | Still true? | After BTP removal |
|---|---|---|
| HANA Cloud (DDL/SQL rendering only) | True | **Remove** |
| HANA `ST_Distance` | True (geo.js:15-31) | **Remove**; Haversine only |
| XSUAA, app router, role collections | True; also `deployment.test.js` **fails** on clean clone | **Remove** |
| Destination token store | True (tokens.js:61-106) | **Remove**; TokenVault stays |
| BPA (`APPROVAL_MODE=bpa`) | True | **Keep optional**, but standalone forces `cap` (config.js:51); unblock it |
| AI Core via SAP Cloud SDK for AI | True | **Keep optional**, but standalone forces `none` (config.js:43); unblock it |
| Alert Notification | True | **Keep optional**, but `channel()` skips it in standalone (notify.js:26) and creds come only from VCAP/binding (notify.js:51). It needs an env/key-file source |
| API Hub sandbox | True (offline fixture) | **Keep**; already works in standalone |
| `mbt build` / `cf deploy` | True | **Remove** |
| HANA performance | True | Remove; measure the SQLite **file** instead |
| Standalone PostgreSQL never run on a server | True | **Remove** (SQLite only) |
| SMTP / OpenAI-compatible only against fakes | True | Keep. SMTP becomes the primary alert channel, so test it against a real server |
| Free hosts (STANDALONE_HOSTING Part B) not deployed | True. Part B also requires hosted **PostgreSQL** (B1) and the UI would loop there (F1) | **Rewrite** for SQLite on a persistent disk |

### C3. Other HANDOVER/README/doc claims found untrue

- "325 passing, 0 failing": see §A. On a clean clone `deployment.test.js:21` fails, and `npm test` stops there.
- STANDALONE_HOSTING A6: "Sign in (any HTTP tool, **or the UI**) … `<DEMO_PASSWORD>`" is false. The UI rejects any password other than `demo` (app.html:318).
- README §3: "Sign-in is a mock of `POST /auth/login` (not in the API yet)" is stale.
- README §9: "each user only receives their own deliveries" holds for the WebSocket only. Over OData any pharmacist reads all ConditionLogs (F2).
- PRD §5 table and onboarding message: the IT setup link is "auto-sent". Nothing is sent (onboarding.js:53-54).
- HANDOVER code map says the photo is read by "AI Core". It is any LLM provider now (minor).

---

## D. BTP removal inventory

### D1. REMOVE (BTP platform + PostgreSQL) → replacement

| Area | Files / config / code branch | Replacement in SQLite mode |
|---|---|---|
| **CF / MTA** | `mta.yaml`, `secrets.mtaext.example`, root `package.json` scripts `build:mta`, `deploy:cf`, `watch:hybrid`; `.gitignore` lines `mta_archives/ gen/ resources/ *.mtar *.mtaext`; `backend/package.json` `build` (`cds build --production` → `gen/`); sap.js:11 second fixture path (MTA copy); `docs/SAP_GO_LIVE.md` Parts 0-5, 7, "Moving from standalone to BTP"; README §6, §7, §12 items 1/4/7 | Any Node host or VM: `npm start` (cds-serve) + `python app.py`, with a persistent disk for `db/medilink.sqlite` |
| **HANA Cloud** | dep `@cap-js/hana`; `cds.requires.db` `[hybrid]`/`[production]` kind hana; `cds.hana.deploy_format`; `cds.sql.native_hana_associations`; geo.js:12-31 (`isHana`, `hanaQuery`); integrations.js:72-77; hana-compat.test.js:52-125 + `test:hana-compat` script; scripts/db.js `export` (purpose: move to HANA); env `HANA_INSTANCE_NAME`, `HDI_CONTAINER_SERVICE` (.env.example:53-55) | SQLite file (`[standalone!]` db, package.json:66-71); Haversine (routing.js:8-12) |
| **XSUAA** | `backend/xs-security.json`; dep `@sap/xssec`; `cds.requires.auth` `[production]` xsuaa; mocked users duplicated in `[development]`/`[hybrid]`/`[test]` (package.json:77-463); security.test.js:31,44; deployment.test.js:45; integrations.js:79-83; frontend `isLocal` "behind the SAP app router" branch (app.html:279,357-360,695) **(source of F1)**; simulator `SIM_BEARER_TOKEN` comment (index.js:11) | MediLink accounts (accounts.js, srv/auth.js) everywhere. Keep mocked users for `[test]` only, or seed accounts in tests too |
| **App router** | `app/router/package.json`, `app/router/xs-app.json`; deployment.test.js:21-43 (**the 1 failing test**); frontend.test.js:25; mta.yaml:27 copy step | CAP serves `frontend/` (server.js:40-41) |
| **Destination service** | tokens.js:61-112 (`destination` adapter, `destToken`, auto-pick in `store()`); env `TOKEN_STORE`; `cds.requires.destinations` `[hybrid]`/`[production]` (package.json:473-476); integrations.js:85-89; `notify.vcap` use for destination | `local` AES-256-GCM TokenVault (tokens.js:18-59), `TOKEN_ENCRYPTION_KEY` required |
| **PostgreSQL (MediLink DB)** | dep `@cap-js/postgres`; profiles `[standalone-pg!]` db+auth (package.json:72-74,468-471); standalone.js:8 (`standalone-pg`), :11-26 (`pgCredentials`, `configureDb`), :34 (`DATABASE_URL`), :64; server.js:18; scripts/db.js `--pg`, `db:init:pg`, `db:reset:pg`; scripts/dev.js `--pg`; env-check profile; hana-compat.test.js:127-174 + `test:pg-compat`; integrations.js:20,32-34; STANDALONE_HOSTING B1 | SQLite only. **Keep** the connector's ability to read a hospital's own Postgres (`connector/` psycopg2, `seed/init.sql`, `readonly.sql`). That is the source DB, not MediLink's |
| **Profiles** | `hybrid`, `production` (BTP meaning), `standalone-pg`; the `!` precedence trick (package.json:66,72,464,468) | One runtime profile (rename `standalone` → default) + `test` |
| **BTP env vars** | `BTP_GLOBAL_ACCOUNT_SUBDOMAIN`, `BTP_SUBACCOUNT_SUBDOMAIN`, `BTP_REGION`, `CF_API_ENDPOINT`, `CF_ORG`, `CF_SPACE`, `HANA_INSTANCE_NAME`, `HDI_CONTAINER_SERVICE`, `TOKEN_STORE`, `TOKEN_STORE_KEY` (alias), `DATABASE_URL`, `CDS_PROFILE=standalone-pg`; `VCAP_SERVICES` reads (notify.js:64-66, integrations.js) | Keep `VCAP`-style read only if Alert Notification stays (see D2) |
| **Tests that exist only for BTP** | deployment.test.js (all 4); security.test.js:31,44; hana-compat.test.js (all); frontend.test.js:25; standalone-persistence.test.js:67 (export "for HANA"); the second backend run `test:standalone` (run-standalone.js) becomes the only run | – |
| **Dead config** | `BPA_DESTINATION` / `config.bpaDestination` (config.js:54) is never read | Delete |
| **Rules / docs** | Project rules file (lines 3-5) ("Free SAP/BTP plans only", `cds bind`, "development profile … mocked users"); HANDOVER "Prepared" table; `.env.example:1-7,45-55` | Rewrite for SQLite |

### D2. KEEP as optional, default-off SAP integrations (what must change)

| Integration | Where | Change needed after platform removal |
|---|---|---|
| SAP AI Core / Cloud SDK for AI | llm.js:20-56, dep `@sap-ai-sdk/foundation-models`, matcher/explain.py:46-80, `AICORE_*` | config.js:43 forces `none` in standalone → allow `aicore` when `AICORE_SERVICE_KEY_PATH` exists. Flip standalone-auth.test.js:187 |
| SAP Build Process Automation | workflow.js:226-249, WorkflowService (services.cds:283-291, role `system`), `APPROVAL_MODE`, `BPA_*` | config.js:51 forces `cap` in standalone → allow `bpa`. BPA must reach MediLink's public URL. `system` account comes from `seedDemoUsers` (`bpa`) |
| SAP Alert Notification | notify.js:49-62 | Creds come only from a CF binding/VCAP (notify.js:51). Add an env/service-key source. `channel()` excludes standalone (notify.js:26) |
| API Hub sandbox (S/4HANA) | sap.js, MaterialMappings, `seed/sap-sandbox-fixture.json` | None (already standalone-safe) |
| CAP | everything | None |

---

## E. New-requirements gap analysis

### E2. Stock and expiry monitoring + alerts

| What exists | Where |
|---|---|
| Shortfall vs **booked** demand; alert on GREEN→RED transition (deduped by snapshot) | coverdb.js:122-141, ingest.js:96-103 |
| "Below safety margin" = amber, computed on read, **not persisted, not emailed** | cover.js:73, home.js:135-137 |
| `nearExpiryQty` per cover row; `CoverService.nearExpiry()` list (pull only) | coverdb.js:42-44, 85-98 |
| Expired lots silently dropped from usable stock (no alert) | cover.js:21-23 |
| Licence reminders (daily repeat), stale feed (flag-deduped), recall, excursion (once per transfer) | sync.js:36-68, trust.js:58, delivery.js:87 |
| `Notifications` table (has `read`), WS `alert`, SMTP for 5 kinds to **one global list** | notify.js:15-47, schema.cds:282-291 |
| Notifications PATCH-able via OData; **no UI shows the Notifications table** (home alerts are derived) | services.cds:180-183 |

**Missing:**
- Low-stock thresholds: per hospital+drug min/reorder level or "days of cover". Non-critical drugs aren't on the board at all (coverdb.js:62).
- Expiry tiers (e.g. 90/60/30/7 days + expired + "short-dated <6 months") with a named action per tier: use, transfer via MediLink, return.
- Expired-lot alert ("remove from shelf").
- Per-user recipients. `Users` has no email (schema.cds:320). Hospitals' `adminEmail` is unused for sending.
- Role/hospital routing: today H1's alert can reach H2 staff if they share the list.
- Dedupe key per (hospital, lot/drug, kind, tier). Daily digest vs immediate. Ack/snooze. In-app inbox.

**Likely changes:**
- `schema.cds`: `Users.email`, `Users.notify*`; new `StockThresholds{hospital, drug, minUnits|minDaysCover}`; `Notifications` + `dedupeKey` (unique), `tier`, `lot`, `recipient`, `emailedAt`, `ackedAt`.
- New `srv/lib/monitor.js`: low-stock + expiry tiers, called from jobs.js `runSyncCycle` and after `ingestSnapshot`.
- `notify.js`: recipient resolution + dedupe + digest.
- `accounts.js` `validateUser`/`createUser`: email.
- `services.cds`: `SettingsService` thresholds; `GET /me/notifications` and `POST /me/actions/ack-alert` in http-routes.js/actions.js.
- `home.js` `ALERT_ORDER`: `LOW_STOCK`, `EXPIRING_90/60/30`, `EXPIRED`.
- `messages.properties`; frontend alerts list + settings screen.
- Tests: new monitor test, plus the currently missing `licenceWatch`/`nearExpiry` tests.

### E3. Portal for pharmacists only; couriers don't sign in

| Exists today (partner = full portal user) | Where |
|---|---|
| Role `partner` in accounts, seeded demo users `partner`, `sim`, `courier2` | accounts.js:23, package.json mocked users, accounts.js:174-186 |
| DeliveryService/RouteService `@requires partner` | services.cds:297-318 |
| Partner perspective in journeys/home/WS | journey.js:130,139; home.js:175-179; ws.js:23,32,43 |
| Actions `pickup-scan`, `report-road-closed` for partner | actions.js:255-269 |
| UI demo users `partner`, `courier2` | app.html:310 |
| Simulator authenticates as a partner user (Basic) | simulator/index.js |

**Missing:**
- Per-delivery courier capability link. Minted at `assignPartner` (delivery.js:24-45), stored hashed like `ConnectorTokens`, scoped to one transfer, expires at DELIVERED/CANCELLED, revocable, delivered by SMS/WhatsApp/email to the partner company.
- Public courier page: pickup scan with camera, "start trip", GPS via `navigator.geolocation.watchPosition`, report road closed.
- Logger/device telemetry via the same token.

**Decision needed:** Do approvers (chief pharmacist / oncologist) and the MediLink admin still sign in? They are not strictly "pharmacists". Is `system` (BPA) a non-interactive account?

**Likely changes:**
- `schema.cds`: `CourierLinks{tokenHash, transfer_ID, expiresAt, revokedAt, lastSeenAt}`.
- `server.js`: `GET /c/:token` page; `POST /courier/:token/pickup|telemetry|road-closed`, rate-limited, not behind CAP auth, calling `delivery.pickupScan`/`telemetry` with the token's transfer.
- Remove `partner` from `ROLES`, mocked users, actions roles, `contextsFor`, journey/home partner branches.
- Simulator switches to the courier token.
- Courier notification channel.
- Tests: delivery-tracking, ws-filter, experience-e2e beat 5.
- Risk: browser geolocation needs HTTPS and usually pauses when the tab is backgrounded. Plan for the logger/device path as the source of truth for the temperature trace.

### E4. Swiggy-style live tracking for the receiving hospital

| Exists | Where |
|---|---|
| Telemetry stored (lat/long/temp/seal) and pushed over WS to **supplier + receiver + partner + admin** | delivery.js:71-96, ws.js:28-35 |
| 7-stage journey + timeline; stage 6 "Arrived" = within 500 m or ETA passed | journey.js:100-126 |
| ETA set at pickup and on re-plan only | delivery.js:64,118 |
| Route geometry (`via` detour points) only for partners | services.cds:306, delivery.js:179-194 |
| Re-plan around closures, ORS or Haversine | routing.js |

**Missing:**
- Position, route polyline and live ETA in the receiver's journey payload. journey.js:248 exposes only `eta` and `temperatureC`.
- ETA recompute from the latest fix, throttled.
- A "nearby" step.
- A map (Leaflet + tiles) with an animated rider marker.
- A WS client in the UI (currently polling).
- Restricting telemetry to the receiver (supplier gets a summary) and locking down `ReceiptService.ConditionLogs` (F2).

**Likely changes:**
- `journey.js` `build()`: add `position`, `route{from,to,via}`, `etaLive`, `steps[]` for the `receiver` perspective.
- `delivery.telemetry`: ETA refresh + `journey.updated`.
- `ws.js` `audience()`: receiver-only for `telemetry`.
- `services.cds` `@restrict` on ConditionLogs.
- `frontend/app.html`: Leaflet map in journey detail, `new WebSocket('/ws/tracking?access_token=…')` replacing `poll()` (app.html:700).
- CSP must allow the tile host.
- Tests: ws-filter.test.js:47 (audience changes), delivery-tracking.test.js:46.

---

## F. Bugs and security issues (verified by reading; none reproduced at runtime)

| # | Sev | Where | Failure scenario | Fix hint |
|---|---|---|---|---|
| F1 | **High** | frontend/app.html:316-322, 324-327, 357-364 | (a) On any host that is not localhost/127.0.0.1 (every STANDALONE_HOSTING Part B deploy), `route()` skips login: `!needsAuth && !isLocal → #/home`. `/me/home` returns 401, `signOut()` sets `#/login`, `hashchange` leads back to `#/home`, giving an infinite request loop. (b) On localhost the mock accepts only the hard-coded `DEMO_USERS` with password `demo`, so real accounts and any real `DEMO_PASSWORD` cannot sign in | Call `POST /auth/login`, keep the JWT in memory, send `Bearer`; delete the `isLocal` branch |
| F2 | Medium | srv/services.cds:330 (`ReceiptService.ConditionLogs` without `@restrict`) | Any pharmacist of any hospital: `GET /odata/v4/receipt/ConditionLogs` returns live GPS + temperature of **every** shipment city-wide (high-value oncology drugs in transit) | `@restrict` via `transfer.receiver_ID = $user.hospital` (or drop the projection) |
| F3 | Medium | onboarding.js:63-74; sync.js:38; matching.js:34,40 | After **Disconnect**, the hospital's last Lots/Bookings stay. `detectStale` only checks `connected:true`, and matching only excludes `feedStale`, so frozen stock keeps being ranked as surplus indefinitely. Hashed bookings stay after consent withdrawal | On revoke, set `feedStale=true` (or exclude `connected=false` in `evaluate`/`cityView`) and purge or retain per policy |
| F4 | Medium | requests.js:53-61 (vs workflow.js:218, trust.js:67) | Receiver cancels a request after the supplier accepted (PENDING_APPROVAL/APPROVED/ASSIGNED). The transfer becomes CANCELLED but the **Ledger loan stays OPEN**: a phantom debt, and the journey stays on both home screens forever (journey.js:288-292). Supplier and courier are not notified | Cancel `Ledger where transfer_ID in … and status='OPEN'`; emit `status` + notify |
| F5 | Medium | ledger.js:13-20; workflow.js:135-136 | (a) One DELIVERED repayment transfer can settle **any number** of loans, because there is no check that `settlementRef` was already used. (b) The repayment itself is a normal transfer, so `supplierAccept` records a **new reverse loan**. Settling loan A leaves mirror loan B OPEN | Unique settlement link; mark repayment transfers (`repaysLoan_ID`) and skip loan creation for them |
| F6 | Medium | ingest.js:60-62, 82 | Two rows with the same drug+batch+manufacturer and no `lotRef` give the same lot ID, and `INSERT` hits a PK violation. Cases: a sheet listing a batch twice, or a connector whose view has one row per bin with `lot_ref` NULL. Sheet upload returns 500 and `/ingest` returns `INGEST_FAILED`; the feed then silently goes stale | Aggregate quantities by ID before insert (like bookings at :87) |
| F7 | Medium | accounts.js:35-48; server.js:62,85; http-routes.js:109; handlers/routes.js:22 | Only login is limited, and only per username in memory. (a) Anyone can lock any known pharmacist out for 15 min, repeatedly. (b) No limit on `/ingest`, `/connector/pair`, `/me/actions/*` (incl. `upload-photo` = 8 MB paid LLM call each), or `checkWeather`. Any pharmacist or partner can trigger outbound calls for all shipments | `express-rate-limit` per IP+user on these routes; progressive delay instead of hard lock |
| F8 | Medium | server.js:32-46 (no headers anywhere; grep found none); app.html:252, index.html:813 | No CSP, `frame-ancestors`/X-Frame-Options, HSTS or `nosniff`. Three.js loads from cdnjs **without SRI** on the sign-in page. A CDN compromise runs script in the page that handles passwords | helmet with a tight CSP; self-host Three.js or add `integrity` |
| F9 | Low | services.cds:356-358 | Every approver of every hospital reads the full audit log. Payloads hold other hospitals' licence numbers, requests, seal/logger IDs and closure coordinates | Restrict Entries to admin; give approvers `verify()` only |
| F10 | Low | services.cds:235-236, 257, 274, 315 | `Plans`, `Exclusions`, `TransferLots`, `Approvals` and `RoadClosures` have no row filter. Any pharmacist/approver/partner reads other hospitals' requests, batches and reject reasons, and harvests transfer/request IDs (used in F11) | Add `@restrict`, or remove projections the UI doesn't use |
| F11 | Low | journey.js:130, 315-320; http-routes.js:104-108 | IDOR: `perspective()` returns `'partner'` for **any** request. A partner of P2 calls `GET /me/journeys/<transferId>` (IDs from `RoadClosures`, F10) and gets drug, qty, needed-by and the requesting hospital for shipments it doesn't carry | Return null unless a leg has `partner_ID === viewer.partnerId` |
| F12 | Low | services.cds:180-183 + cds `libx/_runtime/common/generic/auth/restrict.js:271-279` | CAP's `where` on UPDATE checks only the **before-image**. A pharmacist can PATCH their own Notification with `hospital_ID:'H2'`, a new `message` or `dueDate`. That moves or forges rows and skews `/admin/metrics` lead time (metrics.js:24) | Restrict to `UPDATE` of `read` only (`@Core.Computed` / before-handler) |
| F13 | Low | photo.js:50; ingest.js:81 | Photo confirm ingests as source `SHEET`, so `DELETE` removes all SHEET lots. A photo of one register page wipes the rest of the hospital's sheet stock and creates false shortfalls | Merge (upsert) for photos, or require full-sheet semantics in UI |
| F14 | Low | onboarding.js:53-54 | UI tells the pharmacist "We sent your IT team a setup link", but nothing is sent and `itContact` is discarded. IT never learns about it | Send via SMTP or reword; store the contact |
| F15 | Low | audit.js:16-21; @cap-js db pool max 10 (db-service generic-pool.js:112) | Two concurrent writes (user action + 60 s timeout sweep/15-min sync) both read `max(seq)` and insert the same `seq`. The second business transaction fails with SQLITE_BUSY or a PK error, so the user sees a 500 | Serialize audit writes (single writer / retry) |
| F16 | Low | delivery.js:84; receipt.js:17-25 | `ts` is client-supplied and unchecked. A courier can backfill in-range readings with chosen timestamps so `traceComplete` passes | Clamp `ts` to [pickedUpAt, now+skew]; flag late-arriving points |
| F17 | Low | workflow.js:106-143 | Read-then-update without a conditional `WHERE status='PENDING_SUPPLIER'`. A concurrent double accept via OData (no idempotency key) can create two loans | `UPDATE … WHERE status=` and check the affected row count |
| F18 | Low | onboarding.js:36-37 | Fail-open: a pharmacist with **no** hospital attribute can onboard any licence, get a connector pairing code, and push stock as that hospital. Unreachable through `validateUser` (accounts.js:141-144), but fragile | Reject when `own` is missing and the user is not admin |
| F19 | Low | matcher/app.py:57-61, 76; solver.py:41,62 | `MATCHER_TOKEN` empty means open, and it binds 0.0.0.0 (app.py:90). The caller controls `maxPlans` × 2 s CP-SAT each, so an exposed matcher is a CPU DoS | Require the token outside dev; cap `maxPlans` |
| F20 | Low | accounts.js:114; server.js:118-119, 129; medisoft.js:12-16 | JWT in the WS query string can land in proxy logs (valid 8 h). The OAuth flow has no PKCE (RFC 9700 recommends it). The callback `postMessage(..., '*')` leaks the hospital ID to any opener | Short-lived WS ticket; PKCE S256; post to own origin |
| F21 | Low | handlers/settings.js:7 | Any pharmacist can set their hospital's safety margin 0-100% (PRD §10 says hospital admin). Setting 0 raises what is given away | Admin-only, or a hospital-admin flag |
| F22 | Low | receipt.js:55; delivery.js:61; ingest.js:81 | Received stock is inserted as `source:'TRANSFER'` and is never reconciled. When the receiver's HIS later reports it, it is counted twice. The supplier's pickup decrement is overwritten by its next HIS sync | Reconcile TRANSFER lots on the next source snapshot |

**Checked, nothing found:**
- **SQL built from strings:** all queries are CQL. geo.js:16 uses placeholders. The connector's view names are constants (connector.py:47-48).
- **XSS:** every server string goes through `esc()` (app.html:275), and server HTML escapes `hospital` (server.js:50).
- **Secrets in logs:** only `e.message` is logged; accounts and tokens are never logged.
- **WS context escape:** tracking.js:6-11 resets to the user's own contexts (ws-filter.test.js:37,47).
- **JWT:** `alg` pinned (accounts.js:89); sessions are revocable.
- **Token vault:** AES-GCM with AAD row binding (tokens.js:44).
- **Upload validation:** CSV is parsed safely (sheet.js). `/ingest` rejects un-hashed refs. Body limits are 5-8 MB.

---

## G. Frontend state

| Screen (`frontend/`) | State |
|---|---|
| `index.html` landing (Three.js blister pack) | Static marketing page; Google Fonts + cdnjs Three.js, no SRI |
| `app.html#/login` | **Mock** sign-in (app.html:309-322): hard-coded demo users, password `demo`, then HTTP Basic. Doesn't use `/auth/login` |
| `#/home` | Greeting, licence, cover **counts** (red/amber/green), task cards, derived alerts, journey cards. **Polls every 10 s** (app.html:700-702, 910) |
| `#/onboarding` | Checklist, MediSoft popup (postMessage), fallbacks (software, IT, sheet, photo). Polls every 4 s |
| `#/journey/:id` | Stage bar, facts (ETA, temp, loan), handling note, action buttons, timeline. **No map**. Polls |
| `#/city` | Aggregated rows |
| `#/admin` | Integrations + metrics. Shows "SAP services" wording |

**Missing screens/features:**
- Per-drug cover board with the 7/14/21 toggle.
- Shortfall card with affected bookings.
- Near-expiry list.
- Settings (safety margin; thresholds for new req 2).
- Disconnect button.
- Ledger list and settlement history.
- Audit-verify button.
- User management (admin `/auth/users` has no UI).
- Notifications inbox.
- Map / live tracking.
- WebSocket client.
- Camera barcode scanning: the `barcode` fields are plain inputs (app.html:745).
- Courier page (new req 3). Partner screens must leave the portal.

**PRD §13 asks for SAP UI5 / Fiori apps; the current UI is vanilla HTML/JS.** Options:

| Option | What it involves | Trade-off |
|---|---|---|
| Extend current UI (recommended for the deadline) | One-line login swap, delete `isLocal`, add WS client, Leaflet map, settings/alerts/ledger screens, courier page. All on existing `/me/*` + actions-as-data | Fastest. Keeps the tested experience layer. Not UI5, which may matter to SAP judges |
| UI5 freestyle (OpenUI5, Apache-2.0) | Rewrite ~1,000 lines of `app.html` into XML views/controllers. Use `JSONModel` over `/me/*`. Load UI5 from CDN or self-host (CSP must allow it). Barcode via `sap.ndc.BarcodeScannerButton` (check OpenUI5 availability and browser camera support). Add UI5 tooling | Full rewrite. `/me/*` contract is reusable |
| Fiori elements | Annotate OData services (`@UI.LineItem`, actions) in `services.cds`. Fits admin/config lists (thresholds, users, flags, hospitals). The journey/actions-as-data model does **not** map to List Report/Object Page | Cheap for admin screens only. A hybrid (Fiori elements admin + custom pharmacist UI) is plausible |

---

## H. Improvement opportunities (prioritised)

1. **Fix sign-in and hosting first** (F1). Swap to `/auth/login`, drop `isLocal`, and add a WS client. Then re-write STANDALONE_HOSTING for SQLite on a persistent disk. Repo-internal; no source needed.
2. **SQLite durability.** Use WAL mode, one writer, and continuous backup (Litestream or the SQLite backup API) plus restore drills; never copy the live `.db`. Source: [SQLite backup strategy (WAL + Litestream)](https://dev.to/helperx/sqlite-backup-strategy-for-production-saas-wal-litestream-recovery-tests-11jg).
3. **Courier capability links.** Treat them like passwords: HMAC/random, scoped to one transfer, expiring at delivery, revocable, no side effects on GET (pickup/telemetry via POST). Source: [W3C TAG – Good Practices for Capability URLs](https://www.w3.org/2001/tag/doc/capability-urls).
4. **Live tracking UX.** Use Leaflet with an interpolating marker (`moveTo(latlng, duration)`) so 5-30 s GPS fixes glide. Don't hammer `tile.openstreetmap.org`: cache tiles ≥7 days, and use a provider or self-hosted tiles for production. Sources: [Leaflet.MovingMarker](https://github.com/syonfox/Leaflet.MovingMarker), [OSM tile usage policy](https://wiki.openstreetmap.org/wiki/Tile_usage_policy).
5. **Expiry tiers.** Track by lot. Alert at 90/60/30 days (act at 90: transfer via MediLink or return), plus "expired: remove". Share a "short-dated (<6 months)" list for redistribution, which MediLink's near-expiry preference already supports. These tiers are industry practice, not regulation. Sources: [hospital pharmacy inventory practices](https://www.cleverence.com/amp/articles/for-business/hospital-pharmacy-inventory-management-best-practices-4821/), [SA hospital short-dated stock study](https://ojs.sabinet.co.za/index.php/sapj/article/download/3865/1889/21477), [90/60/30 alerting](https://erp.juleb.com/blog/Expiry-Date-Management-in-Pharmacies/en).
6. **Security headers + rate limits.** Add helmet (CSP limited to self + tile host) early in `cds.on('bootstrap')`. Add separate `express-rate-limit` budgets for login, `/ingest`, `/connector/pair`, `/me/actions`. In-memory limits don't share state across instances. Scanners flag CAP apps without rate limiting. Sources: [SAP KBA 3408218](https://userapps.support.sap.com/sap/support/knowledge/en/3408218), [Node.js hardening guide](https://dev.to/axiom_agent/nodejs-security-hardening-in-production-owasp-top-10-implementation-guide-5ff4).
7. **OAuth PKCE (S256)** on the MediSoft flow, even though CAP is a confidential client. Source: [RFC 9700 §2.1.1](https://www.rfc-editor.org/rfc/rfc9700).
8. **Row-level lock-down** of every OData projection the UI doesn't use (F2, F9, F10, F12). Repo-internal (`services.cds`).
9. **Ledger correctness** (F4, F5): a `repaysLoan_ID` on Transfer and a unique settlement link. Repo-internal.
10. **Anchor the audit chain.** Periodically HMAC or e-mail the head hash so a DB-level rewrite is detectable. Serialize writes (F15). Repo-internal (`audit.js`).
11. **Delete before adding.** Remove the BTP surface (§D1) and the duplicated mocked users. This leaves one backend test run instead of two. Repo-internal.

---

## I. Status after this build

Sections A–H above are the audit record of the code **before** this build (HEAD 329ab5f) and are left unchanged.
This section records what the build did about each finding. Tests are in `backend/test/` unless noted.


### I1. Bugs and security issues (§F)

| # | Status | What changed | Test |
|---|---|---|---|
| F1 | Fixed | UI sign-in through `POST /auth/login`, Bearer token, no `isLocal` branch (`frontend/js/app.js`) | `frontend.test.js` |
| F2 | Fixed | `ReceiptService.ConditionLogs` removed; live position and temperature only to the receiver and admin (`GET /me/journeys/{id}/tracking`, WS `tracking`), supplier gets a summary; `telemetry` WS event removed | courier-tracking.test.js (tracking), ws-filter.test.js |
| F3 | Fixed | Revoke deletes the hospital's Bookings (count in the `CONSENT_REVOKED` audit entry); lots kept for in-flight transfers; `connected=false` hospitals left out of matching and the city view | hardening.test.js "F3" |
| F4 | Fixed, one gap | `cancelRequest` cancels OPEN loans and open legs, notifies the supplier (`REQUEST_CANCELLED`), WS `CANCELLED` status, revokes the courier link. Not handled: a running SAP Build Process Automation instance is not cancelled | hardening.test.js "F4", courier-tracking.test.js |
| F5 | Fixed | One delivery settles one loan, once (`REPAYMENT_ALREADY_USED`); `Transfers.repaysLoan`; `SupplierService.accept(…, repaysLoan)` records no reverse loan (`REPAYMENT_WRONG_LOAN`) | hardening.test.js "F5" |
| F6 | Fixed | Duplicate batch rows are summed before insert | monitor.test.js "F6" |
| F7 | Fixed | `srv/lib/ratelimit.js`: login 5 failures per IP + username → 15 min pause, plus progressive delay per username; `/auth/*`, `/ingest`, `/connector/pair`, `/me/actions/*`, licence look-up, weather check, photo preview limited; IPv6 per /64; `TRUST_PROXY`. In memory, one process | hardening.test.js "F7" |
| F8 | Fixed | Strict CSP, nosniff, X-Frame-Options, Referrer-Policy, HSTS on HTTPS (`server.js securityHeaders`); no inline script/style; Leaflet, Three.js, QR, fonts self-hosted with SRI | `frontend.test.js` |
| F9 | Fixed | Audit entries admin-only; approvers keep `/audit/verify` | hardening.test.js "F9 / F10" |
| F10 | Fixed | `@restrict` on Plans, Exclusions, TransferLots, Approvals; RoadClosures projection removed (404) | hardening.test.js "F9 / F10" |
| F11 | Fixed | `partner` role and perspective removed; other hospitals get 404 on journeys and tracking | courier-tracking.test.js (tracking) |
| F12 | Fixed | Notifications read-only over OData | monitor.test.js "F12" |
| F13 | Fixed | Photo confirm merges its rows instead of replacing all sheet stock | monitor.test.js "F13" |
| F14 | Fixed | IT contact stored; only the setup link is emailed (never the pairing code), and only when SMTP is set; text no longer claims a send that did not happen | monitor.test.js "F14" |
| F15 | Not a bug | SQLite runs on one connection, so writes are serialised; the chain stays gap-free | hardening.test.js "F17 / F15" |
| F16 | Fixed | Courier `ts` clamped to [pickedUpAt, now + 60 s]; GPS-only phone fixes never count towards the temperature trace | courier-tracking.test.js |
| F17 | Fixed | Conditional state transitions (`WHERE status = expected`) | hardening.test.js "F17 / F15" |
| F18 | Fixed | Onboarding fails closed for a user with no hospital | hardening.test.js "F18 / F20" |
| F19 | Fixed | Matcher with `NODE_ENV=production` answers 503 without `MATCHER_TOKEN` (CAP uses greedy ranking); `maxPlans` capped at 5; `MATCHER_HOST` default 127.0.0.1 | matcher/tests/test_matcher.py |
| F20 | Fixed | PKCE S256 on the MediSoft flow (`OAuthStates.codeVerifier`); callback `postMessage` targets the `APP_BASE_URL` origin; single-use 30 s WebSocket tickets (`POST /auth/ws-ticket`), `?access_token=` refused | hardening.test.js "F18 / F20", auth.test.js |
| F21 | Fixed | Safety margin needs approver or admin | monitor.test.js "F21" |
| F22 | Fixed, heuristic | A received TRANSFER lot is dropped once the hospital's own feed reports that batch in at least the received quantity (`shortcut:` comment) | hardening.test.js "F22" |

### I2. BTP removal (§D) and doc claims (§C)

| Item | Status |
|---|---|
| §D1 REMOVE list (CF/MTA, HANA Cloud, XSUAA, app router, Destination, PostgreSQL, BTP env vars, BTP-only tests, dead `BPA_DESTINATION`) | Done. One SQLite file, MediLink accounts in every profile; profiles `development`, `test`, `production` |
| §D2 optional SAP integrations | Done: AI Core, BPA and Alert Notification are no longer force-disabled; Alert Notification credentials come from `ALERT_NOTIFICATION_URL` / `_CLIENT_ID` / `_CLIENT_SECRET`. Steps in `docs/SAP_INTEGRATIONS.md` |
| §C1 "Matcher LLM rewrite is AI Core only" | Fixed: `matcher/explain.py` also uses `openai-compatible` |
| §C1 `IdempotencyKeys` never cleaned | Fixed: `jobs.cleanup()` daily (idempotency keys, photo previews, sessions, OAuth states, pairing codes) |
| §C1 "Alert emails to one list" | Fixed: per-hospital digests to its pharmacists and approvers with `Users.email`, else `Hospitals.adminEmail`, else `ALERT_EMAIL_TO` |
| §C3 "325 passing" not reproducible | Superseded: `deployment.test.js` deleted with the app router; current counts in `HANDOVER.md` |
| §C3 STANDALONE_HOSTING / README stale claims | Superseded: replaced by `docs/HOSTING.md` and a rewritten `README.md` |
| §C3 "IT setup link auto-sent" | Fixed (F14) |

### I3. New requirements (§E)

| Requirement | Status | Where |
|---|---|---|
| E2 Stock and expiry monitoring (PRD FR-29) | Done: backend + Stock screen, home summary, settings | `srv/lib/monitor.js`, `GET /me/stock`, `GET /me/notifications`, actions `ack-alert`, `set-reorder-level`, `set-alert-email` |
| E3 Pharmacist-only portal, courier links (FR-30, FR-31) | Done: backend + `frontend/courier.html` | `srv/lib/courier.js`, `/courier/*`, actions `courier-link`, `reissue-courier-link` |
| E4 Live tracking for the receiver (FR-32) | Done: backend + Leaflet live map on the journey screen | `srv/lib/tracking.js`, `GET /me/journeys/{id}/tracking`, WS `tracking` |

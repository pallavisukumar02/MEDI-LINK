# MediLink: going live on SAP BTP (free plans only)

A beginner checklist, in order. Tick each box. Commands are for **Windows PowerShell** (they work the same in a
bash terminal unless marked). Nothing here costs money: only pick plans whose name says **free**, **lite**,
**hdi-shared** or **application**. Never pick a plan without "free" in the name for HANA Cloud, AI Core or Build.

> Everything below was **prepared but not run against a real SAP account** (none existed while building). The code
> paths, configuration and checks are in place and tested offline (`npm test`, `npm run test:hana-compat`).
> Expect to fix small details (region names, menu labels) as SAP updates its cockpit.

**Time:** about 2 hours the first time. **You end with:** hybrid mode (your laptop + SAP HANA Cloud), then the whole
app on Cloud Foundry behind an app router with SAP login.

---

## Part 0 · Tools on your laptop (once)

- [ ] Node.js 20 or newer: `node -v`
- [ ] Python 3.11 or newer: `python --version`
- [ ] SAP CAP tools: `npm i -g @sap/cds-dk` then `cds --version`
- [ ] MTA build tool: `npm i -g mbt`. **Windows only:** mbt needs GNU make: `winget install GnuWin32.Make` (or `choco install make`), then open a new PowerShell and check `make --version`.
- [ ] Cloud Foundry CLI v8: download the Windows installer from https://github.com/cloudfoundry/cli/releases , install, open a new PowerShell, check `cf version`.
- [ ] MultiApps plugin: `cf install-plugin multiapps -f`
- [ ] In the repo folder: `npm run setup` then `npm test` must be green before you start.

## Part 1 · SAP BTP account and space (cockpit, once)

1. [ ] Open the SAP BTP cockpit (https://cockpit.btp.cloud.sap) and sign in. Use the Hackfest practice system if you have one; otherwise a Pay-As-You-Go account with free tier (it never charges while you stay on free plans).
2. [ ] **Global account → Account Explorer → Create → Subaccount.** Name `medilink`, pick a region close to Bengaluru that offers SAP HANA Cloud (e.g. Singapore). Create.
3. [ ] Open the subaccount → **Overview → Cloud Foundry Environment → Enable Cloud Foundry**. Keep the suggested org name. Write down the **API Endpoint** shown (e.g. `https://api.cf.ap21.hana.ondemand.com`).
4. [ ] Same page → **Create Space** → name `dev` → tick both Space Manager and Space Developer for yourself.
5. [ ] **Entitlements → Edit → Add Service Plans** and add **only these** (search by name):
   | Service | Plan |
   |---|---|
   | SAP HANA Cloud | `hana-free` (and `tools`) |
   | SAP HANA Schemas & HDI Containers | `hdi-shared` |
   | Authorization and Trust Management Service | `application` |
   | Destination Service | `lite` |
   | Cloud Foundry Runtime | free tier memory |
   | *optional* SAP Build Process Automation | `free` |
   | *optional* SAP AI Core | the free / trial plan |
   | *optional* Alert Notification | the free / lite plan |

   **Save.** If a service only shows paid plans, do not add it: MediLink works without it.

## Part 2 · SAP HANA Cloud database (cockpit, once)

1. [ ] Subaccount → **Services → Instances and Subscriptions → Create**: service **SAP HANA Cloud**, plan **tools** → Create. This subscribes *SAP HANA Cloud Central*.
2. [ ] Open **SAP HANA Cloud Central** from the subscriptions list → **Create Instance** → *SAP HANA Cloud, SAP HANA Database* → choose the **free tier** option.
3. [ ] Instance name `medilink-hana`, set a strong **DBADMIN** password (store it in your password manager; MediLink never needs it).
4. [ ] **Connections:** choose *Allow all IP addresses* (fine for a prototype with synthetic data; restrict later).
5. [ ] **Instance mapping / Cloud Foundry:** map the instance to your org and space `dev` (Central → instance → *Manage Configuration → Instance Mapping → Add*: environment *Cloud Foundry*, Org ID and Space ID from the commands below).
   ```powershell
   cf login -a <API Endpoint from Part 1> --sso      # opens a browser for the one-time code
   cf target -s dev
   cf orgs                                          # shows your org name
   cf org <your org name> --guid                    # Org ID
   cf space dev --guid                              # Space ID
   ```
6. [ ] Wait until the instance shows **Running**. Free tier instances **stop every night**: start them again in HANA Cloud Central before you work or demo.

## Part 3 · Hybrid mode: your laptop + SAP HANA Cloud

Hybrid keeps the demo users (`asha` / `demo` …) but stores data in HANA Cloud and hospital tokens in the Destination service.

```powershell
cf target -s dev
cf create-service hana hdi-shared medilink-db
cf create-service destination lite medilink-destination
cf services                                      # wait until both say "create succeeded"
cd backend
cds bind -2 medilink-db                          # writes .cdsrc-private.json (git-ignored, holds no secrets in git)
cds bind -2 medilink-destination
npm run seed --prefix ..                          # fresh, date-relative synthetic seed
cds deploy --to hana --profile hybrid             # creates the tables and loads the synthetic seed into HANA
cds watch --profile hybrid                        # or from the repo root: npm run watch:hybrid
```

Do **not** create the XSUAA service here: hybrid uses the demo users, and the deployment in Part 4 creates XSUAA with the right name.

- [ ] Start the two helpers in two more PowerShell windows (repo root):
  ```powershell
  node mock-medisoft/server.js                                    # terminal 2 (MediSoft HIS)
  node scripts/py.js matcher -m uvicorn app:app --port 5001       # terminal 3 (OR-Tools)
  ```
- [ ] Check the integrations (expect **SAP HANA Cloud: connected**, **HANA spatial distances: connected**, **SAP Destination service: connected**):
  ```powershell
  $h = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('admin:demo')) }
  (Invoke-RestMethod http://localhost:4004/health/integrations -Headers $h).items | Format-Table service, status, text -Wrap
  ```
- [ ] Run the experience demo once: `npm run demo:experience` (it needs a fresh seed: run `cds deploy --to hana --profile hybrid` again before each run).

## Part 4 · Deploy to Cloud Foundry

1. [ ] Secrets file (never commit it):
   ```powershell
   Copy-Item secrets.mtaext.example secrets.mtaext
   # one random value per "change-me" line (run once per value):
   $b = New-Object byte[] 16; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''
   notepad secrets.mtaext                          # paste the values; the same salt / client secret goes to srv and medisoft
   ```
2. [ ] Build and deploy:
   ```powershell
   npm run seed
   npm run build:mta                                # mbt build -t mta_archives
   cf deploy mta_archives/medilink_1.0.0.mtar -e secrets.mtaext
   ```
   This creates `medilink-uaa` (XSUAA), reuses `medilink-db` and `medilink-destination`, loads the schema + synthetic
   seed into HANA and starts five apps: `medilink-approuter` (128 MB), `medilink-srv` (256 MB), `medilink-matcher`
   (512 MB), `medilink-medisoft` (128 MB) and the one-off `medilink-db-deployer`.
3. [ ] `cf apps` → copy the URL of **medilink-approuter**. That is the only URL users open.

## Part 5 · Give people access (cockpit)

MediLink roles carry the hospital or courier the user works for.

1. [ ] Subaccount → **Security → Roles → Create Role**: application `medilink-…`, template **pharmacist**, name `Pharmacist_H1`, attribute **hospital** = static value `H1`. Repeat per hospital (`H2` … `H5`) and for **approver** (`Approver_H5`, …) and **partner** (attribute **partner** = `P1`).
2. [ ] **Security → Role Collections → Create**: e.g. `MediLink_Pharmacist_H1` → add role `Pharmacist_H1`. `MediLink_Admin` already exists.
3. [ ] **Security → Users** → pick a user → **Assign Role Collection**.
4. [ ] Open the app router URL, sign in, then open `/me/home`. A user without a hospital attribute sees the plain message "Your account has no hospital".
5. [ ] As an admin user open `/health/integrations`: expect HANA Cloud, HANA spatial, XSUAA and Destination **connected**; Build Process Automation and AI Core **fallback** until Part 6.

## Part 6 · Optional switches (MediLink works without them)

Flip one at a time, redeploy (`cf deploy … -e secrets.mtaext`), then check `/health/integrations`. A switch that is on
but not fully configured shows **misconfigured** and MediLink keeps using its built-in fallback.

**SAP Build Process Automation** (`APPROVAL_MODE=bpa`)
1. [ ] Subaccount → **Boosters** → *Set up account for SAP Build Process Automation* (free plan) → run.
2. [ ] In SAP Build, create a process with the steps in README §8 (supplier form → approver form(s) → 30-minute timer) that calls `/workflow/*` with a technical user holding the `system` scope.
3. [ ] Add to `secrets.mtaext` under `medilink-srv`: `APPROVAL_MODE: bpa`, `BPA_API_URL`, `BPA_DEFINITION_ID`, `BPA_TOKEN_URL`, `BPA_CLIENT_ID`, `BPA_CLIENT_SECRET` (from the BPA service key).

**SAP AI Core** (`LLM_PROVIDER=aicore`: photo reading, alert parsing, friendlier notes)
1. [ ] Create an AI Core instance (free / trial plan) and open SAP AI Launchpad → *Generative AI Hub* → deploy a chat model with vision (for example a GPT-4o family model) in resource group `default`.
2. [ ] Bind it: `cf bind-service medilink-srv <your-aicore-instance>` (the SAP Cloud SDK for AI reads the binding), or for hybrid save the service key as `backend/aicore-key.json` (git-ignored).
3. [ ] Add under `medilink-srv`: `LLM_PROVIDER: aicore` and `AICORE_MODEL_NAME: <the model name you deployed>`.

**SAP Alert Notification** (email alerts)
1. [ ] Create an Alert Notification instance (free plan), add an email action + condition for events `MediLink*`, bind it to `medilink-srv`.
2. [ ] Add `ALERT_NOTIFICATION_ENABLED: true` and `ALERT_EMAIL_TO: <address>`.

## Part 7 · Before every demo

- [ ] Start the HANA Cloud instance (it stops nightly).
- [ ] `npm run seed`, then redeploy or `cds deploy --to hana --profile hybrid`, so the synthetic dates are current.
- [ ] Open `/health/integrations` as admin: nothing **misconfigured**.

## Troubleshooting

| You see | Do this |
|---|---|
| `cf deploy` stops with "another operation in progress" | `cf deploy -i <operation id> -a abort`, then deploy again |
| `mbt build` says make is missing | install GNU make (Part 0) and open a new PowerShell |
| `/health/integrations`: SAP HANA Cloud **fallback** in hybrid | you ran without `--profile hybrid`, or `cds bind` was not run in `backend/` |
| Database errors after a night | HANA Cloud stopped: start it in HANA Cloud Central |
| "Not available for your role" | the user's role collection is missing or has no hospital / partner attribute |
| Live updates do not arrive behind the router | `app/router/xs-app.json` must keep `"websockets": { "enabled": true }` |

## What is checked offline vs. only on a real account

| Checked by `npm test` (no SAP account) | Only verifiable on SAP BTP |
|---|---|
| Model compiles to HANA tables; every query the app runs renders as HANA SQL; no SQLite-only SQL; no timestamp/string comparisons | Running those queries on HANA Cloud |
| `ST_Distance` query text and the switch between HANA and Haversine | HANA spatial results on a live instance |
| mta.yaml: free plans only, app router module, XSUAA + destination wiring, xs-app.json routes | `mbt build` + `cf deploy`, XSUAA login, role collections |
| BPA / AI Core / Alert Notification switches fall back cleanly and report "misconfigured" | Real BPA process, AI Core model calls, email delivery |

## Moving from standalone to BTP

If MediLink has been running without BTP (`docs/STANDALONE_HOSTING.md`), nothing in the code changes: the profile does.
Standalone is selected only by `CDS_ENV=standalone` / `standalone-pg`; remove that and the BTP profiles above apply again.

1. [ ] **Export the data** (on the machine whose `backend/.env` points at the standalone database):
   `npm run db:export` (SQLite file) or `npm run db:export -- --pg` (PostgreSQL). This writes every MediLink table as CAP
   seed CSVs to `backend/db/export/`. Accounts, sessions and the encrypted hospital tokens are deliberately left out.
2. [ ] **Load it into HANA Cloud**: copy the CSVs over `backend/db/data/` (keep the old seed in git if you want it back), then
   Part 3: `cds deploy --to hana --profile hybrid`. The audit chain, ledger, transfers and connector tokens (stored hashed) come across as they are.
   Set `SEED_AUTO_REFRESH=false` in `backend/.env` first and do not run `npm run seed`: both would overwrite the copied
   CSVs with fresh synthetic data.
3. [ ] **Map the users to XSUAA role collections** (Part 5). `GET /auth/users` as a standalone admin lists everyone:

   | Standalone user | XSUAA |
   |---|---|
   | role `pharmacist`, hospital `H1` | role from template **pharmacist**, attribute hospital = `H1`, in a collection such as `MediLink_Pharmacist_H1` |
   | role `approver`, hospital `H5` | template **approver**, hospital = `H5` |
   | role `partner`, partner `P1` | template **partner**, attribute partner = `P1` |
   | role `admin` | role collection `MediLink_Admin` |
   | role `system` (`bpa`) | not a person: BPA uses the client-credentials token of `medilink-uaa` |

   Passwords do not move: people sign in with their SAP BTP / identity-provider account. User IDs in old audit entries stay as they were.
4. [ ] **Reconnect the hospitals.** Hospital access tokens were encrypted with `TOKEN_ENCRYPTION_KEY` and are not exported.
   Each MediSoft hospital opens MediLink and presses **Connect** again (the new token goes to the Destination service).
   Update `MEDISOFT_OAUTH_REDIRECT_URI` / `MEDISOFT_ALLOWED_REDIRECTS` to the app router URL. Database connectors keep their
   token but need `CONNECTOR_INGEST_URL` changed to the new URL. The SAP sandbox hospital needs nothing.
5. [ ] **Switch the services back on** (Part 6): `APPROVAL_MODE=bpa`, `LLM_PROVIDER=aicore`, `ALERT_NOTIFICATION_ENABLED=true`
   as wanted; remove `CDS_ENV=standalone…`, `DATABASE_URL`, `AUTH_JWT_SECRET` from the deployment. `SMTP_*` may stay
   (email is used when Alert Notification is off).
6. [ ] Check `/health`: `"mode": "sap-btp"`, and `/health/integrations` lists the SAP services as **connected**.

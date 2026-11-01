# Running MediLink without SAP BTP (standalone mode)

Standalone mode runs the same MediLink (SAP CAP backend, same `/me/*` API, same rules) **without any SAP BTP service**:

| SAP BTP service | Standalone replacement |
|---|---|
| SAP HANA Cloud | SQLite file on your laptop, or a hosted PostgreSQL database online |
| XSUAA (login, roles) | MediLink accounts: username + password, signed login tokens (JWT) |
| Destination service | Hospital access tokens stored encrypted (AES-256-GCM) in the database |
| Build Process Automation | MediLink's built-in approvals (always on) |
| Alert Notification | In-app alerts, plus email over any SMTP server (optional) |
| AI Core | No AI (templates), or any OpenAI-compatible API (optional) |
| Cloud Foundry | Your laptop, or any Node.js host + Python host |

No Docker, no containers, no database server on your machine. Everything here is free; where a provider is mentioned,
**check its current free-tier limits** before you rely on it. All data is synthetic.

Part A runs it on your laptop for a demo. Part B puts it online.

---

## Part A: on your laptop (about 10 minutes)

You need **Node.js 20 or newer** and **Python 3.11 or newer**. Every command below works in PowerShell (Windows) and in a
Linux/macOS terminal. Run them in the `MEDI-LINK` folder.

### A1. Install

```
npm run setup
```

### A2. Create your settings file

Windows (PowerShell): `copy backend\.env.example backend\.env` · Linux/macOS: `cp backend/.env.example backend/.env`

If you already have a `backend/.env`, keep it; step A3 tells you what to add.

### A3. Fill in three secrets

Make a random value (run it once per secret, copy the output):

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Open `backend/.env` in a text editor and set:

| Variable | What to put |
|---|---|
| `AUTH_JWT_SECRET` | a random value from the command above |
| `TOKEN_ENCRYPTION_KEY` | another random value (keep it: if it changes, hospitals must press Connect again) |
| `DEMO_PASSWORD` | a password of at least 8 characters for the demo users |

Then check:

```
npm run env:check
```

It lists, in plain words, anything still missing. It never prints your values.

### A4. Create the database

```
npm run db:init
```

This creates `backend/db/medilink.sqlite` with the tables, the synthetic seed data and the demo users
(`asha`, `ravi`, `sunil`, `lata`, `hari`, `meera`, `kiran`, `anil`, `deepa`, `partner`, `sim`, `courier2`, `admin`, `bpa`),
all with your `DEMO_PASSWORD`. Running it again keeps your data. To start again from scratch: `npm run db:reset`.

### A5. Start everything

```
npm run start:standalone
```

This starts MediLink (CAP, port 4004), the ranking service (5001), the mock hospital software MediSoft (4100) and the
courier simulator. Stop with Ctrl+C. The data stays in the file: stop and start as often as you like.

### A6. Check it works

- Open http://localhost:4004/health. You should see `"mode": "standalone"` and
  `"services": "Database: SQLite file (standalone) · Logins: MediLink accounts · Approvals: built-in · Email: off · AI: off"`.
- Sign in (any HTTP tool, or the UI): `POST http://localhost:4004/auth/login` with `{"username": "asha", "password": "<DEMO_PASSWORD>"}`.
  The answer has a `token`; send it as `Authorization: Bearer <token>` on every other call.
- Run the whole demo in a second terminal: `npm run demo:experience` (it signs in as each demo user through `/auth/login`).
  The demo changes the data; before running it again: stop, `npm run db:reset`, start again.

### Optional on the laptop

| Want | Set in `backend/.env` |
|---|---|
| Email alerts | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` (any SMTP server or mail provider) |
| AI (photo reading, nicer notes) | `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (any OpenAI-compatible API) |
| Real road distances | `ORS_API_KEY` (free account at openrouteservice.org) |
| Live SAP sandbox hospital | `SAP_API_HUB_KEY` (free key from api.sap.com; this is not BTP) |

Restart `npm run start:standalone` after changing `backend/.env`.

---

## Part B: online (free hosts)

You will create four things. Write each URL down as you go.

| Piece | Kind of host | Folder | Start command | Health check |
|---|---|---|---|---|
| Database | hosted PostgreSQL | - | - | - |
| Ranking service (matcher) | Python web service | `matcher` | `python app.py` | `GET /health` |
| Mock hospital software (MediSoft) | Node.js web service | `mock-medisoft` | `node server.js` | `GET /health` |
| MediLink (CAP) | Node.js web service | `backend` | `npm start` | `GET /health` |

Every host below needs: the repository (connect your Git repository or upload it), a **root/working directory**, a
**build command**, a **start command** and **environment variables**. Hosts give each service a `PORT` variable and an
HTTPS address; all three services read `PORT`. Free plans often put a service to sleep when idle, so the first request
after a pause can take a while.

### B1. Database (hosted PostgreSQL)

1. Create a free PostgreSQL database with any provider (check its current free-tier limits).
2. Copy its **connection string**. It looks like `postgresql://user:password@host:5432/dbname`.
   It contains a password: treat it like one.
3. On your laptop, put it in `backend/.env`:
   ```
   CDS_PROFILE=standalone-pg
   DATABASE_URL=postgresql://user:password@host:5432/dbname
   ```
4. Create the tables, seed data and demo users from your laptop:
   ```
   npm run env:check
   npm run db:init:pg
   ```
   SSL is always on. Only if the provider uses a self-signed certificate, add `?sslmode=no-verify` to the end of the URL.
   `npm run db:reset:pg` wipes it and starts again.

### B2. Ranking service (Python host)

- Root directory: `matcher`
- Build command: `pip install -r requirements.txt`
- Start command: `python app.py`
- Environment: `MATCHER_TOKEN` = a new random value (the same value goes to MediLink in B4)
- Check: open `https://<matcher-address>/health`, it answers `{"status": "UP", ...}`.

### B3. Mock hospital software MediSoft (Node host)

- Root directory: `mock-medisoft`
- Build command: `npm install`
- Start command: `node server.js`
- Environment:
  `MEDISOFT_OAUTH_CLIENT_ID=medilink-client`, `MEDISOFT_OAUTH_CLIENT_SECRET` (random), `PATIENT_REF_HASH_SALT` (random),
  `MEDISOFT_ALLOWED_REDIRECTS=https://<medilink-address>/oauth/medisoft/callback`
  (you will know the MediLink address after B4; come back and set it, then restart).
- Check: `https://<medisoft-address>/health`.

### B4. MediLink (Node host)

- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Environment (copy the values from your laptop's `backend/.env` where you have them):

| Variable | Value |
|---|---|
| `CDS_ENV` | `standalone-pg` (this switches MediLink to standalone mode with PostgreSQL) |
| `DATABASE_URL` | the connection string from B1 |
| `AUTH_JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` | random values (do not reuse the laptop ones in public) |
| `AUTH_JWT_TTL` | `8h` |
| `APP_BASE_URL` | `https://<medilink-address>` |
| `MATCHER_URL`, `MATCHER_TOKEN` | `https://<matcher-address>` and the token from B2 |
| `MEDISOFT_BASE_URL` | `https://<medisoft-address>` |
| `MEDISOFT_OAUTH_CLIENT_ID`, `MEDISOFT_OAUTH_CLIENT_SECRET` | same values as in B3 |
| `MEDISOFT_OAUTH_REDIRECT_URI` | `https://<medilink-address>/oauth/medisoft/callback` |
| `PATIENT_REF_HASH_SALT` | same value as in B3 |
| `CONNECTOR_PAIRING_SECRET` | random |
| `DEMO_FRESH_SEED` | `true` for a demo, `false` for real hospitals |
| optional | `SMTP_*`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`, `LLM_*`, `ORS_API_KEY`, `SAP_API_HUB_KEY` |

You do not need `DEMO_PASSWORD` online: the users already exist from B1.

- Check: open `https://<medilink-address>/health`. It must say `"mode": "standalone"` and
  `"services": "Database: PostgreSQL (standalone) · Logins: MediLink accounts · Approvals: built-in · Email: ... · AI: ..."`.
  If MediLink does not start, the host's log names the missing variable in plain words.
- Sign in as `admin`, then open `GET /health/integrations` with the token: every line should be `connected`
  (or `fallback` for the optional pieces you left out).

### B5. After it is online

1. Change the demo passwords, or create real accounts (admin only):
   - create: `POST /auth/users` `{"username", "password", "role": "pharmacist|approver|partner|admin", "hospital": "H1"}` (`"partner": "P1"` for couriers)
   - reset a password: `POST /auth/users/<username>/reset-password` `{"password"}`
   - switch an account off / on: `POST /auth/users/<username>/disable` / `.../enable`
   - list: `GET /auth/users`
2. Courier telemetry: run the simulator on your laptop against the online MediLink:
   set `APP_BASE_URL=https://<medilink-address>`, `SIM_USER=sim`, `SIM_PASSWORD=<sim's password>` in `backend/.env`, then `node simulator/index.js`.
3. A database connector for a real hospital pharmacy points `CONNECTOR_INGEST_URL` at `https://<medilink-address>/ingest`.

### Safety notes

- Five wrong passwords pause that account for 15 minutes. The message never says whether the username exists.
- Logging out, disabling an account or resetting its password ends its sessions immediately.
- Secrets live only in the host's environment settings or your git-ignored `backend/.env`. Never commit them.
- Patient names never enter MediLink; patient numbers are hashed at the source.
- To move to SAP BTP later, see "Moving from standalone to BTP" in `docs/SAP_GO_LIVE.md`.

# Hosting MediLink (production, SQLite)

MediLink in production is **one CAP process on one SQLite file**, plus the OR-Tools matcher next to it. No database server,
no Docker, no SAP BTP. Commands run in the repo folder. All seed data is synthetic.

| Process | Start | Listens on | Public? |
|---|---|---|---|
| MediLink (CAP + UI + WebSocket) | `npm start` (= `node scripts/start.js`, sets `NODE_ENV=production`) | `PORT` (4004) | Yes, only through the HTTPS proxy |
| Matcher (OR-Tools) | `python app.py` in `matcher/` | `MATCHER_HOST:PORT` (127.0.0.1:5001) | No |
| Mock MediSoft | `node server.js` in `mock-medisoft/` | `MEDISOFT_PORT` (4100) | Demo only |
| Courier simulator | `node simulator/index.js` | – | Demo only |

## 1. Pick a host

The SQLite file must survive restarts and redeploys: **the host needs a persistent disk**.

| Option | Persistent disk | Notes |
|---|---|---|
| A Linux machine you control (hospital server, office PC) | Yes | Simplest. Still needs HTTPS (§5) |
| Oracle Cloud "Always Free" VM | Yes | Free tier VM; check current limits and region capacity |
| Google Cloud `e2-micro` free tier | Yes | Free in some US regions only; 1 GB RAM is tight for CAP + matcher |
| Small paid VPS (any provider) | Yes | A few USD/EUR per month |
| PaaS with a volume add-on (e.g. Fly.io, Railway) | Yes, if you attach a volume | Usage-billed. Point `CDS_REQUIRES_DB_CREDENTIALS_URL` at the volume |
| PaaS without a disk (e.g. Render free web services) | **No** | The database is lost on every restart or redeploy: **not suitable** |

Check each provider's current free-tier terms before relying on them. One MediLink process per database file: do not run
several app instances on one file (rate-limit counters are in memory, per process).

## 2. Install

Node.js **22.12+** (SAP CAP 10), Python **3.11+**, git.

```bash
git clone <repo> /opt/medilink && cd /opt/medilink
python3 -m venv .venv                       # Debian/Ubuntu block system-wide pip
PYTHON=/opt/medilink/.venv/bin/python npm run setup
```

## 3. Configure

```bash
cp backend/.env.example backend/.env && chmod 600 backend/.env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # one fresh value per secret
NODE_ENV=production npm run env:check       # PowerShell: $env:NODE_ENV='production'; npm run env:check
```

Production never creates secrets or demo users by itself. The exact list to fill in is [`HANDOVER.md` → ENV](../HANDOVER.md#env).

### Secrets checklist

| Secret | Rule | If lost or changed |
|---|---|---|
| `AUTH_JWT_SECRET` | 32+ random chars; server refuses to start without it | Everyone is signed out |
| `TOKEN_ENCRYPTION_KEY` | 32+ random chars; server refuses to start without it. **Back it up with the database** | Stored hospital tokens cannot be decrypted: every MediSoft hospital must press Connect again |
| `PATIENT_REF_HASH_SALT` | Random; same value at MediSoft and the connector | Patient refs from old and new feeds no longer match |
| `MEDISOFT_OAUTH_CLIENT_SECRET` | Random; same value at CAP and MediSoft | Allow flow fails until both match |
| `CONNECTOR_PAIRING_SECRET` | Random | Unused pairing codes stop working |
| `MATCHER_TOKEN` | Random; same value at CAP and the matcher | Ranking falls back to the greedy method |
| `DEMO_PASSWORD` | 8+ chars, only for `db:init` | – |
| `SMTP_PASS`, `LLM_API_KEY`, `BPA_CLIENT_SECRET`, `ALERT_NOTIFICATION_CLIENT_SECRET`, `SAP_API_HUB_KEY`, `ORS_API_KEY` | Only if that option is used | That option stops |

Keep secrets in `backend/.env` (git-ignored, mode 0600) or the host's secret settings. Never commit, print or log them.

Email (SMTP) is how alerts and courier links leave MediLink. Without it alerts stay in the app, and the supplying hospital copies the
courier link from the delivery (`courier-link` action) and sends it to the courier itself.

## 4. Database on the persistent disk

`backend/db/` holds the schema and seed CSVs, so do not mount a volume over it. Put the file elsewhere:

```bash
mkdir -p /var/lib/medilink
echo "CDS_REQUIRES_DB_CREDENTIALS_URL=/var/lib/medilink/medilink.sqlite" >> backend/.env
NODE_ENV=production npm run db:init         # schema + synthetic seed + demo users with DEMO_PASSWORD (8+ chars)
```

`db:init` never overwrites an existing database. CAP runs SQLite in WAL mode: `medilink.sqlite-wal` and `-shm` sit next to the
file and belong to it.

First sign-in: sign in as `admin` with `DEMO_PASSWORD`, then (`Authorization: Bearer <token>`):

| Step | Call |
|---|---|
| Create real accounts | `POST /auth/users {"username","password","role":"pharmacist"\|"approver"\|"admin","hospital":"H1","email":"…"}` |
| Change the admin password | `POST /auth/users/admin/reset-password {"password"}` |
| Switch off unused demo accounts | `POST /auth/users/<name>/disable` |

`npm start` refuses to start while an enabled demo account still has the development password `demo`.

**No migrations.** An update that adds columns needs `npm run db:reset`, which **deletes all data**. Back up first, and add a
migration path before real data goes in (HANDOVER → How to continue).

## 5. HTTPS, reverse proxy, `TRUST_PROXY`

HTTPS is required: browsers only allow location sharing and the camera on HTTPS pages (courier page, barcode scans), and
passwords and tokens must not cross the network in clear text. Simplest: [Caddy](https://caddyserver.com) on the same machine
(automatic Let's Encrypt certificates, WebSockets pass through):

```
# /etc/caddy/Caddyfile
medilink.example.org {
    reverse_proxy 127.0.0.1:4004
}
```

| Set in `backend/.env` | Why |
|---|---|
| `APP_BASE_URL=https://medilink.example.org` | Links in emails; the OAuth callback page only posts to this origin |
| `TRUST_PROXY=1` | One proxy in front: `req.ip` is the real client, so rate limits work. Never `true`. Several hops: their count, or the proxy IPs/CIDRs |
| `MEDISOFT_OAUTH_REDIRECT_URI=https://medilink.example.org/oauth/medisoft/callback` | OAuth redirect (and the same URL in MediSoft's `MEDISOFT_ALLOWED_REDIRECTS`) |
| `CONNECTOR_INGEST_URL=https://medilink.example.org/ingest` | On each hospital's connector machine |

Do not expose port 4004 directly: firewall it to localhost.

## 6. Run the matcher privately

| Matcher env (its own process, **not** `backend/.env`: that file's `PORT` is CAP's) | Value |
|---|---|
| `NODE_ENV` | `production` (then it refuses to rank without a token: 503, and CAP uses its greedy fallback) |
| `MATCHER_TOKEN` | Same value as in `backend/.env` |
| `MATCHER_HOST` | `127.0.0.1` (default) on the same machine; `0.0.0.0` only on its own host, behind HTTPS |
| `PORT` | `5001` (default) |
| optional | `ORS_API_KEY`, `ROAD_FACTOR`, `CITY_SPEED_KMH`, `ROUTE_HANDLING_MIN`; `LLM_PROVIDER` + `LLM_*` / `AICORE_*` for plan wording |

CAP side: `MATCHER_URL=http://127.0.0.1:5001` (or the matcher's HTTPS URL) and `MATCHER_TOKEN`. Check with
`GET /health/integrations` → "OR-Tools ranking service: connected".

## 7. Run as services (Linux, systemd)

```ini
# /etc/systemd/system/medilink.service
[Unit]
Description=MediLink (CAP)
After=network.target
[Service]
User=medilink
WorkingDirectory=/opt/medilink
ExecStart=/usr/bin/node scripts/start.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/medilink-matcher.service
[Unit]
Description=MediLink matcher (OR-Tools)
After=network.target
[Service]
User=medilink
WorkingDirectory=/opt/medilink/matcher
EnvironmentFile=/etc/medilink/matcher.env
ExecStart=/opt/medilink/.venv/bin/python app.py
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

`/etc/medilink/matcher.env` (mode 0600) holds the §6 variables. Use the real `node` path (`which node`). Then
`systemctl enable --now medilink medilink-matcher`.

## 8. Backups

Never copy the live file with `cp` while MediLink runs (WAL: the copy can be inconsistent). Use one of:

| Method | How | Restore |
|---|---|---|
| Daily online backup (SQLite CLI, `apt install sqlite3`) | cron: `sqlite3 /var/lib/medilink/medilink.sqlite ".backup '/var/backups/medilink/medilink-$(date +%F).sqlite'"`, keep N days, copy off the machine | Stop MediLink, delete `medilink.sqlite-wal` / `-shm`, copy the backup to `medilink.sqlite`, start |
| Continuous ([Litestream](https://litestream.io)) to S3-compatible storage | `/etc/litestream.yml` below; run its service next to MediLink | Stop MediLink, `litestream restore -o /var/lib/medilink/medilink.sqlite s3://BUCKET/medilink`, start |

```yaml
# /etc/litestream.yml
dbs:
  - path: /var/lib/medilink/medilink.sqlite
    replicas:
      - url: s3://BUCKET/medilink
```

Back up `backend/.env` (at least `TOKEN_ENCRYPTION_KEY`) separately, in a password manager: a database backup without that key
loses the hospital connections. Test a restore before go-live.

## 9. Checks after go-live

| Check | Expect |
|---|---|
| `NODE_ENV=production npm run env:check` | "All required variables are set." |
| `GET https://<host>/health` | `"status":"UP"`, `"profile":"production"`, `services` line |
| `GET /health/integrations` (admin) | Nothing `misconfigured`; optional parts you left off are `fallback` |
| Sign in through the UI over HTTPS | Works; after 5 wrong passwords for one user the next `POST /auth/login` from that IP gets 429 |

## 10. Updates

```bash
git pull && PYTHON=/opt/medilink/.venv/bin/python npm run setup && systemctl restart medilink medilink-matcher
```

If `backend/db/schema.cds` changed, see "No migrations" in §4.

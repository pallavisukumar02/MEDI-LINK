# MediLink project rules

- Free SAP/BTP plans only; never add paid services (no Integration Suite, no Event Mesh).
- Never print, log or commit secrets; read config from env (`backend/.env`) or `cds bind` (`.cdsrc-private.json`).
- The development profile must run with no SAP credentials (SQLite, mocked users, LLM_PROVIDER=none).
- Patient names never enter MediLink; patient refs are SHA-256(PATIENT_REF_HASH_SALT:mrn) hashed at the source.
- All seed data is synthetic and must stay labelled as such.
- Run the tests after each change: `npm test` at the repo root.

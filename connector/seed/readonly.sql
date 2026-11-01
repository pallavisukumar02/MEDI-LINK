-- Least-privilege role for the MediLink connector: SELECT on the two views only, nothing else.
-- Use it with CONNECTOR_PG_URL=postgresql://medilink_ro:medilink_ro@localhost:5432/hospital_c
-- (demo password; in a real hospital IT sets its own). The views expose no patient names.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medilink_ro') THEN
    CREATE ROLE medilink_ro LOGIN PASSWORD 'medilink_ro';
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM medilink_ro;
GRANT USAGE ON SCHEMA public TO medilink_ro;
GRANT SELECT ON medilink_stock_v, medilink_schedule_v TO medilink_ro;
ALTER ROLE medilink_ro SET default_transaction_read_only = on;

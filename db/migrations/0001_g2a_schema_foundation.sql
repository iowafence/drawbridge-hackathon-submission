-- AWX-P2-G2A / 0001: protected schemas, migration ledger, immutability helpers.
-- Contract: G1S (sha256 9447194b…cb442) §9.2, §4.1. Runs as drawbridge_migrator with role drawbridge_owner.
-- Non-executing: no provider, no money movement.

-- §9.2: no untrusted CREATE in public; protected schema; reader schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA drawbridge_auth AUTHORIZATION drawbridge_owner;
REVOKE ALL ON SCHEMA drawbridge_auth FROM PUBLIC;
GRANT USAGE ON SCHEMA drawbridge_auth TO authority_svc;     -- needed only to call granted functions
CREATE SCHEMA drawbridge_read AUTHORIZATION drawbridge_owner;
REVOKE ALL ON SCHEMA drawbridge_read FROM PUBLIC;
GRANT USAGE ON SCHEMA drawbridge_read TO drawbridge_reader; -- SELECT on views only (added with the views)

-- PostgreSQL grants EXECUTE to PUBLIC by default; remove that default for everything the owner creates.
ALTER DEFAULT PRIVILEGES FOR ROLE drawbridge_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Migration ledger. Written only by the migration runner.
CREATE TABLE drawbridge_auth.schema_migration (
    file_name   text COLLATE "C" PRIMARY KEY,
    file_sha256 text COLLATE "C" NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
    applied_by  text COLLATE "C" NOT NULL DEFAULT session_user,
    pg_version  text COLLATE "C" NOT NULL DEFAULT current_setting('server_version'),
    applied_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Immutability helpers. Verification-only triggers: they take no locks and read no setting (§9.1).
-- SQLSTATE 23001 (restrict_violation) is used for every immutability and append-only refusal.
CREATE FUNCTION drawbridge_auth.forbid_identity_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
DECLARE c text;
BEGIN
    FOREACH c IN ARRAY TG_ARGV LOOP
        IF to_jsonb(NEW) -> c IS DISTINCT FROM to_jsonb(OLD) -> c THEN
            RAISE EXCEPTION 'immutable column % of %.%', c, TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '23001';
        END IF;
    END LOOP;
    RETURN NEW;
END $f$;

CREATE FUNCTION drawbridge_auth.forbid_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
    RAISE EXCEPTION 'DELETE is not permitted on %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '23001';
END $f$;

CREATE FUNCTION drawbridge_auth.forbid_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
    RAISE EXCEPTION 'TRUNCATE is not permitted on %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '23001';
END $f$;

CREATE FUNCTION drawbridge_auth.forbid_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
    RAISE EXCEPTION 'table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = '23001';
END $f$;

REVOKE ALL ON FUNCTION drawbridge_auth.forbid_identity_update(), drawbridge_auth.forbid_delete(),
    drawbridge_auth.forbid_truncate(), drawbridge_auth.forbid_update() FROM PUBLIC;

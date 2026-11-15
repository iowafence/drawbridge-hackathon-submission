-- G2 cluster bootstrap. Run ONLY by the scratch administrative role (g2_scratch_admin) against database postgres of the
-- isolated scratch cluster. Not a migration: creates roles and a database. Idempotent where practical.
-- Optional psql variable: -v db=<name> (default drawbridge_g2_dev; the guard accepts only drawbridge_g2_(dev|test|scratch)* names).
\set ON_ERROR_STOP on
-- §9.2: one dedicated NOLOGIN owner; no service role is a member of it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='drawbridge_owner') THEN
    CREATE ROLE drawbridge_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  -- migrator: operator-controlled DDL role. Member of the owner (SET only) so DDL runs as the owner. Not a service role.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='drawbridge_migrator') THEN
    CREATE ROLE drawbridge_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authority_svc') THEN
    CREATE ROLE authority_svc LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='drawbridge_reader') THEN
    CREATE ROLE drawbridge_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
GRANT drawbridge_owner TO drawbridge_migrator WITH INHERIT FALSE, SET TRUE;

\if :{?db}
\else
  \set db drawbridge_g2_dev
\endif

SELECT format('CREATE DATABASE %I TEMPLATE template0 ENCODING ''UTF8'' LOCALE_PROVIDER builtin BUILTIN_LOCALE ''C.UTF-8'' OWNER drawbridge_owner', :'db')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec

-- §9.2: database-level REVOKE from PUBLIC, explicit CONNECT for the roles that need it.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO drawbridge_migrator, authority_svc, drawbridge_reader', :'db') \gexec
-- schema creation by the owner via the migrator
SELECT format('GRANT CREATE ON DATABASE %I TO drawbridge_owner', :'db') \gexec

-- AWX-P2-G2A-ADR RC-2: pin client_encoding UTF8 (G1S §7.10.2). Database encoding, client encoding and collation are three
-- different settings: the database is created UTF8 above; this pins the client_encoding DEFAULT for the database and for every
-- login role. A session can still override it with SET client_encoding, so the default is a baseline, not a boundary.
SELECT format('ALTER DATABASE %I SET client_encoding = ''UTF8''', :'db') \gexec
ALTER ROLE drawbridge_migrator SET client_encoding = 'UTF8';
ALTER ROLE authority_svc SET client_encoding = 'UTF8';
ALTER ROLE drawbridge_reader SET client_encoding = 'UTF8';

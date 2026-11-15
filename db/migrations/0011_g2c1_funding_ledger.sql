-- SIM-ENG-003-G2C1 / 0011: funding-only durable ledger (synthetic, non-executing).
--
-- STATUS: SOURCE ONLY. Never applied by the build that wrote it. The first apply needs an owner-approved migration-hash
-- addendum that names this file's path and SHA-256 (SIM-ENG-003-G2C1-A1 section 6.4). It runs as drawbridge_migrator with
-- role drawbridge_owner, in one transaction, on the dedicated G2C1 scratch cluster only.
--
-- Governing text, in precedence order: G1S (sha256 9447194b...b442) > SIM-ENG-003-C1-A1 errata and conditions > C1 > task D.
--   G1S 4.1 journal tables; 4.3 posting identities; 9 roles, protected functions, lock order; 10.1 limits A to D.
--   C1 D-1..D-18; C1-A1 E-1, E-2, E-3, C-2a..C-2c, C-4a, C-4b, C-9, C-10a..C-10c, C-11a..C-11f, section 6.
--
-- Scope (C1 D-1): allocation_event, journal_account, journal_txn, journal_leg, post_funding, post_funding_reduction, three
-- read-only views. NOT created here: funding_authority, exposures, reservations, SETTLEMENT/RETURN/REVERSAL postings, cases,
-- payment_event, approvals, dispatch, provider tables, any G1S 4.4 reversal structure (C-2b), transfer_exposure (C1 D-2).
-- Additive only (C1 D-18): nothing from 0001..0010 is altered.
--
-- Staged journal DDL (C1 D-2, C-2a..C-2c): every G1S 4.1 header and leg column is present EXCEPT the leg mirror columns, which
-- G1S 4.1 constrains only through the 4.4 single CHECK (RO-9) that C-2b defers. The header reversal columns are present and
-- forced to NULL / the empty marker. The header-to-exposure foreign key is absent because transfer_exposure does not exist;
-- header obligation_id / exposure_id carry no foreign key and are forced NULL by journal_txn_g2c1_funding_only. The interim
-- schema is stricter than G1S. The exposure slice adds the keys and replaces that CHECK with one no weaker than the 4.1 kind-shape row.
--
-- Authority (C1-A1 C-9, E-3): authorization_id, idempotency_key and content_digest are LABELS used for identity and comparison.
-- They confer no authority. Permission comes only from the executing role. No funding_authority record stands behind any label;
-- every authorization is synthetic. That must not be carried into the slice that introduces funding_authority.
--
-- Error contract (D-12, C1-A1 E-2): the exception MESSAGE is the stable name; for AUTHORITY_REDUCTION_BLOCKED the DETAIL is the reason.
--   DW404 ALLOCATION_NOT_FOUND
--   DW409 STALE_VERSION | IDEMPOTENCY_CONFLICT | DUPLICATE_AUTHORIZATION
--   DW422 INVALID_AMOUNT | INVALID_REFERENCE | AUTHORITY_REDUCTION_BLOCKED (DETAIL = REDUCTION_EXCEEDS_CASH)
-- DW422 is a new code introduced by this file; it is registered by this definition and by the owner approval of C1-A1.
-- Retriable unique indexes (C1-A1 section 5; the record names them by column set, these are their constraint names):
--   journal_txn_idempotency_key_uk, journal_txn_posting_identity_uk, allocation_event_allocation_version_uk.
-- Any other unique violation is a defect and is never retried.

-- ---------------------------------------------------------------------------------------------------------------------
-- 0. Preconditions. Fail closed before any object is created.
DO $pre$
DECLARE
    v_n integer;
BEGIN
    IF current_user <> 'drawbridge_owner' THEN
        RAISE EXCEPTION '0011 must run with role drawbridge_owner (found %)', current_user USING ERRCODE = '42501';
    END IF;
    IF current_setting('server_version_num')::integer < 180000 THEN
        RAISE EXCEPTION '0011 targets PostgreSQL 18 (found %)', current_setting('server_version') USING ERRCODE = '0A000';
    END IF;
    SELECT count(*) INTO v_n FROM drawbridge_auth.schema_migration m
     WHERE m.file_name IN ('0001_g2a_schema_foundation.sql', '0002_g2a_normalization_v1.sql',
                           '0003_g2a_project_allocation_counterparty.sql', '0004_g2a_rc1_usd_only.sql',
                           '0005_g2b_evidence_lineage_registries.sql', '0006_g2b_obligation_history_guard.sql',
                           '0007_g2b_protected_functions.sql', '0008_g2b_r1_trusted_source_document.sql',
                           '0009_g2b_r2_u2_referential_integrity.sql', '0010_g2b_r2_byte_input_boundary.sql');
    IF v_n <> 10 THEN
        RAISE EXCEPTION '0011 requires migrations 0001 to 0010 to be recorded in the migration ledger (found % of 10)', v_n
            USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM drawbridge_auth.schema_migration m WHERE m.file_name = '0011_g2c1_funding_ledger.sql') THEN
        RAISE EXCEPTION '0011 is already recorded in the migration ledger' USING ERRCODE = '55000';
    END IF;
END $pre$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Result type of the two posting functions (D-6: returns event_id, txn_id, version, replayed).
CREATE TYPE drawbridge_auth.funding_post_result AS (event_id uuid, txn_id uuid, version bigint, replayed boolean);

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. journal_account (G1S 4.1).
CREATE TABLE drawbridge_auth.journal_account (
    account_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     uuid NOT NULL,
    allocation_id  uuid NOT NULL,
    currency       text COLLATE "C" NOT NULL,
    account_name   text COLLATE "C" NOT NULL,
    account_type   text COLLATE "C" NOT NULL,
    normal_balance text COLLATE "C" NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT journal_account_name_chk CHECK (account_name IN ('PROJECT_CAPITAL', 'CASH_ALLOCATED', 'DISBURSED')),
    CONSTRAINT journal_account_usd_only CHECK (currency = 'USD'),
    -- type and normal balance are fixed by the name (G1S names the columns, not their values; logged assumption)
    CONSTRAINT journal_account_shape_chk CHECK (
        (account_name = 'PROJECT_CAPITAL' AND account_type = 'CAPITAL' AND normal_balance = 'C')
        OR (account_name IN ('CASH_ALLOCATED', 'DISBURSED') AND account_type = 'ASSET' AND normal_balance = 'D')),
    CONSTRAINT journal_account_pair_fk FOREIGN KEY (project_id, allocation_id)
        REFERENCES drawbridge_auth.allocation (project_id, allocation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT journal_account_triple_fk FOREIGN KEY (project_id, allocation_id, currency)
        REFERENCES drawbridge_auth.allocation (project_id, allocation_id, currency) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT journal_account_name_uk UNIQUE (project_id, allocation_id, account_name),
    CONSTRAINT journal_account_leg_target_uk UNIQUE (account_id, project_id, allocation_id, currency, account_name)
);

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. journal_txn (header) (G1S 4.1, 4.3, 10.1 limit A).
CREATE TABLE drawbridge_auth.journal_txn (
    txn_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          uuid NOT NULL,
    allocation_id       uuid NOT NULL,
    obligation_id       uuid,
    exposure_id         uuid,
    obligation_ref      text COLLATE "C" NOT NULL,
    exposure_ref        text COLLATE "C" NOT NULL,
    currency            text COLLATE "C" NOT NULL,
    kind                text COLLATE "C" NOT NULL,
    total_amount        numeric(20,2) NOT NULL,
    posting_identity    text COLLATE "C" NOT NULL,
    identity_generation integer NOT NULL,
    reverses_txn_id     uuid,
    reversed_kind       text COLLATE "C",
    reverses_ref        text COLLATE "C" NOT NULL,
    reversed_kind_ref   text COLLATE "C" NOT NULL,
    idempotency_key     text COLLATE "C" NOT NULL,
    authorization_ref   text COLLATE "C",
    evidence_ref        text COLLATE "C",
    created_xid         xid8 NOT NULL DEFAULT pg_current_xact_id(),
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- G1S 4.1 shape rows that hold for every kind
    CONSTRAINT journal_txn_obligation_ref_chk CHECK (obligation_ref = COALESCE(obligation_id::text, '∅')),
    CONSTRAINT journal_txn_exposure_ref_chk CHECK (exposure_ref = COALESCE(exposure_id::text, '∅')),
    CONSTRAINT journal_txn_reverses_ref_chk CHECK (reverses_ref = COALESCE(reverses_txn_id::text, '∅')),
    CONSTRAINT journal_txn_reversed_kind_ref_chk CHECK (reversed_kind_ref = COALESCE(reversed_kind, '∅')),
    CONSTRAINT journal_txn_usd_only CHECK (currency = 'USD'),
    CONSTRAINT journal_txn_kind_chk CHECK (kind IN ('FUNDING', 'FUNDING_REDUCTION', 'SETTLEMENT', 'RETURN', 'REVERSAL')),
    CONSTRAINT journal_txn_amount_chk CHECK (total_amount > 0 AND total_amount <= 99999999999.99),
    -- G1M A5.1 reversal header shape
    CONSTRAINT journal_txn_reversal_shape_chk CHECK (
        (kind = 'REVERSAL' AND reverses_txn_id IS NOT NULL AND reversed_kind IS NOT NULL)
        OR (kind <> 'REVERSAL' AND reverses_txn_id IS NULL AND reversed_kind IS NULL)),
    -- C1 D-2 / C-9: staged to the two funding kinds; identity generation fixed at 1 for these kinds
    CONSTRAINT journal_txn_g2c1_funding_only CHECK (
        kind IN ('FUNDING', 'FUNDING_REDUCTION')
        AND exposure_id IS NULL AND obligation_id IS NULL
        AND authorization_ref IS NOT NULL AND evidence_ref IS NULL
        AND identity_generation = 1
        AND posting_identity = CASE kind WHEN 'FUNDING' THEN 'FUNDING:' ELSE 'REDUCTION:' END || authorization_ref),
    CONSTRAINT journal_txn_authorization_ref_shape CHECK (authorization_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT journal_txn_idempotency_key_shape CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT journal_txn_pair_fk FOREIGN KEY (project_id, allocation_id)
        REFERENCES drawbridge_auth.allocation (project_id, allocation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT journal_txn_triple_fk FOREIGN KEY (project_id, allocation_id, currency)
        REFERENCES drawbridge_auth.allocation (project_id, allocation_id, currency) ON UPDATE RESTRICT ON DELETE RESTRICT,
    -- Global identities. These three unique constraints plus allocation_event_allocation_version_uk are the only arbiters
    -- that the bounded retry may treat as lost races (C1-A1 section 5).
    CONSTRAINT journal_txn_idempotency_key_uk UNIQUE (idempotency_key),
    CONSTRAINT journal_txn_posting_identity_uk UNIQUE (posting_identity, identity_generation),
    -- composite targets of the leg and event keys
    CONSTRAINT journal_txn_leg_target_uk UNIQUE (txn_id, project_id, allocation_id, obligation_ref, exposure_ref, currency, kind,
                                                 posting_identity, identity_generation, reverses_ref),
    CONSTRAINT journal_txn_event_target_uk UNIQUE (txn_id, project_id, allocation_id, currency, kind, total_amount,
                                                   idempotency_key, authorization_ref)
);
CREATE INDEX journal_txn_allocation_idx ON drawbridge_auth.journal_txn (allocation_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. journal_leg (G1S 4.1). The leg repeats the header identity; the posting function builds every column from its header
-- variable and no caller supplies them.
CREATE TABLE drawbridge_auth.journal_leg (
    txn_id              uuid NOT NULL,
    leg_no              smallint NOT NULL,
    account_id          uuid NOT NULL,
    account_name        text COLLATE "C" NOT NULL,
    project_id          uuid NOT NULL,
    allocation_id       uuid NOT NULL,
    obligation_ref      text COLLATE "C" NOT NULL,
    exposure_ref        text COLLATE "C" NOT NULL,
    currency            text COLLATE "C" NOT NULL,
    kind                text COLLATE "C" NOT NULL,
    posting_identity    text COLLATE "C" NOT NULL,
    identity_generation integer NOT NULL,
    reverses_ref        text COLLATE "C" NOT NULL,
    direction           text COLLATE "C" NOT NULL,
    amount              numeric(20,2) NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT journal_leg_pkey PRIMARY KEY (txn_id, leg_no),
    CONSTRAINT journal_leg_leg_no_chk CHECK (leg_no >= 1),
    CONSTRAINT journal_leg_direction_chk CHECK (direction IN ('D', 'C')),
    CONSTRAINT journal_leg_amount_chk CHECK (amount > 0 AND amount <= 99999999999.99),
    CONSTRAINT journal_leg_usd_only CHECK (currency = 'USD'),
    CONSTRAINT journal_leg_account_name_chk CHECK (account_name IN ('PROJECT_CAPITAL', 'CASH_ALLOCATED', 'DISBURSED')),
    -- N6: a DISBURSED leg always has an exposure
    CONSTRAINT journal_leg_disbursed_has_exposure CHECK (account_name <> 'DISBURSED' OR exposure_ref <> '∅'),
    -- C1 D-2: staged kind shape for the two funding kinds
    CONSTRAINT journal_leg_g2c1_funding_only CHECK (
        kind IN ('FUNDING', 'FUNDING_REDUCTION') AND obligation_ref = '∅' AND exposure_ref = '∅'
        AND reverses_ref = '∅' AND identity_generation = 1),
    CONSTRAINT journal_leg_header_fk FOREIGN KEY (txn_id, project_id, allocation_id, obligation_ref, exposure_ref, currency, kind,
                                                  posting_identity, identity_generation, reverses_ref)
        REFERENCES drawbridge_auth.journal_txn (txn_id, project_id, allocation_id, obligation_ref, exposure_ref, currency, kind,
                                                posting_identity, identity_generation, reverses_ref)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT journal_leg_pair_fk FOREIGN KEY (project_id, allocation_id)
        REFERENCES drawbridge_auth.allocation (project_id, allocation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT journal_leg_account_fk FOREIGN KEY (account_id, project_id, allocation_id, currency, account_name)
        REFERENCES drawbridge_auth.journal_account (account_id, project_id, allocation_id, currency, account_name)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX journal_leg_account_idx ON drawbridge_auth.journal_leg (account_id);
CREATE INDEX journal_leg_allocation_account_idx ON drawbridge_auth.journal_leg (allocation_id, account_name);

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. allocation_event (C1 D-3): the versioned, append-only stream. One event has exactly one journal transaction.
CREATE TABLE drawbridge_auth.allocation_event (
    event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       uuid NOT NULL,
    allocation_id    uuid NOT NULL,
    currency         text COLLATE "C" NOT NULL,
    version          bigint NOT NULL,
    event_kind       text COLLATE "C" NOT NULL,
    amount           numeric(13,2) NOT NULL,
    authorization_id text COLLATE "C" NOT NULL,
    idempotency_key  text COLLATE "C" NOT NULL,
    content_digest   bytea NOT NULL,
    txn_id           uuid NOT NULL,
    created_xid      xid8 NOT NULL DEFAULT pg_current_xact_id(),
    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT allocation_event_version_chk CHECK (version >= 1),
    CONSTRAINT allocation_event_kind_chk CHECK (event_kind IN ('FUNDING', 'FUNDING_REDUCTION')),
    CONSTRAINT allocation_event_usd_only CHECK (currency = 'USD'),
    CONSTRAINT allocation_event_amount_chk CHECK (amount > 0 AND amount <= 99999999999.99),
    CONSTRAINT allocation_event_digest_len CHECK (octet_length(content_digest) = 32),
    CONSTRAINT allocation_event_authorization_shape CHECK (authorization_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT allocation_event_idempotency_shape CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
    CONSTRAINT allocation_event_pair_fk FOREIGN KEY (project_id, allocation_id)
        REFERENCES drawbridge_auth.allocation (project_id, allocation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT allocation_event_triple_fk FOREIGN KEY (project_id, allocation_id, currency)
        REFERENCES drawbridge_auth.allocation (project_id, allocation_id, currency) ON UPDATE RESTRICT ON DELETE RESTRICT,
    -- the event and its header must agree on allocation, kind, amount and labels
    CONSTRAINT allocation_event_txn_fk FOREIGN KEY (txn_id, project_id, allocation_id, currency, event_kind, amount,
                                                    idempotency_key, authorization_id)
        REFERENCES drawbridge_auth.journal_txn (txn_id, project_id, allocation_id, currency, kind, total_amount,
                                                idempotency_key, authorization_ref)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT allocation_event_allocation_version_uk UNIQUE (allocation_id, version),
    CONSTRAINT allocation_event_txn_uk UNIQUE (txn_id)
);

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Verification-only trigger functions. They read, they take no lock, they write nothing (G1S 9.5, C1-A1 E-1, C-4a).
-- 6.1 legs may be added only in the transaction that created their header ("no legs added after posting", G1S 4.1).
CREATE FUNCTION drawbridge_auth.trg_journal_leg_same_xact() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM drawbridge_auth.journal_txn t
                    WHERE t.txn_id = NEW.txn_id AND t.created_xid = pg_current_xact_id()) THEN
        RAISE EXCEPTION 'journal legs may be added only in the transaction that created the header' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
END $f$;

-- 6.2 an event may be added only in the transaction that created its header.
CREATE FUNCTION drawbridge_auth.trg_allocation_event_fresh_header() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM drawbridge_auth.journal_txn t
                    WHERE t.txn_id = NEW.txn_id AND t.created_xid = pg_current_xact_id()) THEN
        RAISE EXCEPTION 'an allocation event may be added only in the transaction that created its journal header'
            USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
END $f$;

-- 6.3 D-4 contiguous versions: first version 1, each later version the previous plus 1. A plain read, no lock, no write.
-- The unique constraint allocation_event_allocation_version_uk is the arbiter under concurrency (E-1, C-4a, C-4b).
CREATE FUNCTION drawbridge_auth.trg_allocation_event_contiguous() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_last bigint;
BEGIN
    SELECT max(e.version) INTO v_last FROM drawbridge_auth.allocation_event e WHERE e.allocation_id = NEW.allocation_id;
    IF NEW.version IS DISTINCT FROM COALESCE(v_last, 0) + 1 THEN
        RAISE EXCEPTION 'allocation event versions must be contiguous from 1 (allocation %, version %, last %)',
            NEW.allocation_id, NEW.version, COALESCE(v_last, 0) USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $f$;

-- 6.4 deferred: a header is complete, balanced and has the exact leg pattern of its kind (G1S 4.1). Fails closed (C-2a).
CREATE FUNCTION drawbridge_auth.trg_journal_txn_verify() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_legs    integer;
    v_debit   numeric;
    v_credit  numeric;
    v_debit_account  text;
    v_credit_account text;
    v_matching integer;
BEGIN
    IF NEW.kind = 'FUNDING' THEN
        v_debit_account := 'CASH_ALLOCATED';
        v_credit_account := 'PROJECT_CAPITAL';
    ELSIF NEW.kind = 'FUNDING_REDUCTION' THEN
        v_debit_account := 'PROJECT_CAPITAL';
        v_credit_account := 'CASH_ALLOCATED';
    ELSE
        RAISE EXCEPTION 'unsupported journal kind % in this schema stage', NEW.kind USING ERRCODE = '23514';
    END IF;
    SELECT count(*),
           COALESCE(sum(l.amount) FILTER (WHERE l.direction = 'D'), 0),
           COALESCE(sum(l.amount) FILTER (WHERE l.direction = 'C'), 0)
      INTO v_legs, v_debit, v_credit
      FROM drawbridge_auth.journal_leg l WHERE l.txn_id = NEW.txn_id;
    IF v_legs < 2 THEN
        RAISE EXCEPTION 'JOURNAL_INCOMPLETE: transaction % has % legs', NEW.txn_id, v_legs USING ERRCODE = '23514';
    END IF;
    IF v_debit <> v_credit OR v_debit <> NEW.total_amount THEN
        RAISE EXCEPTION 'JOURNAL_IMBALANCE: transaction % debits % credits % total %', NEW.txn_id, v_debit, v_credit, NEW.total_amount
            USING ERRCODE = '23514';
    END IF;
    SELECT count(*) INTO v_matching FROM drawbridge_auth.journal_leg l
     WHERE l.txn_id = NEW.txn_id AND l.amount = NEW.total_amount
       AND ((l.direction = 'D' AND l.account_name = v_debit_account) OR (l.direction = 'C' AND l.account_name = v_credit_account));
    IF v_legs <> 2 OR v_matching <> 2 THEN
        RAISE EXCEPTION 'JOURNAL_PATTERN: transaction % does not have the exact % leg pattern', NEW.txn_id, NEW.kind USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $f$;

-- 6.5 deferred, after each posting: G1S 10.1 limit B (aggregate balance of any account or allocation, absolute value).
-- Limit D (the minor-unit integer) is exactly MAX_BALANCE_ABS x 100, so this bound also bounds the minor-unit integer.
-- Interpretation (logged): the allocation aggregate is the net of its debit-normal accounts (CASH_ALLOCATED + DISBURSED),
-- which in a balanced ledger equals its PROJECT_CAPITAL balance.
CREATE FUNCTION drawbridge_auth.trg_journal_leg_aggregate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_account numeric;
    v_alloc   numeric;
BEGIN
    SELECT COALESCE(sum(CASE l.direction WHEN 'D' THEN l.amount ELSE -l.amount END), 0) INTO v_account
      FROM drawbridge_auth.journal_leg l WHERE l.account_id = NEW.account_id;
    IF abs(v_account) > 90071992547409.91 THEN
        RAISE EXCEPTION 'AGGREGATE_BALANCE_EXCEEDED: account % balance % is beyond MAX_BALANCE_ABS', NEW.account_id, v_account
            USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(CASE l.direction WHEN 'D' THEN l.amount ELSE -l.amount END), 0) INTO v_alloc
      FROM drawbridge_auth.journal_leg l
     WHERE l.allocation_id = NEW.allocation_id AND l.account_name IN ('CASH_ALLOCATED', 'DISBURSED');
    IF abs(v_alloc) > 90071992547409.91 THEN
        RAISE EXCEPTION 'AGGREGATE_BALANCE_EXCEEDED: allocation % balance % is beyond MAX_BALANCE_ABS', NEW.allocation_id, v_alloc
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $f$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Triggers: append-only (23001, as every earlier immutability refusal), completeness, contiguity, aggregate bound.
DO $trg$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['journal_account', 'journal_txn', 'journal_leg', 'allocation_event'] LOOP
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON drawbridge_auth.%I FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_update()', t || '_no_update', t);
        EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON drawbridge_auth.%I FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_delete()', t || '_no_delete', t);
        EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON drawbridge_auth.%I FOR EACH STATEMENT EXECUTE FUNCTION drawbridge_auth.forbid_truncate()', t || '_no_truncate', t);
    END LOOP;
END $trg$;

CREATE TRIGGER journal_leg_same_xact BEFORE INSERT ON drawbridge_auth.journal_leg
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.trg_journal_leg_same_xact();
CREATE TRIGGER allocation_event_fresh_header BEFORE INSERT ON drawbridge_auth.allocation_event
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.trg_allocation_event_fresh_header();
CREATE TRIGGER allocation_event_contiguous BEFORE INSERT ON drawbridge_auth.allocation_event
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.trg_allocation_event_contiguous();
CREATE CONSTRAINT TRIGGER journal_txn_verify AFTER INSERT ON drawbridge_auth.journal_txn DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.trg_journal_txn_verify();
CREATE CONSTRAINT TRIGGER journal_leg_verify_aggregate AFTER INSERT ON drawbridge_auth.journal_leg DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.trg_journal_leg_aggregate();

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Internal helpers. No EXECUTE to any role: they are called only from inside the two posting functions (owner context).
-- 8.1 amount validation, done before any numeric-range error can occur (G1S 10.1 limit A, MONEY-M02; C1-A1 section 6 item 2).
-- Refuses NULL, NaN, +/-Infinity, non-positive, above MAX_TXN_AMOUNT and more than two decimal places. Returns exact cents.
CREATE FUNCTION drawbridge_auth.g2c1_validate_amount(p_amount numeric) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
    IF p_amount IS NULL
       OR p_amount IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
       OR p_amount <= 0
       OR p_amount > 99999999999.99
       OR p_amount <> round(p_amount, 2) THEN
        RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'DW422';
    END IF;
    RETURN (p_amount * 100)::bigint;
END $f$;

-- 8.2 reference validation (C1 D-8 pattern keeps the digest delimiter out of both labels).
CREATE FUNCTION drawbridge_auth.g2c1_validate_refs(p_authorization_id text, p_idempotency_key text, p_expected_version bigint) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
    IF p_authorization_id IS NULL OR p_authorization_id !~ '^[A-Za-z0-9._:-]{1,128}$'
       OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$'
       OR p_expected_version IS NULL OR p_expected_version < 1 THEN
        RAISE EXCEPTION 'INVALID_REFERENCE' USING ERRCODE = 'DW422';
    END IF;
END $f$;

-- 8.3 C1 D-8 content digest of the claim: SHA-256 of the UTF-8 text
--   G2C1-EVT-V1|allocation_id|event_kind|amount_cents|currency|authorization_id|idempotency_key
CREATE FUNCTION drawbridge_auth.g2c1_event_digest(p_allocation_id uuid, p_event_kind text, p_amount_cents bigint, p_currency text,
                                                  p_authorization_id text, p_idempotency_key text) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
    SELECT sha256(convert_to('G2C1-EVT-V1|' || p_allocation_id::text || '|' || p_event_kind || '|' || p_amount_cents::text || '|'
                             || p_currency || '|' || p_authorization_id || '|' || p_idempotency_key, 'UTF8'))
$f$;

-- 8.4 D-7 step 7 and 8: create the three accounts if absent, then insert the header, the two legs, then the event.
-- Plain INSERT, no ON CONFLICT, no catch-and-continue: any failure aborts the whole transaction. The caller already holds
-- the exclusive allocation lock (L1). The kind selects the leg directions and the posting-identity prefix; it is data, not permission.
CREATE FUNCTION drawbridge_auth.g2c1_write_posting(p_project_id uuid, p_allocation_id uuid, p_event_kind text, p_version bigint,
                                                   p_amount numeric, p_authorization_id text, p_idempotency_key text, p_digest bytea)
RETURNS drawbridge_auth.funding_post_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_txn     uuid := gen_random_uuid();
    v_event   uuid := gen_random_uuid();
    v_identity text;
    v_debit   text;
    v_credit  text;
    v_debit_id  uuid;
    v_credit_id uuid;
BEGIN
    IF p_event_kind = 'FUNDING' THEN
        v_identity := 'FUNDING:' || p_authorization_id;
        v_debit := 'CASH_ALLOCATED';
        v_credit := 'PROJECT_CAPITAL';
    ELSIF p_event_kind = 'FUNDING_REDUCTION' THEN
        v_identity := 'REDUCTION:' || p_authorization_id;
        v_debit := 'PROJECT_CAPITAL';
        v_credit := 'CASH_ALLOCATED';
    ELSE
        RAISE EXCEPTION 'UNSUPPORTED_KIND' USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM drawbridge_auth.journal_account a
                    WHERE a.project_id = p_project_id AND a.allocation_id = p_allocation_id) THEN
        INSERT INTO drawbridge_auth.journal_account (project_id, allocation_id, currency, account_name, account_type, normal_balance)
        VALUES (p_project_id, p_allocation_id, 'USD', 'CASH_ALLOCATED', 'ASSET', 'D'),
               (p_project_id, p_allocation_id, 'USD', 'DISBURSED', 'ASSET', 'D'),
               (p_project_id, p_allocation_id, 'USD', 'PROJECT_CAPITAL', 'CAPITAL', 'C');
    END IF;
    SELECT a.account_id INTO v_debit_id FROM drawbridge_auth.journal_account a
     WHERE a.project_id = p_project_id AND a.allocation_id = p_allocation_id AND a.account_name = v_debit;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'LEDGER_ACCOUNT_MISSING' USING ERRCODE = 'P0001';
    END IF;
    SELECT a.account_id INTO v_credit_id FROM drawbridge_auth.journal_account a
     WHERE a.project_id = p_project_id AND a.allocation_id = p_allocation_id AND a.account_name = v_credit;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'LEDGER_ACCOUNT_MISSING' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO drawbridge_auth.journal_txn (txn_id, project_id, allocation_id, obligation_id, exposure_id, obligation_ref, exposure_ref,
        currency, kind, total_amount, posting_identity, identity_generation, reverses_txn_id, reversed_kind, reverses_ref,
        reversed_kind_ref, idempotency_key, authorization_ref, evidence_ref)
    VALUES (v_txn, p_project_id, p_allocation_id, NULL, NULL, '∅', '∅', 'USD', p_event_kind, p_amount, v_identity, 1, NULL, NULL,
        '∅', '∅', p_idempotency_key, p_authorization_id, NULL);

    INSERT INTO drawbridge_auth.journal_leg (txn_id, leg_no, account_id, account_name, project_id, allocation_id, obligation_ref,
        exposure_ref, currency, kind, posting_identity, identity_generation, reverses_ref, direction, amount)
    VALUES (v_txn, 1, v_debit_id, v_debit, p_project_id, p_allocation_id, '∅', '∅', 'USD', p_event_kind, v_identity, 1, '∅', 'D', p_amount),
           (v_txn, 2, v_credit_id, v_credit, p_project_id, p_allocation_id, '∅', '∅', 'USD', p_event_kind, v_identity, 1, '∅', 'C', p_amount);

    INSERT INTO drawbridge_auth.allocation_event (event_id, project_id, allocation_id, currency, version, event_kind, amount,
        authorization_id, idempotency_key, content_digest, txn_id)
    VALUES (v_event, p_project_id, p_allocation_id, 'USD', p_version, p_event_kind, p_amount,
        p_authorization_id, p_idempotency_key, p_digest, v_txn);

    RETURN ROW(v_event, v_txn, p_version, false)::drawbridge_auth.funding_post_result;
END $f$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. The two protected posting functions (C1 D-6, D-7, D-9, D-10, D-12; E-2; E-3).
-- Order of work: (1) lock the allocation row FOR UPDATE (L1 exclusive); (2) validate; (3) idempotency lookup;
-- (4) posting-identity lookup; (5) expected version equals last + 1; (6) [reduction only] amount must not exceed CASH_ALLOCATED;
-- (7) accounts; (8) header, legs, event. Steps 3 and 4 precede step 5 so an identical replay succeeds after the stream moved.
-- The function never retries internally: the caller's bounded wrapper re-executes the whole function (at most 3 attempts).
-- VOLATILE is required so each statement sees committed state after a lock wait at READ COMMITTED (C-11c).
CREATE FUNCTION drawbridge_auth.post_funding(p_allocation_id uuid, p_expected_version bigint, p_amount numeric,
                                             p_authorization_id text, p_idempotency_key text)
RETURNS drawbridge_auth.funding_post_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_project uuid;
    v_cents   bigint;
    v_digest  bytea;
    v_ev      drawbridge_auth.allocation_event%ROWTYPE;
    v_last    bigint;
BEGIN
    IF session_user <> 'authority_svc' THEN
        RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    -- (1) L1 exclusive
    SELECT a.project_id INTO v_project FROM drawbridge_auth.allocation a WHERE a.allocation_id = p_allocation_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ALLOCATION_NOT_FOUND' USING ERRCODE = 'DW404';
    END IF;
    -- (2) validate inputs, no further row lock
    v_cents := drawbridge_auth.g2c1_validate_amount(p_amount);
    PERFORM drawbridge_auth.g2c1_validate_refs(p_authorization_id, p_idempotency_key, p_expected_version);
    v_digest := drawbridge_auth.g2c1_event_digest(p_allocation_id, 'FUNDING', v_cents, 'USD', p_authorization_id, p_idempotency_key);
    -- (3) idempotency key (global, case-sensitive)
    SELECT e.* INTO v_ev FROM drawbridge_auth.allocation_event e
      JOIN drawbridge_auth.journal_txn t ON t.txn_id = e.txn_id WHERE t.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_ev.content_digest = v_digest THEN
            RETURN ROW(v_ev.event_id, v_ev.txn_id, v_ev.version, true)::drawbridge_auth.funding_post_result;
        END IF;
        RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'DW409';
    END IF;
    -- (4) posting identity (global)
    IF EXISTS (SELECT 1 FROM drawbridge_auth.journal_txn t
                WHERE t.posting_identity = 'FUNDING:' || p_authorization_id AND t.identity_generation = 1) THEN
        RAISE EXCEPTION 'DUPLICATE_AUTHORIZATION' USING ERRCODE = 'DW409';
    END IF;
    -- (5) expected version
    SELECT COALESCE(max(e.version), 0) INTO v_last FROM drawbridge_auth.allocation_event e WHERE e.allocation_id = p_allocation_id;
    IF p_expected_version <> v_last + 1 THEN
        RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'DW409';
    END IF;
    -- (7) and (8)
    RETURN drawbridge_auth.g2c1_write_posting(v_project, p_allocation_id, 'FUNDING', p_expected_version, p_amount,
                                              p_authorization_id, p_idempotency_key, v_digest);
END $f$;

CREATE FUNCTION drawbridge_auth.post_funding_reduction(p_allocation_id uuid, p_expected_version bigint, p_amount numeric,
                                                       p_authorization_id text, p_idempotency_key text)
RETURNS drawbridge_auth.funding_post_result
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_project uuid;
    v_cents   bigint;
    v_digest  bytea;
    v_ev      drawbridge_auth.allocation_event%ROWTYPE;
    v_last    bigint;
    v_cash    numeric;
BEGIN
    IF session_user <> 'authority_svc' THEN
        RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    -- (1) L1 exclusive
    SELECT a.project_id INTO v_project FROM drawbridge_auth.allocation a WHERE a.allocation_id = p_allocation_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ALLOCATION_NOT_FOUND' USING ERRCODE = 'DW404';
    END IF;
    -- (2) validate
    v_cents := drawbridge_auth.g2c1_validate_amount(p_amount);
    PERFORM drawbridge_auth.g2c1_validate_refs(p_authorization_id, p_idempotency_key, p_expected_version);
    v_digest := drawbridge_auth.g2c1_event_digest(p_allocation_id, 'FUNDING_REDUCTION', v_cents, 'USD', p_authorization_id, p_idempotency_key);
    -- (3) idempotency key
    SELECT e.* INTO v_ev FROM drawbridge_auth.allocation_event e
      JOIN drawbridge_auth.journal_txn t ON t.txn_id = e.txn_id WHERE t.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_ev.content_digest = v_digest THEN
            RETURN ROW(v_ev.event_id, v_ev.txn_id, v_ev.version, true)::drawbridge_auth.funding_post_result;
        END IF;
        RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'DW409';
    END IF;
    -- (4) posting identity
    IF EXISTS (SELECT 1 FROM drawbridge_auth.journal_txn t
                WHERE t.posting_identity = 'REDUCTION:' || p_authorization_id AND t.identity_generation = 1) THEN
        RAISE EXCEPTION 'DUPLICATE_AUTHORIZATION' USING ERRCODE = 'DW409';
    END IF;
    -- (5) expected version
    SELECT COALESCE(max(e.version), 0) INTO v_last FROM drawbridge_auth.allocation_event e WHERE e.allocation_id = p_allocation_id;
    IF p_expected_version <> v_last + 1 THEN
        RAISE EXCEPTION 'STALE_VERSION' USING ERRCODE = 'DW409';
    END IF;
    -- (6) D-10, valid ONLY inside this synthetic no-commitment slice (C1-A1 E-2): no reservations, claims, exposures, holds, cases
    -- or DISBURSED legs exist, so the unwindable-commitment predicate of G1S Case G / T-27 equals "amount does not exceed CASH".
    -- A reduction to exactly zero is allowed. Later slices must replace this rule, not carry it.
    SELECT COALESCE(sum(CASE l.direction WHEN 'D' THEN l.amount ELSE -l.amount END), 0) INTO v_cash
      FROM drawbridge_auth.journal_leg l WHERE l.allocation_id = p_allocation_id AND l.account_name = 'CASH_ALLOCATED';
    IF p_amount > v_cash THEN
        RAISE EXCEPTION 'AUTHORITY_REDUCTION_BLOCKED' USING ERRCODE = 'DW422', DETAIL = 'REDUCTION_EXCEEDS_CASH';
    END IF;
    -- (7) and (8)
    RETURN drawbridge_auth.g2c1_write_posting(v_project, p_allocation_id, 'FUNDING_REDUCTION', p_expected_version, p_amount,
                                              p_authorization_id, p_idempotency_key, v_digest);
END $f$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. Read-only views (C1 D-13). drawbridge_reader sees these and nothing else.
CREATE VIEW drawbridge_read.ledger_event_stream AS
SELECT e.allocation_id, e.version, e.event_id, e.project_id, e.event_kind,
       (e.amount * 100)::bigint AS amount_cents, e.currency, e.authorization_id, e.idempotency_key, e.txn_id,
       encode(e.content_digest, 'hex') AS content_digest, t.posting_identity, t.identity_generation,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object('leg_no', l.leg_no, 'account_name', l.account_name,
                                                      'direction', l.direction, 'amount_cents', (l.amount * 100)::bigint)
                                  ORDER BY l.leg_no), '[]'::jsonb)
          FROM drawbridge_auth.journal_leg l WHERE l.txn_id = e.txn_id) AS legs
  FROM drawbridge_auth.allocation_event e
  JOIN drawbridge_auth.journal_txn t ON t.txn_id = e.txn_id;

CREATE VIEW drawbridge_read.ledger_account_balance AS
SELECT a.project_id, a.allocation_id, a.account_name, a.normal_balance,
       (COALESCE(sum(l.amount) FILTER (WHERE l.direction = 'D'), 0) * 100)::bigint AS debit_cents,
       (COALESCE(sum(l.amount) FILTER (WHERE l.direction = 'C'), 0) * 100)::bigint AS credit_cents,
       (CASE a.normal_balance
             WHEN 'D' THEN COALESCE(sum(l.amount) FILTER (WHERE l.direction = 'D'), 0) - COALESCE(sum(l.amount) FILTER (WHERE l.direction = 'C'), 0)
             ELSE COALESCE(sum(l.amount) FILTER (WHERE l.direction = 'C'), 0) - COALESCE(sum(l.amount) FILTER (WHERE l.direction = 'D'), 0)
        END * 100)::bigint AS balance_cents,
       count(l.leg_no) AS leg_count
  FROM drawbridge_auth.journal_account a
  LEFT JOIN drawbridge_auth.journal_leg l ON l.account_id = a.account_id
 GROUP BY a.account_id;

-- One row per header or per event, whichever exists (a full join, so a header with no event and an event with no header are both visible).
CREATE VIEW drawbridge_read.ledger_reconciliation AS
SELECT COALESCE(t.txn_id, e.txn_id) AS txn_id,
       t.allocation_id AS txn_allocation_id, t.kind AS txn_kind, (t.total_amount * 100)::bigint AS txn_amount_cents,
       t.posting_identity, t.idempotency_key AS txn_idempotency_key,
       (SELECT count(*) FROM drawbridge_auth.journal_leg l WHERE l.txn_id = COALESCE(t.txn_id, e.txn_id)) AS leg_count,
       (SELECT (COALESCE(sum(l.amount) FILTER (WHERE l.direction = 'D'), 0) * 100)::bigint
          FROM drawbridge_auth.journal_leg l WHERE l.txn_id = COALESCE(t.txn_id, e.txn_id)) AS debit_cents,
       (SELECT (COALESCE(sum(l.amount) FILTER (WHERE l.direction = 'C'), 0) * 100)::bigint
          FROM drawbridge_auth.journal_leg l WHERE l.txn_id = COALESCE(t.txn_id, e.txn_id)) AS credit_cents,
       (SELECT count(*) FROM drawbridge_auth.journal_leg l
         WHERE l.txn_id = t.txn_id AND l.amount = t.total_amount
           AND ((t.kind = 'FUNDING' AND ((l.direction = 'D' AND l.account_name = 'CASH_ALLOCATED') OR (l.direction = 'C' AND l.account_name = 'PROJECT_CAPITAL')))
             OR (t.kind = 'FUNDING_REDUCTION' AND ((l.direction = 'D' AND l.account_name = 'PROJECT_CAPITAL') OR (l.direction = 'C' AND l.account_name = 'CASH_ALLOCATED'))))
       ) AS pattern_leg_count,
       e.event_id, e.allocation_id AS event_allocation_id, e.version AS event_version, e.event_kind,
       (e.amount * 100)::bigint AS event_amount_cents
  FROM drawbridge_auth.journal_txn t
  FULL OUTER JOIN drawbridge_auth.allocation_event e ON e.txn_id = t.txn_id;

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. Privileges (G1S 9.2, C1 D-16). Tables and internals: owner only. Posting functions: authority_svc only.
-- Views: drawbridge_reader SELECT. No role holds DML on any ledger table.
REVOKE ALL ON drawbridge_auth.journal_account, drawbridge_auth.journal_txn, drawbridge_auth.journal_leg,
              drawbridge_auth.allocation_event FROM PUBLIC;
REVOKE ALL ON drawbridge_auth.journal_account, drawbridge_auth.journal_txn, drawbridge_auth.journal_leg,
              drawbridge_auth.allocation_event FROM authority_svc, drawbridge_reader;
REVOKE ALL ON drawbridge_read.ledger_event_stream, drawbridge_read.ledger_account_balance,
              drawbridge_read.ledger_reconciliation FROM PUBLIC;
GRANT SELECT ON drawbridge_read.ledger_event_stream, drawbridge_read.ledger_account_balance,
                drawbridge_read.ledger_reconciliation TO drawbridge_reader;

REVOKE ALL ON FUNCTION
    drawbridge_auth.trg_journal_leg_same_xact(), drawbridge_auth.trg_allocation_event_fresh_header(),
    drawbridge_auth.trg_allocation_event_contiguous(), drawbridge_auth.trg_journal_txn_verify(),
    drawbridge_auth.trg_journal_leg_aggregate(),
    drawbridge_auth.g2c1_validate_amount(numeric), drawbridge_auth.g2c1_validate_refs(text, text, bigint),
    drawbridge_auth.g2c1_event_digest(uuid, text, bigint, text, text, text),
    drawbridge_auth.g2c1_write_posting(uuid, uuid, text, bigint, numeric, text, text, bytea),
    drawbridge_auth.post_funding(uuid, bigint, numeric, text, text),
    drawbridge_auth.post_funding_reduction(uuid, bigint, numeric, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    drawbridge_auth.post_funding(uuid, bigint, numeric, text, text),
    drawbridge_auth.post_funding_reduction(uuid, bigint, numeric, text, text)
  TO authority_svc;

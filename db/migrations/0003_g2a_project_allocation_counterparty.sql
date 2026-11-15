-- AWX-P2-G2A / 0003: canonical ownership foundation (§4.1, §12): project, allocation, counterparty.
-- Columns beyond those the contract names are minimal and logged in docs/phase2/g2/G2A_STAGE_REPORT.md (assumptions).

CREATE TABLE drawbridge_auth.project (
    project_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_label text COLLATE "C" NOT NULL CHECK (char_length(project_label) BETWEEN 1 AND 128),
    is_synthetic  boolean NOT NULL DEFAULT TRUE,
    created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- allocation is the only source of which project owns an allocation. Identity and basis are immutable.
CREATE TABLE drawbridge_auth.allocation (
    allocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid NOT NULL REFERENCES drawbridge_auth.project (project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    currency      text COLLATE "C" NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    basis         text COLLATE "C" NOT NULL CHECK (basis = 'PRE_DEBIT'),
    created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT allocation_project_alloc_uk UNIQUE (project_id, allocation_id),
    CONSTRAINT allocation_project_alloc_ccy_uk UNIQUE (project_id, allocation_id, currency)
);

CREATE TABLE drawbridge_auth.counterparty (
    project_id    uuid NOT NULL REFERENCES drawbridge_auth.project (project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    counterparty_id uuid NOT NULL DEFAULT gen_random_uuid(),
    beneficiary_fingerprint text COLLATE "C" CHECK (beneficiary_fingerprint IS NULL OR char_length(beneficiary_fingerprint) BETWEEN 1 AND 256),
    created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, counterparty_id)
);
-- U6: one beneficiary, one counterparty. A fingerprint is not proof of bank ownership.
CREATE UNIQUE INDEX counterparty_u6_beneficiary_fingerprint
    ON drawbridge_auth.counterparty (project_id, beneficiary_fingerprint) WHERE beneficiary_fingerprint IS NOT NULL;

-- Immutability and no-delete (REVOKE-by-ownership plus trigger).
CREATE TRIGGER project_immutable BEFORE UPDATE ON drawbridge_auth.project
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_identity_update('project_id', 'created_at');
CREATE TRIGGER allocation_immutable BEFORE UPDATE ON drawbridge_auth.allocation
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_identity_update('allocation_id', 'project_id', 'currency', 'basis', 'created_at');
CREATE TRIGGER counterparty_immutable BEFORE UPDATE ON drawbridge_auth.counterparty
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_identity_update('project_id', 'counterparty_id', 'beneficiary_fingerprint', 'created_at');

CREATE TRIGGER project_no_delete BEFORE DELETE ON drawbridge_auth.project FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_delete();
CREATE TRIGGER allocation_no_delete BEFORE DELETE ON drawbridge_auth.allocation FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_delete();
CREATE TRIGGER counterparty_no_delete BEFORE DELETE ON drawbridge_auth.counterparty FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_delete();
CREATE TRIGGER project_no_truncate BEFORE TRUNCATE ON drawbridge_auth.project FOR EACH STATEMENT EXECUTE FUNCTION drawbridge_auth.forbid_truncate();
CREATE TRIGGER allocation_no_truncate BEFORE TRUNCATE ON drawbridge_auth.allocation FOR EACH STATEMENT EXECUTE FUNCTION drawbridge_auth.forbid_truncate();
CREATE TRIGGER counterparty_no_truncate BEFORE TRUNCATE ON drawbridge_auth.counterparty FOR EACH STATEMENT EXECUTE FUNCTION drawbridge_auth.forbid_truncate();

-- No service role holds any DML or SELECT on authority tables (§9.2); tables are owner-only.
REVOKE ALL ON drawbridge_auth.project, drawbridge_auth.allocation, drawbridge_auth.counterparty FROM PUBLIC;

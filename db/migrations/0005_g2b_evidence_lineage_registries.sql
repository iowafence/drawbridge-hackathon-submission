-- AWX-P2-G2B / 0005: eligibility evidence, payable lineage, U1 reference registry, U2 global document registry.
-- Contract: G1S §7.9.2 to §7.9.6, §12. All identity columns are set only by the protected functions (0007) and are immutable.
-- Type decision (logged in the stage report): every authority identifier here is uuid, server-generated.

-- 7.9.5 eligibility_evidence (append-only). The FK to obligation (replaces_obligation_id) is added in 0006, after obligation exists.
CREATE TABLE drawbridge_auth.eligibility_evidence (
    evidence_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id             uuid NOT NULL,
    counterparty_id        uuid NOT NULL,
    kind                   text COLLATE "C" NOT NULL,
    document_digest        text COLLATE "C",
    doc_ref_raw            text COLLATE "C",
    doc_ref_normalized     text COLLATE "C",
    doc_ref_key            text COLLATE "C" NOT NULL,
    scan_status            text COLLATE "C",
    scan_candidate_keys    text[] COLLATE "C",
    replaces_obligation_id uuid,
    replacement_reason     text COLLATE "C",
    preparer_id            text COLLATE "C" NOT NULL,
    attested_by            text COLLATE "C",
    attested_at            timestamptz,
    signature_ref          text COLLATE "C",
    recorded_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    recorded_by            text COLLATE "C" NOT NULL DEFAULT session_user,
    CONSTRAINT eligibility_evidence_counterparty_fk FOREIGN KEY (project_id, counterparty_id)
        REFERENCES drawbridge_auth.counterparty (project_id, counterparty_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT eligibility_evidence_kind_chk CHECK (kind IN ('INVOICE_DOCUMENT', 'PAYABLE_IDENTITY_ATTESTATION', 'REPLACEMENT_ATTESTATION')),
    CONSTRAINT eligibility_evidence_digest_shape CHECK (document_digest IS NULL OR document_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT eligibility_evidence_ref_len CHECK (doc_ref_raw IS NULL OR char_length(doc_ref_raw) <= 128),
    CONSTRAINT eligibility_evidence_ref_normalized CHECK (doc_ref_normalized IS NOT DISTINCT FROM drawbridge_auth.normalize_invoice_ref_v1(doc_ref_raw)),
    CONSTRAINT eligibility_evidence_ref_key CHECK (doc_ref_key = COALESCE(doc_ref_normalized, '∅')),
    CONSTRAINT eligibility_evidence_scan_status_chk CHECK (scan_status IS NULL OR scan_status IN ('NO_CANDIDATES', 'CANDIDATES_RECORDED', 'UNSCANNABLE')),
    -- a scan result exists exactly when a document does (logged assumption); candidates exist exactly when CANDIDATES_RECORDED
    CONSTRAINT eligibility_evidence_scan_iff_document CHECK ((document_digest IS NULL) = (scan_status IS NULL)),
    CONSTRAINT eligibility_evidence_candidates_chk CHECK ((scan_status = 'CANDIDATES_RECORDED') = (COALESCE(cardinality(scan_candidate_keys), 0) > 0)),
    -- root kinds carry a document (AD-18); UNSCANNABLE is refused for roots (AD-18 conservative fallback)
    CONSTRAINT eligibility_evidence_root_has_document CHECK (kind = 'REPLACEMENT_ATTESTATION' OR document_digest IS NOT NULL),
    CONSTRAINT eligibility_evidence_root_not_unscannable CHECK (kind = 'REPLACEMENT_ATTESTATION' OR scan_status IS DISTINCT FROM 'UNSCANNABLE'),
    -- S1 and C5: an attestation requires NO_CANDIDATES and an empty reference key
    CONSTRAINT eligibility_evidence_s1_attestation CHECK (kind <> 'PAYABLE_IDENTITY_ATTESTATION' OR (scan_status = 'NO_CANDIDATES' AND doc_ref_key = '∅')),
    -- an invoice document carries a usable reference; S2: if the scan listed candidates, the key is one of them
    CONSTRAINT eligibility_evidence_invoice_has_key CHECK (kind <> 'INVOICE_DOCUMENT' OR doc_ref_key <> '∅'),
    CONSTRAINT eligibility_evidence_s2_candidate CHECK (kind <> 'INVOICE_DOCUMENT' OR scan_status IS DISTINCT FROM 'CANDIDATES_RECORDED' OR doc_ref_key = ANY (scan_candidate_keys)),
    CONSTRAINT eligibility_evidence_replacement_shape CHECK ((kind = 'REPLACEMENT_ATTESTATION') = (replaces_obligation_id IS NOT NULL)),
    CONSTRAINT eligibility_evidence_replacement_reason CHECK ((kind = 'REPLACEMENT_ATTESTATION') = (replacement_reason IS NOT NULL)
        AND (replacement_reason IS NULL OR replacement_reason IN ('CORRECTION', 'REBILL', 'AMOUNT_CHANGE'))),
    CONSTRAINT eligibility_evidence_preparer_len CHECK (char_length(preparer_id) BETWEEN 1 AND 128),
    CONSTRAINT eligibility_evidence_attested_not_preparer CHECK (attested_by IS NULL OR attested_by <> preparer_id),
    CONSTRAINT eligibility_evidence_attested_complete CHECK (kind = 'INVOICE_DOCUMENT'
        OR (attested_by IS NOT NULL AND attested_at IS NOT NULL AND signature_ref IS NOT NULL AND char_length(signature_ref) > 0)),
    CONSTRAINT eligibility_evidence_fk_target_uk UNIQUE (evidence_id, project_id, counterparty_id, kind, doc_ref_key),
    CONSTRAINT eligibility_evidence_replaces_uk UNIQUE (evidence_id, project_id, replaces_obligation_id)
);

-- 7.9.3 payable_lineage: one project, one counterparty, one allocation for life. lineage_id is server-generated.
CREATE TABLE drawbridge_auth.payable_lineage (
    project_id      uuid NOT NULL,
    lineage_id      uuid NOT NULL,
    counterparty_id uuid NOT NULL,
    allocation_id   uuid NOT NULL,
    created_seq     bigint GENERATED ALWAYS AS IDENTITY,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT payable_lineage_pkey PRIMARY KEY (project_id, lineage_id),
    CONSTRAINT payable_lineage_obligation_target_uk UNIQUE (project_id, counterparty_id, allocation_id, lineage_id),
    CONSTRAINT payable_lineage_registry_target_uk UNIQUE (project_id, counterparty_id, lineage_id),
    CONSTRAINT payable_lineage_counterparty_fk FOREIGN KEY (project_id, counterparty_id)
        REFERENCES drawbridge_auth.counterparty (project_id, counterparty_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT payable_lineage_allocation_fk FOREIGN KEY (project_id, allocation_id)
        REFERENCES drawbridge_auth.allocation (project_id, allocation_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- U1: the economic-payable reference registry. PRIMARY KEY is the single arbiter of duplicate references.
CREATE TABLE drawbridge_auth.payable_ref_registry (
    project_id             uuid NOT NULL,
    counterparty_id        uuid NOT NULL,
    normalized_invoice_ref text COLLATE "C" NOT NULL,
    lineage_id             uuid NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT payable_ref_registry_pkey PRIMARY KEY (project_id, counterparty_id, normalized_invoice_ref),
    CONSTRAINT payable_ref_registry_ref_shape CHECK (normalized_invoice_ref ~ '^[A-Z0-9]{3,128}$' AND normalized_invoice_ref ~ '[0-9]'),
    CONSTRAINT payable_ref_registry_obligation_target_uk UNIQUE (project_id, counterparty_id, normalized_invoice_ref, lineage_id),
    CONSTRAINT payable_ref_registry_lineage_fk FOREIGN KEY (project_id, counterparty_id, lineage_id)
        REFERENCES drawbridge_auth.payable_lineage (project_id, counterparty_id, lineage_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- U2: the global source-document registry. The key has no project, counterparty or allocation column on purpose (D5).
CREATE TABLE drawbridge_auth.source_document_registry (
    document_digest   text COLLATE "C" NOT NULL,
    project_id        uuid NOT NULL,
    counterparty_id   uuid NOT NULL,
    lineage_id        uuid NOT NULL,
    first_evidence_id uuid NOT NULL REFERENCES drawbridge_auth.eligibility_evidence (evidence_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    registered_seq    bigint GENERATED ALWAYS AS IDENTITY,
    registered_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT source_document_registry_pkey PRIMARY KEY (document_digest),
    CONSTRAINT source_document_registry_digest_shape CHECK (document_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT source_document_registry_lineage_fk FOREIGN KEY (project_id, counterparty_id, lineage_id)
        REFERENCES drawbridge_auth.payable_lineage (project_id, counterparty_id, lineage_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Append-only / immutable: UPDATE, DELETE, TRUNCATE refused by trigger (and no role holds DML).
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['eligibility_evidence', 'payable_lineage', 'payable_ref_registry', 'source_document_registry'] LOOP
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON drawbridge_auth.%I FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_update()', t || '_no_update', t);
        EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON drawbridge_auth.%I FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_delete()', t || '_no_delete', t);
        EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON drawbridge_auth.%I FOR EACH STATEMENT EXECUTE FUNCTION drawbridge_auth.forbid_truncate()', t || '_no_truncate', t);
        EXECUTE format('REVOKE ALL ON drawbridge_auth.%I FROM PUBLIC', t);
    END LOOP;
END $$;

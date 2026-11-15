-- AWX-P2-G2B-R1 / 0008: trusted source-document binding (forward-only; 0001-0007 are not edited).
-- Plan: docs/phase2/g2/G2B_R1_ARCHITECT_CORRECTION_PLAN.md sections C, D, H. Frozen G1S is unchanged.
--
-- The defect repaired: record_eligibility_evidence accepted a caller-supplied digest and scan result (G2B-V01 finding F1/F1b). Now the document BYTES are stored by
-- the database, the digest is a GENERATED ALWAYS ... STORED column (hex of sha256 of those bytes, no role can write it), the scan result is fixed at the first ingest, and the
-- evidence row is bound to the stored document by a composite foreign key. A caller-supplied digest may only be passed as a refusal-only cross-check.
--
-- What this does NOT claim (plan sections C.4 and I): authenticity of the invoice; that the stated reference matches the document unless the scan lists candidates (R-2d);
-- that a first-ingest scan result is true - it is stated by authority_svc (R-2c, OPEN); that byte-different copies of one invoice are detected (R-2b, OPEN);
-- that the database verifies any signature (it does not).
--
-- Volatility (confirmed on PostgreSQL 18.6, pg_proc.provolatile): sha256(bytea), encode(bytea,text), octet_length(bytea) are IMMUTABLE, so the generated expressions are valid.

-- D.1 fail-closed pre-flight (same pattern as 0004): rows written before this repair hold caller-supplied digests that cannot be bound to bytes.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM drawbridge_auth.eligibility_evidence) OR EXISTS (SELECT 1 FROM drawbridge_auth.source_document_registry)
       OR EXISTS (SELECT 1 FROM drawbridge_auth.payable_lineage) OR EXISTS (SELECT 1 FROM drawbridge_auth.obligation)
       OR EXISTS (SELECT 1 FROM drawbridge_auth.obligation_guard) THEN
        RAISE EXCEPTION 'G2B-R1: legacy caller-supplied digest rows exist; rebuild the scratch database' USING ERRCODE = '23514';
    END IF;
END $$;

-- D.2 the document store. Bytes are never visible through any function result and no role holds any privilege on this table.
CREATE TABLE drawbridge_auth.source_document (
    document_id         uuid NOT NULL DEFAULT gen_random_uuid(),
    content             bytea NOT NULL,
    document_digest     text COLLATE "C" GENERATED ALWAYS AS (encode(sha256(content), 'hex')) STORED NOT NULL,
    byte_length         integer GENERATED ALWAYS AS (octet_length(content)) STORED NOT NULL,
    scan_status         text COLLATE "C" NOT NULL,
    scan_candidate_keys text[] COLLATE "C" NOT NULL DEFAULT '{}',
    ingested_by         text COLLATE "C" NOT NULL DEFAULT session_user,
    ingested_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT source_document_pkey PRIMARY KEY (document_id),
    CONSTRAINT source_document_digest_key UNIQUE (document_digest),
    CONSTRAINT source_document_fk_target_uk UNIQUE (document_id, document_digest, scan_status, scan_candidate_keys),
    CONSTRAINT source_document_digest_shape CHECK (document_digest ~ '^[0-9a-f]{64}$'),
    -- OD-2: 25 MiB = 26214400 bytes, non-empty. Enforced here, at the database boundary, not only in a function.
    CONSTRAINT source_document_size_chk CHECK (octet_length(content) BETWEEN 1 AND 26214400),
    CONSTRAINT source_document_scan_status_chk CHECK (scan_status IN ('NO_CANDIDATES', 'CANDIDATES_RECORDED', 'UNSCANNABLE')),
    CONSTRAINT source_document_candidates_chk CHECK ((scan_status = 'CANDIDATES_RECORDED') = (cardinality(scan_candidate_keys) > 0))
);
CREATE TRIGGER source_document_no_update BEFORE UPDATE ON drawbridge_auth.source_document FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_update();
CREATE TRIGGER source_document_no_delete BEFORE DELETE ON drawbridge_auth.source_document FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_delete();
CREATE TRIGGER source_document_no_truncate BEFORE TRUNCATE ON drawbridge_auth.source_document FOR EACH STATEMENT EXECUTE FUNCTION drawbridge_auth.forbid_truncate();
REVOKE ALL ON drawbridge_auth.source_document FROM PUBLIC;

-- D.3 evidence is bound to the stored document. All three document columns are copied by the database from the document row, never taken from a caller.
ALTER TABLE drawbridge_auth.eligibility_evidence ADD COLUMN source_document_id uuid;
ALTER TABLE drawbridge_auth.eligibility_evidence ALTER COLUMN scan_candidate_keys SET DEFAULT '{}';
ALTER TABLE drawbridge_auth.eligibility_evidence ALTER COLUMN scan_candidate_keys SET NOT NULL;
-- closes the MATCH SIMPLE loophole (a NULL in any referencing column would skip the foreign key): the id is present exactly when the digest is
ALTER TABLE drawbridge_auth.eligibility_evidence ADD CONSTRAINT eligibility_evidence_doc_id_iff_digest CHECK ((source_document_id IS NULL) = (document_digest IS NULL));
ALTER TABLE drawbridge_auth.eligibility_evidence ADD CONSTRAINT eligibility_evidence_source_document_fk
    FOREIGN KEY (source_document_id, document_digest, scan_status, scan_candidate_keys)
    REFERENCES drawbridge_auth.source_document (document_id, document_digest, scan_status, scan_candidate_keys) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- D.4.1 internal: client_encoding is user-settable (pg_settings.context = 'user'), so the control is a refusal at every entry function, before normalization or authority work.
-- It is a configuration-integrity control, not a defense against a hostile authority_svc (plan B.4, residual R-7).
CREATE FUNCTION drawbridge_auth.assert_client_encoding_utf8() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
BEGIN
    IF current_setting('client_encoding') <> 'UTF8' THEN
        RAISE EXCEPTION 'CLIENT_ENCODING_NOT_UTF8' USING ERRCODE = '22023';
    END IF;
END $f$;

-- D.4.2 ingestion. Own transaction, committed before any creation transaction starts (R1-C4 proves why). Takes no L1-L7 lock, writes only source_document.
-- First record wins: a repeated ingest of identical bytes returns the STORED row; its new scan arguments are validated and then ignored.
CREATE FUNCTION drawbridge_auth.ingest_source_document(p_content bytea, p_scan_status text, p_scan_candidates text[])
RETURNS TABLE (document_id uuid, document_digest text, scan_status text, already_existed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_cands text[]; v_hash text; v_row drawbridge_auth.source_document%ROWTYPE; v_new boolean := false;
BEGIN
    IF session_user <> 'authority_svc' THEN
        RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    PERFORM drawbridge_auth.assert_client_encoding_utf8();
    PERFORM drawbridge_auth.assert_normalization_pin();
    IF p_content IS NULL OR octet_length(p_content) = 0 THEN
        RAISE EXCEPTION 'CONTENT_EMPTY' USING ERRCODE = '22023';
    END IF;
    IF octet_length(p_content) > 26214400 THEN
        RAISE EXCEPTION 'CONTENT_TOO_LARGE' USING ERRCODE = '22003';
    END IF;
    IF p_scan_status IS NULL OR p_scan_status NOT IN ('NO_CANDIDATES', 'CANDIDATES_RECORDED', 'UNSCANNABLE') THEN
        RAISE EXCEPTION 'SCAN_STATUS_INVALID' USING ERRCODE = '22023';
    END IF;
    -- candidates are never accepted pre-normalized. normalize_invoice_ref_v1 may raise 22023 (over-long): NOT caught, nothing is stored (RC-4).
    v_cands := COALESCE((SELECT array_agg(DISTINCT s.n ORDER BY s.n) FROM (SELECT drawbridge_auth.normalize_invoice_ref_v1(c) AS n FROM unnest(p_scan_candidates) AS c) s
                          WHERE s.n IS NOT NULL), '{}'::text[]);
    IF (p_scan_status = 'CANDIDATES_RECORDED') <> (cardinality(v_cands) > 0) THEN
        RAISE EXCEPTION 'SCAN_CANDIDATES_INCONSISTENT' USING ERRCODE = '22023';
    END IF;
    v_hash := encode(sha256(p_content), 'hex');                      -- lookup key only; the stored digest is the generated column
    SELECT sd.* INTO v_row FROM drawbridge_auth.source_document sd WHERE sd.document_digest = v_hash;
    IF NOT FOUND THEN
        INSERT INTO drawbridge_auth.source_document AS sd (content, scan_status, scan_candidate_keys) VALUES (p_content, p_scan_status, v_cands)
            ON CONFLICT ON CONSTRAINT source_document_digest_key DO NOTHING RETURNING sd.* INTO v_row;
        IF FOUND THEN
            v_new := true;
        ELSE                                                         -- a concurrent identical ingest committed first
            SELECT sd.* INTO v_row FROM drawbridge_auth.source_document sd WHERE sd.document_digest = v_hash;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'concurrent ingest not yet visible; retry the whole ingest' USING ERRCODE = '40001';
            END IF;
        END IF;
    END IF;
    RETURN QUERY SELECT v_row.document_id, v_row.document_digest, v_row.scan_status, NOT v_new;
END $f$;

-- D.4.3 evidence recording. The 13-argument version (caller digest, scan status and candidates) is dropped.
DROP FUNCTION drawbridge_auth.record_eligibility_evidence(uuid, uuid, text, text, text, text, text[], uuid, text, text, text, timestamptz, text);
CREATE FUNCTION drawbridge_auth.record_eligibility_evidence(
    p_project uuid, p_counterparty uuid, p_kind text, p_source_document_id uuid, p_expected_digest text, p_doc_ref_raw text,
    p_replaces_obligation uuid, p_replacement_reason text, p_preparer_id text, p_attested_by text, p_attested_at timestamptz, p_signature_ref text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE v_norm text; v_doc drawbridge_auth.source_document%ROWTYPE; v_id uuid := gen_random_uuid();
BEGIN
    IF session_user <> 'authority_svc' THEN
        RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    PERFORM drawbridge_auth.assert_client_encoding_utf8();
    PERFORM drawbridge_auth.assert_normalization_pin();
    -- T-77(viii): the optional digest is a refusal-only cross-check. It can reject; it never sets, selects or authorizes anything.
    IF p_expected_digest IS NOT NULL AND p_expected_digest !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'DIGEST_FORMAT' USING ERRCODE = '22023';
    END IF;
    IF p_source_document_id IS NOT NULL THEN
        SELECT sd.* INTO v_doc FROM drawbridge_auth.source_document sd WHERE sd.document_id = p_source_document_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'DOCUMENT_NOT_FOUND' USING ERRCODE = 'P0002';
        END IF;
    END IF;
    IF p_expected_digest IS NOT NULL AND p_expected_digest IS DISTINCT FROM v_doc.document_digest THEN
        RAISE EXCEPTION 'DIGEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    -- A-1 / RC-4: 22023 from normalization is NOT caught; the value is never routed to the attested path.
    v_norm := drawbridge_auth.normalize_invoice_ref_v1(p_doc_ref_raw);
    -- F4 / OD-3 precedence (frozen 7.9.10 variant (d), T-65(d)): the caller's own scope is tested first. Plain reads before any insert; the code only is returned.
    IF p_kind = 'INVOICE_DOCUMENT' AND v_norm IS NOT NULL
       AND EXISTS (SELECT 1 FROM drawbridge_auth.payable_ref_registry r WHERE r.project_id = p_project AND r.counterparty_id = p_counterparty AND r.normalized_invoice_ref = v_norm) THEN
        RAISE EXCEPTION 'DUPLICATE_PAYABLE_KEY' USING ERRCODE = 'DW409';
    END IF;
    -- D6 early refusal for root kinds, on the digest READ FROM THE STORED DOCUMENT
    IF p_kind IN ('INVOICE_DOCUMENT', 'PAYABLE_IDENTITY_ATTESTATION') AND v_doc.document_digest IS NOT NULL
       AND EXISTS (SELECT 1 FROM drawbridge_auth.source_document_registry r WHERE r.document_digest = v_doc.document_digest) THEN
        RAISE EXCEPTION 'DUPLICATE_SOURCE_DOCUMENT' USING ERRCODE = 'DW409';
    END IF;
    INSERT INTO drawbridge_auth.eligibility_evidence (evidence_id, project_id, counterparty_id, kind, source_document_id, document_digest, doc_ref_raw, doc_ref_normalized,
        doc_ref_key, scan_status, scan_candidate_keys, replaces_obligation_id, replacement_reason, preparer_id, attested_by, attested_at, signature_ref)
    VALUES (v_id, p_project, p_counterparty, p_kind, v_doc.document_id, v_doc.document_digest, p_doc_ref_raw, v_norm, COALESCE(v_norm, '∅'), v_doc.scan_status,
        COALESCE(v_doc.scan_candidate_keys, '{}'::text[]), p_replaces_obligation, p_replacement_reason, p_preparer_id, p_attested_by, p_attested_at, p_signature_ref);
    RETURN v_id;
END $f$;


-- D.4.4 / D.4.5 the two creation functions: CREATE OR REPLACE with the identical body of 0007 plus ONE added statement, assert_client_encoding_utf8() (checked by diff in the stage report).
-- Lock order, insert order and every CCP rank (G1S 7.9.9) are unchanged.
CREATE OR REPLACE FUNCTION drawbridge_auth.create_root_obligation(p_project uuid, p_allocation uuid, p_counterparty uuid, p_amount numeric, p_evidence_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_ev drawbridge_auth.eligibility_evidence%ROWTYPE;
    v_lineage uuid; v_obl uuid := gen_random_uuid(); v_class text; v_cn text; v_nm text;
BEGIN
    IF session_user <> 'authority_svc' THEN
        RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    PERFORM drawbridge_auth.assert_client_encoding_utf8();                        -- G2B-R1 F2: first statement after the session guard, before rank 1; takes no lock
    -- rank 1: L1 S on the allocation
    PERFORM 1 FROM drawbridge_auth.allocation a WHERE a.project_id = p_project AND a.allocation_id = p_allocation FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ALLOCATION_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    -- rank 2: none (a root has no existing guard; the sorted-lock routine is not called)
    -- rank 3: validate, no row lock
    PERFORM drawbridge_auth.assert_normalization_pin();
    SELECT * INTO v_ev FROM drawbridge_auth.eligibility_evidence e WHERE e.evidence_id = p_evidence_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EVIDENCE_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF v_ev.project_id <> p_project OR v_ev.counterparty_id <> p_counterparty OR v_ev.kind NOT IN ('INVOICE_DOCUMENT', 'PAYABLE_IDENTITY_ATTESTATION')
       OR v_ev.replaces_obligation_id IS NOT NULL THEN
        RAISE EXCEPTION 'EVIDENCE_SCOPE_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 99999999999.99 OR p_amount <> round(p_amount, 2) THEN
        RAISE EXCEPTION 'AMOUNT_INVALID' USING ERRCODE = '22003';
    END IF;
    IF EXISTS (SELECT 1 FROM drawbridge_auth.obligation o WHERE o.eligibility_evidence_id = p_evidence_id) THEN
        RAISE EXCEPTION 'EVIDENCE_ALREADY_USED' USING ERRCODE = 'DW409';        -- advisory early code; U3 is the arbiter
    END IF;
    v_class := CASE WHEN v_ev.doc_ref_normalized IS NOT NULL THEN 'INVOICE_BACKED' ELSE 'EVIDENCE_ATTESTED' END;
    BEGIN
        -- rank 4: new lineage (server-generated, caller-unknown key)
        v_lineage := gen_random_uuid();
        INSERT INTO drawbridge_auth.payable_lineage (project_id, lineage_id, counterparty_id, allocation_id) VALUES (p_project, v_lineage, p_counterparty, p_allocation);
        -- rank 5: claim U1 by plain INSERT when the evidence reference is usable
        IF v_ev.doc_ref_normalized IS NOT NULL THEN
            IF EXISTS (SELECT 1 FROM drawbridge_auth.payable_ref_registry r WHERE r.project_id = p_project AND r.counterparty_id = p_counterparty
                          AND r.normalized_invoice_ref = v_ev.doc_ref_normalized) THEN
                RAISE EXCEPTION 'DUPLICATE_PAYABLE_KEY' USING ERRCODE = 'DW409';   -- advisory; the primary key is the arbiter
            END IF;
            INSERT INTO drawbridge_auth.payable_ref_registry (project_id, counterparty_id, normalized_invoice_ref, lineage_id)
            VALUES (p_project, p_counterparty, v_ev.doc_ref_normalized, v_lineage);
        END IF;
        -- rank 6: claim U2 by plain INSERT; the digest is mandatory (AD-18)
        IF EXISTS (SELECT 1 FROM drawbridge_auth.source_document_registry r WHERE r.document_digest = v_ev.document_digest) THEN
            RAISE EXCEPTION 'DUPLICATE_SOURCE_DOCUMENT' USING ERRCODE = 'DW409';
        END IF;
        INSERT INTO drawbridge_auth.source_document_registry (document_digest, project_id, counterparty_id, lineage_id, first_evidence_id)
        VALUES (v_ev.document_digest, p_project, p_counterparty, v_lineage, v_ev.evidence_id);
        -- rank 7: obligation (U3, U4, U5, foreign keys, CHECKs C1/C2/C4)
        INSERT INTO drawbridge_auth.obligation (project_id, obligation_id, allocation_id, counterparty_id, lineage_id, replaces_obligation_id, amount,
            external_invoice_ref, normalized_invoice_ref, invoice_ref_key, payable_class, eligibility_evidence_id, eligibility_evidence_kind)
        VALUES (p_project, v_obl, p_allocation, p_counterparty, v_lineage, NULL, p_amount,
            v_ev.doc_ref_raw, v_ev.doc_ref_normalized, v_ev.doc_ref_key, v_class, v_ev.evidence_id, v_ev.kind);
        -- rank 8: none (a new lineage is not barred)
        -- rank 9: the new guard (created, never locked)
        INSERT INTO drawbridge_auth.obligation_guard (project_id, obligation_id, lineage_id, replacement_barred, bar_first_event_id, bar_first_effect)
        VALUES (p_project, v_obl, v_lineage, false, NULL, NULL);
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_cn = CONSTRAINT_NAME;
        v_nm := drawbridge_auth.dw409_name(v_cn);
        IF v_nm IS NOT NULL THEN
            RAISE EXCEPTION '%', v_nm USING ERRCODE = 'DW409';
        END IF;
        RAISE;
    END;
    -- rank 10: commit (deferred constraints are checked by the caller's COMMIT)
    RETURN v_obl;
END $f$;

CREATE OR REPLACE FUNCTION drawbridge_auth.create_replacement_obligation(p_replaces_obligation uuid, p_amount numeric, p_evidence_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_ev drawbridge_auth.eligibility_evidence%ROWTYPE;
    v_old drawbridge_auth.obligation%ROWTYPE; v_old2 drawbridge_auth.obligation%ROWTYPE;
    v_obl uuid := gen_random_uuid(); v_class text; v_barred boolean; v_event bigint; v_src_event bigint; v_src_kind text;
    v_other uuid; v_cn text; v_nm text;
BEGIN
    IF session_user <> 'authority_svc' THEN
        RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    PERFORM drawbridge_auth.assert_client_encoding_utf8();                        -- G2B-R1 F2: first statement after the session guard, before rank 1; takes no lock
    -- pre-lock reads (no row lock): the evidence row and the replaced obligation's immutable identity
    SELECT * INTO v_ev FROM drawbridge_auth.eligibility_evidence e WHERE e.evidence_id = p_evidence_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EVIDENCE_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF v_ev.kind <> 'REPLACEMENT_ATTESTATION' OR v_ev.replaces_obligation_id IS DISTINCT FROM p_replaces_obligation THEN
        RAISE EXCEPTION 'EVIDENCE_SCOPE_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_old FROM drawbridge_auth.obligation o WHERE o.project_id = v_ev.project_id AND o.obligation_id = p_replaces_obligation;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'OBLIGATION_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    -- rank 1: L1 S on the allocation of the replaced obligation
    PERFORM 1 FROM drawbridge_auth.allocation a WHERE a.project_id = v_old.project_id AND a.allocation_id = v_old.allocation_id FOR SHARE;
    -- rank 2: L2 on the EXISTING guard of the replaced obligation only (routine called with exactly one key)
    PERFORM drawbridge_auth.lock_existing_guards(v_old.project_id, ARRAY[v_old.obligation_id]);
    -- re-verify the immutable identity after the lock
    SELECT * INTO v_old2 FROM drawbridge_auth.obligation o WHERE o.project_id = v_old.project_id AND o.obligation_id = v_old.obligation_id;
    IF v_old2.allocation_id <> v_old.allocation_id OR v_old2.lineage_id <> v_old.lineage_id OR v_old2.counterparty_id <> v_old.counterparty_id THEN
        RAISE EXCEPTION 'IDENTITY_CHANGED' USING ERRCODE = '23001';
    END IF;
    -- rank 3: validate, no further row lock
    PERFORM drawbridge_auth.assert_normalization_pin();
    IF v_ev.counterparty_id <> v_old.counterparty_id THEN
        RAISE EXCEPTION 'EVIDENCE_SCOPE_MISMATCH' USING ERRCODE = 'P0001';                 -- LR-1
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 99999999999.99 OR p_amount <> round(p_amount, 2) THEN
        RAISE EXCEPTION 'AMOUNT_INVALID' USING ERRCODE = '22003';
    END IF;
    -- LR-8: only the lineage head (the member nobody replaces) may be replaced; advisory early code, U5 is the arbiter.
    -- LR-7 (no non-terminal intent / unresolved claimed attempt) and AD-14 (amount not below COMMITTED(L)) need payment_intent and
    -- reservations, which do not exist until G2C/G2D; they are DEFERRED there and are not enforced by this version.
    IF EXISTS (SELECT 1 FROM drawbridge_auth.obligation o WHERE o.project_id = v_old.project_id AND o.replaces_obligation_id = v_old.obligation_id) THEN
        RAISE EXCEPTION 'REPLACEMENT_EXISTS' USING ERRCODE = 'DW409';
    END IF;
    IF EXISTS (SELECT 1 FROM drawbridge_auth.obligation o WHERE o.eligibility_evidence_id = p_evidence_id) THEN
        RAISE EXCEPTION 'EVIDENCE_ALREADY_USED' USING ERRCODE = 'DW409';
    END IF;
    -- the bar is read from the guard locked at rank 2
    v_barred := drawbridge_auth.obligation_barred(v_old.project_id, v_old.obligation_id);
    v_class := CASE WHEN v_ev.doc_ref_normalized IS NOT NULL THEN 'INVOICE_BACKED' ELSE 'EVIDENCE_ATTESTED' END;
    BEGIN
        -- rank 4: none (the lineage is inherited)
        -- rank 5: U1 - reuse only a same-lineage row; another lineage's key is refused (LR-11); otherwise plain INSERT
        IF v_ev.doc_ref_normalized IS NOT NULL THEN
            SELECT r.lineage_id INTO v_other FROM drawbridge_auth.payable_ref_registry r
             WHERE r.project_id = v_old.project_id AND r.counterparty_id = v_old.counterparty_id AND r.normalized_invoice_ref = v_ev.doc_ref_normalized;
            IF FOUND THEN
                IF v_other <> v_old.lineage_id THEN
                    RAISE EXCEPTION 'DUPLICATE_PAYABLE_KEY' USING ERRCODE = 'DW409';
                END IF;
            ELSE
                INSERT INTO drawbridge_auth.payable_ref_registry (project_id, counterparty_id, normalized_invoice_ref, lineage_id)
                VALUES (v_old.project_id, v_old.counterparty_id, v_ev.doc_ref_normalized, v_old.lineage_id);
            END IF;
        END IF;
        -- rank 6: U2 - digest optional for a replacement; reuse only inside its own lineage (D2)
        IF v_ev.document_digest IS NOT NULL THEN
            SELECT r.lineage_id INTO v_other FROM drawbridge_auth.source_document_registry r WHERE r.document_digest = v_ev.document_digest;
            IF FOUND THEN
                IF v_other <> v_old.lineage_id THEN
                    RAISE EXCEPTION 'DUPLICATE_SOURCE_DOCUMENT' USING ERRCODE = 'DW409';
                END IF;
            ELSE
                INSERT INTO drawbridge_auth.source_document_registry (document_digest, project_id, counterparty_id, lineage_id, first_evidence_id)
                VALUES (v_ev.document_digest, v_old.project_id, v_old.counterparty_id, v_old.lineage_id, v_ev.evidence_id);
            END IF;
        END IF;
        -- rank 7: obligation
        INSERT INTO drawbridge_auth.obligation (project_id, obligation_id, allocation_id, counterparty_id, lineage_id, replaces_obligation_id, amount,
            external_invoice_ref, normalized_invoice_ref, invoice_ref_key, payable_class, eligibility_evidence_id, eligibility_evidence_kind)
        VALUES (v_old.project_id, v_obl, v_old.allocation_id, v_old.counterparty_id, v_old.lineage_id, v_old.obligation_id, p_amount,
            v_ev.doc_ref_raw, v_ev.doc_ref_normalized, v_ev.doc_ref_key, v_class, v_ev.evidence_id, v_ev.kind);
        -- rank 8: BAR_INHERITED when the lineage is barred; source = the lineage's earliest primary qualifying event (F5)
        IF v_barred THEN
            SELECT h.event_id, h.event_kind INTO v_src_event, v_src_kind FROM drawbridge_auth.obligation_payment_history_event h
             WHERE h.project_id = v_old.project_id AND h.lineage_id = v_old.lineage_id
               AND h.event_kind IN ('NONPAYMENT_CONFIRMED_AFTER_CLAIM', 'RETURN_POSTED', 'SETTLEMENT_REVERSED')
             ORDER BY h.event_id LIMIT 1;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'barred lineage has no primary qualifying event' USING ERRCODE = '23514';
            END IF;
            INSERT INTO drawbridge_auth.obligation_payment_history_event (project_id, allocation_id, obligation_id, lineage_id, exposure_id, event_kind, bar_effect,
                source_class, source_kind, source_reversed_kind_ref, source_event_id, event_time, authorization_ref)
            VALUES (v_old.project_id, v_old.allocation_id, v_obl, v_old.lineage_id, NULL, 'BAR_INHERITED', true,
                'LINEAGE', v_src_kind, '∅', v_src_event, clock_timestamp(), 'REPLACEMENT_ATTESTATION:' || v_ev.evidence_id::text)
            RETURNING event_id INTO v_event;
        END IF;
        -- rank 9: the new guard (created, never locked); barred with the rank-8 event when inherited
        INSERT INTO drawbridge_auth.obligation_guard (project_id, obligation_id, lineage_id, replacement_barred, bar_first_event_id, bar_first_effect)
        VALUES (v_old.project_id, v_obl, v_old.lineage_id, v_barred, v_event, CASE WHEN v_barred THEN true ELSE NULL END);
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_cn = CONSTRAINT_NAME;
        v_nm := drawbridge_auth.dw409_name(v_cn);
        IF v_nm IS NOT NULL THEN
            RAISE EXCEPTION '%', v_nm USING ERRCODE = 'DW409';
        END IF;
        RAISE;
    END;
    -- rank 10: commit
    RETURN v_obl;
END $f$;

-- D.5 grants. EXECUTE for authority_svc on exactly four functions: ingest_source_document, record_eligibility_evidence (new), create_root_obligation, create_replacement_obligation.
-- Nothing to PUBLIC or drawbridge_reader; no table privilege to any service role; assert_client_encoding_utf8 has no grant (called only from definer functions).
REVOKE ALL ON FUNCTION
    drawbridge_auth.assert_client_encoding_utf8(),
    drawbridge_auth.ingest_source_document(bytea, text, text[]),
    drawbridge_auth.record_eligibility_evidence(uuid, uuid, text, uuid, text, text, uuid, text, text, text, timestamptz, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    drawbridge_auth.ingest_source_document(bytea, text, text[]),
    drawbridge_auth.record_eligibility_evidence(uuid, uuid, text, uuid, text, text, uuid, text, text, text, timestamptz, text)
  TO authority_svc;

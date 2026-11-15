-- AWX-P2-G2B / 0007: protected SECURITY DEFINER functions and grants.
-- Contract: G1S §7.9.9 (canonical creation protocol, CCP - the single source of the order of locks and inserts), §9.2, §9.3, §7.4.7, §7.5.
-- Every function: SECURITY DEFINER, owner drawbridge_owner, SET search_path = pg_catalog, drawbridge_auth, pg_temp,
-- every reference schema-qualified, no dynamic SQL, REVOKE ALL FROM PUBLIC, EXECUTE only where stated.
-- No function takes an authorization, force, override, admin or verified parameter. The creation functions have no class, reference,
-- normalized, key, lineage or obligation-identifier parameter (C3).
-- Lock mapping (logged): L1 S = SELECT ... FROM allocation FOR SHARE; L1 X = FOR UPDATE; L2 = obligation_guard FOR UPDATE, one row at a time, sorted.

-- stable codes for unique violations (never catch-and-continue: the handler re-raises, so the whole transaction aborts)
CREATE FUNCTION drawbridge_auth.dw409_name(p_constraint text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $f$
    SELECT CASE p_constraint
        WHEN 'payable_ref_registry_pkey' THEN 'DUPLICATE_PAYABLE_KEY'
        WHEN 'source_document_registry_pkey' THEN 'DUPLICATE_SOURCE_DOCUMENT'
        WHEN 'obligation_u3_evidence_unique' THEN 'EVIDENCE_ALREADY_USED'
        WHEN 'obligation_u4_one_root_per_lineage' THEN 'LINEAGE_ROOT_EXISTS'
        WHEN 'obligation_u5_one_replacement' THEN 'REPLACEMENT_EXISTS'
        ELSE NULL END
$f$;

-- 9.3 sorted-lock routine. Locks guards that ALREADY EXIST, one row at a time, in (project_id, obligation_id) order.
-- Raises DW404 for a key with no guard row. Never called with the key of an obligation the caller is creating (P1).
CREATE FUNCTION drawbridge_auth.lock_existing_guards(p_project uuid, p_obligations uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE k record;
BEGIN
    FOR k IN SELECT p_project AS project_id, t.obligation_id FROM unnest(p_obligations) AS t(obligation_id) ORDER BY 1, 2 LOOP
        PERFORM 1 FROM drawbridge_auth.obligation_guard g WHERE g.project_id = k.project_id AND g.obligation_id = k.obligation_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'guard missing' USING ERRCODE = 'DW404';
        END IF;
    END LOOP;
END $f$;

-- 7.4.7 the one reader of the bar. Authorizing functions call it after taking the guard lock (L2).
CREATE FUNCTION drawbridge_auth.obligation_barred(p_project uuid, p_obligation uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE b boolean;
BEGIN
    SELECT g.replacement_barred INTO b FROM drawbridge_auth.obligation_guard g WHERE g.project_id = p_project AND g.obligation_id = p_obligation;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'guard missing' USING ERRCODE = 'DW404';
    END IF;
    RETURN b;
END $f$;

-- Evidence recording (§7.9.5, D6). Normalization and scan candidates are computed by the database; nothing normalized is accepted.
-- The digest is the intake component's server-computed value (the intake component does not exist yet; logged assumption).
CREATE FUNCTION drawbridge_auth.record_eligibility_evidence(
    p_project uuid, p_counterparty uuid, p_kind text, p_document_digest text, p_doc_ref_raw text,
    p_scan_status text, p_scan_candidates text[], p_replaces_obligation uuid, p_replacement_reason text,
    p_preparer_id text, p_attested_by text, p_attested_at timestamptz, p_signature_ref text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE v_norm text; v_cands text[]; v_id uuid := gen_random_uuid();
BEGIN
    IF session_user <> 'authority_svc' THEN
        RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    PERFORM drawbridge_auth.assert_normalization_pin();
    -- A-1 / RC-4: normalize_invoice_ref_v1 may raise 22023 for an over-long reference. It is NOT caught: the transaction aborts and
    -- the value is never routed to the attested path.
    v_norm := drawbridge_auth.normalize_invoice_ref_v1(p_doc_ref_raw);
    SELECT array_agg(DISTINCT n ORDER BY n) INTO v_cands
      FROM (SELECT drawbridge_auth.normalize_invoice_ref_v1(c) AS n FROM unnest(p_scan_candidates) AS c) s WHERE n IS NOT NULL;
    -- D6 early refusal for root kinds: the code only, never the other lineage's identity
    IF p_kind IN ('INVOICE_DOCUMENT', 'PAYABLE_IDENTITY_ATTESTATION') AND p_document_digest IS NOT NULL
       AND EXISTS (SELECT 1 FROM drawbridge_auth.source_document_registry r WHERE r.document_digest = p_document_digest) THEN
        RAISE EXCEPTION 'DUPLICATE_SOURCE_DOCUMENT' USING ERRCODE = 'DW409';
    END IF;
    INSERT INTO drawbridge_auth.eligibility_evidence (evidence_id, project_id, counterparty_id, kind, document_digest, doc_ref_raw, doc_ref_normalized,
        doc_ref_key, scan_status, scan_candidate_keys, replaces_obligation_id, replacement_reason, preparer_id, attested_by, attested_at, signature_ref)
    VALUES (v_id, p_project, p_counterparty, p_kind, p_document_digest, p_doc_ref_raw, v_norm, COALESCE(v_norm, '∅'), p_scan_status, v_cands,
        p_replaces_obligation, p_replacement_reason, p_preparer_id, p_attested_by, p_attested_at, p_signature_ref);
    RETURN v_id;
END $f$;

-- ---------------------------------------------------------------------------------------------------------------------
-- create_root_obligation: CCP ranks 1-10. A root has no existing guard, so rank 2 is empty and the routine is not called.
CREATE FUNCTION drawbridge_auth.create_root_obligation(p_project uuid, p_allocation uuid, p_counterparty uuid, p_amount numeric, p_evidence_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_ev drawbridge_auth.eligibility_evidence%ROWTYPE;
    v_lineage uuid; v_obl uuid := gen_random_uuid(); v_class text; v_cn text; v_nm text;
BEGIN
    IF session_user <> 'authority_svc' THEN
        RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
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

-- create_replacement_obligation: CCP ranks 1-10. Locks only the EXISTING guard of the replaced obligation; the new guard is never locked.
CREATE FUNCTION drawbridge_auth.create_replacement_obligation(p_replaces_obligation uuid, p_amount numeric, p_evidence_id uuid) RETURNS uuid
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

-- ---------------------------------------------------------------------------------------------------------------------
-- record_adverse_event (§7.5): INTERNAL. No EXECUTE to any role. Called only inside the G2C posting functions, in their transaction.
-- Takes L1 X first (callers must not hold a weaker L1 mode: no lock upgrades), locks every lineage guard sorted, inserts the primary
-- event for the originating obligation and one BAR_INHERITED event for every other member, then sets each member's guard FALSE->TRUE.
CREATE FUNCTION drawbridge_auth.record_adverse_event(
    p_project uuid, p_obligation uuid, p_event_kind text, p_source_class text, p_source_kind text, p_source_reversed_kind_ref text,
    p_source_resolution_id uuid, p_source_txn_id uuid, p_exposure_id uuid, p_event_time timestamptz, p_authorization_ref text, p_evidence_ref text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_o drawbridge_auth.obligation%ROWTYPE; v_members uuid[]; v_primary bigint; v_m uuid; v_ev bigint;
BEGIN
    IF p_event_kind NOT IN ('NONPAYMENT_CONFIRMED_AFTER_CLAIM', 'RETURN_POSTED', 'SETTLEMENT_REVERSED') THEN
        RAISE EXCEPTION 'record_adverse_event records only primary qualifying events' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_o FROM drawbridge_auth.obligation o WHERE o.project_id = p_project AND o.obligation_id = p_obligation;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'OBLIGATION_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    -- L1 X
    PERFORM 1 FROM drawbridge_auth.allocation a WHERE a.project_id = v_o.project_id AND a.allocation_id = v_o.allocation_id FOR UPDATE;
    -- L2: every lineage member's guard, sorted, one row at a time
    SELECT array_agg(o.obligation_id) INTO v_members FROM drawbridge_auth.obligation o WHERE o.project_id = v_o.project_id AND o.lineage_id = v_o.lineage_id;
    PERFORM drawbridge_auth.lock_existing_guards(v_o.project_id, v_members);
    -- primary event for the originating obligation
    INSERT INTO drawbridge_auth.obligation_payment_history_event (project_id, allocation_id, obligation_id, lineage_id, exposure_id, event_kind, bar_effect,
        source_class, source_kind, source_reversed_kind_ref, source_resolution_id, source_txn_id, event_time, authorization_ref, evidence_ref)
    VALUES (v_o.project_id, v_o.allocation_id, v_o.obligation_id, v_o.lineage_id, p_exposure_id, p_event_kind, true,
        p_source_class, p_source_kind, p_source_reversed_kind_ref, p_source_resolution_id, p_source_txn_id, p_event_time, p_authorization_ref, p_evidence_ref)
    RETURNING event_id INTO v_primary;
    UPDATE drawbridge_auth.obligation_guard g SET replacement_barred = true, bar_first_event_id = v_primary, bar_first_effect = true
     WHERE g.project_id = v_o.project_id AND g.obligation_id = v_o.obligation_id AND g.replacement_barred = false;
    -- BAR_INHERITED for every other member (lineage propagation)
    FOR v_m IN SELECT t.m FROM unnest(v_members) AS t(m) WHERE t.m <> v_o.obligation_id ORDER BY 1 LOOP
        INSERT INTO drawbridge_auth.obligation_payment_history_event (project_id, allocation_id, obligation_id, lineage_id, exposure_id, event_kind, bar_effect,
            source_class, source_kind, source_reversed_kind_ref, source_event_id, event_time, authorization_ref)
        VALUES (v_o.project_id, v_o.allocation_id, v_m, v_o.lineage_id, NULL, 'BAR_INHERITED', true,
            'LINEAGE', p_event_kind, '∅', v_primary, p_event_time, p_authorization_ref)
        RETURNING event_id INTO v_ev;
        UPDATE drawbridge_auth.obligation_guard g SET replacement_barred = true, bar_first_event_id = v_ev, bar_first_effect = true
         WHERE g.project_id = v_o.project_id AND g.obligation_id = v_m AND g.replacement_barred = false;
    END LOOP;
    RETURN v_primary;
END $f$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Grants. Only the three entry functions are executable, and only by authority_svc. Everything else is internal (owner-run callers).
REVOKE ALL ON FUNCTION
    drawbridge_auth.dw409_name(text), drawbridge_auth.lock_existing_guards(uuid, uuid[]), drawbridge_auth.obligation_barred(uuid, uuid),
    drawbridge_auth.record_eligibility_evidence(uuid, uuid, text, text, text, text, text[], uuid, text, text, text, timestamptz, text),
    drawbridge_auth.create_root_obligation(uuid, uuid, uuid, numeric, uuid),
    drawbridge_auth.create_replacement_obligation(uuid, numeric, uuid),
    drawbridge_auth.record_adverse_event(uuid, uuid, text, text, text, text, uuid, uuid, uuid, timestamptz, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    drawbridge_auth.record_eligibility_evidence(uuid, uuid, text, text, text, text, text[], uuid, text, text, text, timestamptz, text),
    drawbridge_auth.create_root_obligation(uuid, uuid, uuid, numeric, uuid),
    drawbridge_auth.create_replacement_obligation(uuid, numeric, uuid)
  TO authority_svc;

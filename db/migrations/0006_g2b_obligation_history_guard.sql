-- AWX-P2-G2B / 0006: obligation, durable history ledger, obligation guard, permanent-bar controls.
-- Contract: G1S §7.2 to §7.5, §7.9.3, §7.9.7, §12.
-- DEFERRED to later stages (columns exist, keys do not, because the referenced tables do not exist yet):
--   history F2 (exposure), F3 (resolution), F4 (journal), F6 (observation)  -> G2C/G2D, added by ALTER TABLE then.

-- ---------------------------------------------------------------- obligation
CREATE TABLE drawbridge_auth.obligation (
    project_id                 uuid NOT NULL,
    obligation_id              uuid NOT NULL DEFAULT gen_random_uuid(),
    allocation_id              uuid NOT NULL,
    counterparty_id            uuid NOT NULL,
    lineage_id                 uuid NOT NULL,
    replaces_obligation_id     uuid,
    amount                     numeric(20,2) NOT NULL,
    external_invoice_ref       text COLLATE "C",
    normalized_invoice_ref     text COLLATE "C",
    invoice_ref_key            text COLLATE "C" NOT NULL,
    normalization_version      text COLLATE "C" NOT NULL DEFAULT 'v1',
    payable_class              text COLLATE "C" NOT NULL,
    eligibility_evidence_id    uuid NOT NULL,
    eligibility_evidence_kind  text COLLATE "C" NOT NULL,
    created_seq                bigint GENERATED ALWAYS AS IDENTITY,
    created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT obligation_pkey PRIMARY KEY (project_id, obligation_id),
    -- UK-O1 .. UK-O4 (keys used elsewhere)
    CONSTRAINT obligation_uk_o1 UNIQUE (project_id, allocation_id, obligation_id),
    CONSTRAINT obligation_uk_o2 UNIQUE (project_id, obligation_id, lineage_id),
    CONSTRAINT obligation_uk_o3 UNIQUE (project_id, allocation_id, obligation_id, lineage_id),
    CONSTRAINT obligation_uk_o4 UNIQUE (project_id, counterparty_id, allocation_id, lineage_id, obligation_id),
    -- canonical ownership
    CONSTRAINT obligation_allocation_fk FOREIGN KEY (project_id, allocation_id)
        REFERENCES drawbridge_auth.allocation (project_id, allocation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT obligation_lineage_fk FOREIGN KEY (project_id, counterparty_id, allocation_id, lineage_id)
        REFERENCES drawbridge_auth.payable_lineage (project_id, counterparty_id, allocation_id, lineage_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    -- LR-1 .. LR-4: replacement edge (skipped for a root, whose replaces_obligation_id is NULL)
    CONSTRAINT obligation_replaces_fk FOREIGN KEY (project_id, counterparty_id, allocation_id, lineage_id, replaces_obligation_id)
        REFERENCES drawbridge_auth.obligation (project_id, counterparty_id, allocation_id, lineage_id, obligation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT obligation_no_self_replace CHECK (replaces_obligation_id IS NULL OR replaces_obligation_id <> obligation_id),
    -- C4: reference and kind equal what the independent evidence recorded
    CONSTRAINT obligation_evidence_c4_fk FOREIGN KEY (eligibility_evidence_id, project_id, counterparty_id, eligibility_evidence_kind, invoice_ref_key)
        REFERENCES drawbridge_auth.eligibility_evidence (evidence_id, project_id, counterparty_id, kind, doc_ref_key) ON UPDATE RESTRICT ON DELETE RESTRICT,
    -- a replacement's attestation names the same replaced obligation (skipped for a root)
    CONSTRAINT obligation_evidence_replaces_fk FOREIGN KEY (eligibility_evidence_id, project_id, replaces_obligation_id)
        REFERENCES drawbridge_auth.eligibility_evidence (evidence_id, project_id, replaces_obligation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    -- U1 link: a non-null normalized reference must be registered to this lineage (skipped for NULL by design; C4/C5 govern)
    CONSTRAINT obligation_registry_fk FOREIGN KEY (project_id, counterparty_id, normalized_invoice_ref, lineage_id)
        REFERENCES drawbridge_auth.payable_ref_registry (project_id, counterparty_id, normalized_invoice_ref, lineage_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT obligation_amount_range CHECK (amount > 0 AND amount <= 99999999999.99),
    CONSTRAINT obligation_ref_len CHECK (external_invoice_ref IS NULL OR char_length(external_invoice_ref) <= 128),
    -- C1 / C2: the class is derived from the normalized reference
    CONSTRAINT obligation_class_derived CHECK (payable_class = CASE WHEN normalized_invoice_ref IS NOT NULL THEN 'INVOICE_BACKED' ELSE 'EVIDENCE_ATTESTED' END),
    CONSTRAINT obligation_ref_recomputed CHECK (normalized_invoice_ref IS NOT DISTINCT FROM drawbridge_auth.normalize_invoice_ref_v1(external_invoice_ref)),
    CONSTRAINT obligation_ref_key CHECK (invoice_ref_key = COALESCE(normalized_invoice_ref, '∅')),
    CONSTRAINT obligation_normalization_version CHECK (normalization_version = 'v1'),
    -- C4: a root is INVOICE_BACKED exactly when its evidence is an INVOICE_DOCUMENT; kinds follow root/replacement
    CONSTRAINT obligation_kind_shape CHECK (
        (replaces_obligation_id IS NULL AND eligibility_evidence_kind IN ('INVOICE_DOCUMENT', 'PAYABLE_IDENTITY_ATTESTATION')
            AND ((payable_class = 'INVOICE_BACKED') = (eligibility_evidence_kind = 'INVOICE_DOCUMENT')))
        OR (replaces_obligation_id IS NOT NULL AND eligibility_evidence_kind = 'REPLACEMENT_ATTESTATION')),
    CONSTRAINT obligation_u3_evidence_unique UNIQUE (eligibility_evidence_id)
);
-- U4: one root per lineage. U5: one direct replacement per obligation.
CREATE UNIQUE INDEX obligation_u4_one_root_per_lineage ON drawbridge_auth.obligation (project_id, lineage_id) WHERE replaces_obligation_id IS NULL;
CREATE UNIQUE INDEX obligation_u5_one_replacement ON drawbridge_auth.obligation (project_id, replaces_obligation_id) WHERE replaces_obligation_id IS NOT NULL;
CREATE INDEX obligation_lineage_idx ON drawbridge_auth.obligation (project_id, lineage_id);

-- eligibility_evidence.replaces_obligation_id now has a target
ALTER TABLE drawbridge_auth.eligibility_evidence ADD CONSTRAINT eligibility_evidence_replaces_fk FOREIGN KEY (project_id, replaces_obligation_id)
    REFERENCES drawbridge_auth.obligation (project_id, obligation_id) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE TRIGGER obligation_immutable BEFORE UPDATE ON drawbridge_auth.obligation FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_identity_update(
    'project_id', 'obligation_id', 'allocation_id', 'counterparty_id', 'lineage_id', 'replaces_obligation_id', 'amount', 'external_invoice_ref',
    'normalized_invoice_ref', 'invoice_ref_key', 'normalization_version', 'payable_class', 'eligibility_evidence_id', 'eligibility_evidence_kind',
    'created_seq', 'created_at');
CREATE TRIGGER obligation_no_delete BEFORE DELETE ON drawbridge_auth.obligation FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_delete();
CREATE TRIGGER obligation_no_truncate BEFORE TRUNCATE ON drawbridge_auth.obligation FOR EACH STATEMENT EXECUTE FUNCTION drawbridge_auth.forbid_truncate();

-- LR-5 (no cycles): the replaced row is strictly older. Deferred; reads without locks.
CREATE FUNCTION drawbridge_auth.check_replacement_older() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
BEGIN
    IF NEW.replaces_obligation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM drawbridge_auth.obligation o
         WHERE o.project_id = NEW.project_id AND o.obligation_id = NEW.replaces_obligation_id AND o.created_seq < NEW.created_seq) THEN
        RAISE EXCEPTION 'LR-5: replaced obligation must exist and be older' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $f$;
CREATE CONSTRAINT TRIGGER obligation_lr5_older AFTER INSERT ON drawbridge_auth.obligation DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.check_replacement_older();

-- ---------------------------------------------------------------- history ledger (7.4)
CREATE TABLE drawbridge_auth.obligation_payment_history_event (
    event_id                 bigint GENERATED ALWAYS AS IDENTITY,
    project_id               uuid NOT NULL,
    allocation_id            uuid NOT NULL,
    obligation_id            uuid NOT NULL,
    lineage_id               uuid NOT NULL,
    exposure_id              uuid,
    event_kind               text COLLATE "C" NOT NULL,
    bar_effect               boolean NOT NULL,
    audit_subkind            text COLLATE "C",
    annotates_event_id       bigint,
    source_class             text COLLATE "C" NOT NULL,
    source_kind              text COLLATE "C" NOT NULL,
    source_reversed_kind_ref text COLLATE "C" NOT NULL,
    source_resolution_id     uuid,
    source_txn_id            uuid,
    source_event_id          bigint,
    source_observation_id    uuid,
    event_time               timestamptz NOT NULL,
    recorded_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    authority                text COLLATE "C" NOT NULL DEFAULT session_user,
    authorization_ref        text COLLATE "C" NOT NULL,
    evidence_ref             text COLLATE "C",
    CONSTRAINT history_uk_h0 PRIMARY KEY (event_id),
    CONSTRAINT history_uk_h1 UNIQUE (event_id, project_id, obligation_id),
    CONSTRAINT history_uk_h2 UNIQUE (event_id, project_id, lineage_id, event_kind),
    CONSTRAINT history_uk_h3 UNIQUE (event_id, project_id, obligation_id, bar_effect),
    CONSTRAINT history_f1_scope_fk FOREIGN KEY (project_id, allocation_id, obligation_id, lineage_id)
        REFERENCES drawbridge_auth.obligation (project_id, allocation_id, obligation_id, lineage_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT history_f5_lineage_fk FOREIGN KEY (source_event_id, project_id, lineage_id, source_kind)
        REFERENCES drawbridge_auth.obligation_payment_history_event (event_id, project_id, lineage_id, event_kind) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT history_f7_annotation_fk FOREIGN KEY (annotates_event_id, project_id, obligation_id)
        REFERENCES drawbridge_auth.obligation_payment_history_event (event_id, project_id, obligation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT history_kind_chk CHECK (event_kind IN ('NONPAYMENT_CONFIRMED_AFTER_CLAIM', 'RETURN_POSTED', 'SETTLEMENT_REVERSED', 'BAR_INHERITED', 'AUDIT')),
    CONSTRAINT history_bar_effect_chk CHECK (bar_effect = (event_kind <> 'AUDIT')),
    CONSTRAINT history_exposure_chk CHECK ((event_kind = 'BAR_INHERITED') = (exposure_id IS NULL)),
    CONSTRAINT history_audit_shape CHECK (
        (event_kind = 'AUDIT' AND audit_subkind IS NOT NULL AND annotates_event_id IS NOT NULL)
        OR (event_kind <> 'AUDIT' AND audit_subkind IS NULL AND annotates_event_id IS NULL)),
    CONSTRAINT history_source_class_chk CHECK (source_class IN ('RESOLUTION', 'JOURNAL', 'LINEAGE', 'OBSERVATION')),
    -- 7.4.2 item 1: exactly one source column, matching the class (explicit IS [NOT] NULL tests)
    CONSTRAINT history_one_source CHECK (
        (source_class = 'RESOLUTION' AND source_resolution_id IS NOT NULL AND source_txn_id IS NULL AND source_event_id IS NULL AND source_observation_id IS NULL)
        OR (source_class = 'JOURNAL' AND source_txn_id IS NOT NULL AND source_resolution_id IS NULL AND source_event_id IS NULL AND source_observation_id IS NULL)
        OR (source_class = 'LINEAGE' AND source_event_id IS NOT NULL AND source_resolution_id IS NULL AND source_txn_id IS NULL AND source_observation_id IS NULL)
        OR (source_class = 'OBSERVATION' AND source_observation_id IS NOT NULL AND source_resolution_id IS NULL AND source_txn_id IS NULL AND source_event_id IS NULL)),
    -- 7.4.2 item 2: kind -> class -> source kind -> reversed-kind reference. For BAR_INHERITED the source kind is the primary event kind
    -- of the source event (the F5 key compares it with that event's event_kind) - logged interpretation.
    CONSTRAINT history_kind_class_map CHECK (
        (event_kind = 'NONPAYMENT_CONFIRMED_AFTER_CLAIM' AND source_class = 'RESOLUTION' AND source_kind = 'CONFIRMED_NONPAYMENT' AND source_reversed_kind_ref = '∅')
        OR (event_kind = 'RETURN_POSTED' AND source_class = 'JOURNAL' AND source_kind = 'RETURN' AND source_reversed_kind_ref = '∅')
        OR (event_kind = 'SETTLEMENT_REVERSED' AND source_class = 'JOURNAL' AND source_kind = 'REVERSAL' AND source_reversed_kind_ref = 'SETTLEMENT')
        OR (event_kind = 'BAR_INHERITED' AND source_class = 'LINEAGE'
            AND source_kind IN ('NONPAYMENT_CONFIRMED_AFTER_CLAIM', 'RETURN_POSTED', 'SETTLEMENT_REVERSED') AND source_reversed_kind_ref = '∅')
        OR (event_kind = 'AUDIT' AND source_class IN ('RESOLUTION', 'JOURNAL', 'OBSERVATION'))),
    CONSTRAINT history_evidence_required CHECK (event_kind NOT IN ('RETURN_POSTED', 'NONPAYMENT_CONFIRMED_AFTER_CLAIM') OR evidence_ref IS NOT NULL),
    CONSTRAINT history_authorization_ref_nonempty CHECK (char_length(authorization_ref) > 0)
);
-- 7.4.4 null-safe partial unique indexes
CREATE UNIQUE INDEX history_uq_h1 ON drawbridge_auth.obligation_payment_history_event (source_resolution_id) WHERE bar_effect AND source_class = 'RESOLUTION';
CREATE UNIQUE INDEX history_uq_h2 ON drawbridge_auth.obligation_payment_history_event (source_txn_id) WHERE bar_effect AND source_class = 'JOURNAL';
CREATE UNIQUE INDEX history_uq_h3 ON drawbridge_auth.obligation_payment_history_event (project_id, obligation_id, source_event_id) WHERE bar_effect AND source_class = 'LINEAGE';
CREATE UNIQUE INDEX history_uq_h4 ON drawbridge_auth.obligation_payment_history_event (audit_subkind, source_resolution_id) WHERE NOT bar_effect AND source_class = 'RESOLUTION';
CREATE UNIQUE INDEX history_uq_h5 ON drawbridge_auth.obligation_payment_history_event (audit_subkind, source_txn_id) WHERE NOT bar_effect AND source_class = 'JOURNAL';
CREATE UNIQUE INDEX history_uq_h6 ON drawbridge_auth.obligation_payment_history_event (audit_subkind, source_observation_id) WHERE NOT bar_effect AND source_class = 'OBSERVATION';
CREATE INDEX history_idx_bar ON drawbridge_auth.obligation_payment_history_event (project_id, obligation_id) WHERE bar_effect;
CREATE INDEX history_lineage_idx ON drawbridge_auth.obligation_payment_history_event (project_id, lineage_id);

-- recorded_at and authority are never caller-supplied
CREATE FUNCTION drawbridge_auth.history_force_recorded() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
    NEW.recorded_at := clock_timestamp();
    NEW.authority := session_user;
    RETURN NEW;
END $f$;
CREATE TRIGGER history_force_recorded BEFORE INSERT ON drawbridge_auth.obligation_payment_history_event FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.history_force_recorded();
CREATE TRIGGER history_no_update BEFORE UPDATE ON drawbridge_auth.obligation_payment_history_event FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_update();
CREATE TRIGGER history_no_delete BEFORE DELETE ON drawbridge_auth.obligation_payment_history_event FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_delete();
CREATE TRIGGER history_no_truncate BEFORE TRUNCATE ON drawbridge_auth.obligation_payment_history_event FOR EACH STATEMENT EXECUTE FUNCTION drawbridge_auth.forbid_truncate();

-- ---------------------------------------------------------------- obligation_guard (7.4.5)
CREATE TABLE drawbridge_auth.obligation_guard (
    project_id         uuid NOT NULL,
    obligation_id      uuid NOT NULL,
    lineage_id         uuid NOT NULL,
    replacement_barred boolean NOT NULL DEFAULT false,
    bar_first_event_id bigint,
    bar_first_effect   boolean,
    CONSTRAINT obligation_guard_pkey PRIMARY KEY (project_id, obligation_id),
    CONSTRAINT guard_obligation_fk FOREIGN KEY (project_id, obligation_id, lineage_id)
        REFERENCES drawbridge_auth.obligation (project_id, obligation_id, lineage_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT guard_bar_shape CHECK (
        (replacement_barred AND bar_first_event_id IS NOT NULL AND bar_first_effect IS TRUE)
        OR (NOT replacement_barred AND bar_first_event_id IS NULL AND bar_first_effect IS NULL)),
    CONSTRAINT guard_first_bar_event_fk FOREIGN KEY (bar_first_event_id, project_id, obligation_id, bar_first_effect)
        REFERENCES drawbridge_auth.obligation_payment_history_event (event_id, project_id, obligation_id, bar_effect)
        MATCH SIMPLE ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX guard_lineage_idx ON drawbridge_auth.obligation_guard (project_id, lineage_id);

-- monotonic guard: no change of identity, no TRUE->FALSE, no change of an already set first-bar event,
-- and FALSE->TRUE only together with bar_first_event_id and bar_first_effect = TRUE in the same statement
CREATE FUNCTION drawbridge_auth.guard_monotonic() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.obligation_id IS DISTINCT FROM OLD.obligation_id OR NEW.lineage_id IS DISTINCT FROM OLD.lineage_id THEN
        RAISE EXCEPTION 'guard identity is immutable' USING ERRCODE = '23001';
    END IF;
    IF OLD.replacement_barred AND NOT NEW.replacement_barred THEN
        RAISE EXCEPTION 'the replacement bar is permanent (TRUE to FALSE refused)' USING ERRCODE = '23001';
    END IF;
    IF OLD.bar_first_event_id IS NOT NULL AND (NEW.bar_first_event_id IS DISTINCT FROM OLD.bar_first_event_id OR NEW.bar_first_effect IS DISTINCT FROM OLD.bar_first_effect) THEN
        RAISE EXCEPTION 'bar_first_event_id is immutable once set' USING ERRCODE = '23001';
    END IF;
    IF NOT OLD.replacement_barred AND NEW.replacement_barred AND (NEW.bar_first_event_id IS NULL OR NEW.bar_first_effect IS DISTINCT FROM TRUE) THEN
        RAISE EXCEPTION 'FALSE to TRUE requires bar_first_event_id and bar_first_effect = TRUE in the same statement' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
END $f$;
CREATE TRIGGER guard_monotonic BEFORE UPDATE ON drawbridge_auth.obligation_guard FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.guard_monotonic();
CREATE TRIGGER guard_no_delete BEFORE DELETE ON drawbridge_auth.obligation_guard FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_delete();
CREATE TRIGGER guard_no_truncate BEFORE TRUNCATE ON drawbridge_auth.obligation_guard FOR EACH STATEMENT EXECUTE FUNCTION drawbridge_auth.forbid_truncate();

-- Deferred, verification-only (no locks): (1) replacement_barred equals EXISTS(bar_effect event);
-- (2) bar_first_event_id is the smallest bar_effect event_id of the obligation; (3) every obligation has a guard.
CREATE FUNCTION drawbridge_auth.verify_guard_vs_history(p_project uuid, p_obligation uuid) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE g drawbridge_auth.obligation_guard%ROWTYPE; first_bar bigint;
BEGIN
    SELECT * INTO g FROM drawbridge_auth.obligation_guard WHERE project_id = p_project AND obligation_id = p_obligation;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'obligation % has no guard at commit', p_obligation USING ERRCODE = '23514';
    END IF;
    SELECT min(event_id) INTO first_bar FROM drawbridge_auth.obligation_payment_history_event
     WHERE project_id = p_project AND obligation_id = p_obligation AND bar_effect;
    IF g.replacement_barred IS DISTINCT FROM (first_bar IS NOT NULL) THEN
        RAISE EXCEPTION 'guard.replacement_barred (%) disagrees with the history ledger for obligation %', g.replacement_barred, p_obligation USING ERRCODE = '23514';
    END IF;
    IF g.replacement_barred AND g.bar_first_event_id IS DISTINCT FROM first_bar THEN
        RAISE EXCEPTION 'bar_first_event_id is not the earliest bar_effect event for obligation %', p_obligation USING ERRCODE = '23514';
    END IF;
END $f$;
CREATE FUNCTION drawbridge_auth.trg_guard_verify() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
BEGIN
    PERFORM drawbridge_auth.verify_guard_vs_history(NEW.project_id, NEW.obligation_id);
    RETURN NULL;
END $f$;
CREATE CONSTRAINT TRIGGER guard_verify_history AFTER INSERT OR UPDATE ON drawbridge_auth.obligation_guard DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.trg_guard_verify();
CREATE CONSTRAINT TRIGGER history_verify_guard AFTER INSERT ON drawbridge_auth.obligation_payment_history_event DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.trg_guard_verify();
CREATE CONSTRAINT TRIGGER obligation_has_guard AFTER INSERT ON drawbridge_auth.obligation DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.trg_guard_verify();

REVOKE ALL ON drawbridge_auth.obligation, drawbridge_auth.obligation_payment_history_event, drawbridge_auth.obligation_guard FROM PUBLIC;
REVOKE ALL ON FUNCTION drawbridge_auth.check_replacement_older(), drawbridge_auth.history_force_recorded(), drawbridge_auth.guard_monotonic(),
    drawbridge_auth.verify_guard_vs_history(uuid, uuid), drawbridge_auth.trg_guard_verify() FROM PUBLIC;

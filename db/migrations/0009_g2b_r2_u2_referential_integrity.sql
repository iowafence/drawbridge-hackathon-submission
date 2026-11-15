-- AWX-P2-G2B-R2 / 0009: U2 referential integrity, both directions (forward-only; 0001-0008 are not edited).
-- Plan: docs/phase2/g2/G2B_R2_CONSOLIDATED_CORRECTION_PLAN.md section 5. Frozen G1S is unchanged. Owner record: G2B_R2_OWNER_AUTHORIZATION.md (V01).
--
-- Direction 1 (constraint): a source_document_registry row must name an eligibility_evidence row with the SAME evidence id, project, counterparty and document digest.
--   Because evidence is bound to a stored source_document by the 0008 composite key, the registry digest therefore equals a stored document's digest transitively.
--   FOREIGN KEY, fully validated at ADD time (never NOT VALID): a database that holds a violating row refuses this migration, atomically, and no ledger row is written.
-- Direction 2 (deferred constraint trigger): an obligation whose evidence carries a digest must have a registry row for that digest in the obligation's own
--   project, counterparty and lineage, checked at COMMIT. The trigger reads only (no lock, no write), like obligation_has_guard and obligation_lr5_older.
--
-- What is and is not protected (stated once here, repeated in the stage report):
--   mechanically enforced by the engine ...... the foreign key (every writer, including the owner role); the deferred trigger (every writer, unless disabled)
--   restricted by role/function .............. only authority_svc, through four SECURITY DEFINER functions, may create authority rows; no table privilege exists for it
--   detected only by read-only audit ......... a superuser or the table owner disabling triggers or setting session_replication_role = replica, then writing; restoring data
--   bypassable by a superuser or the schema owner: ALTER TABLE ... DISABLE TRIGGER, session_replication_role = replica, DROP of the constraint or trigger. No
--   claim of protection against these is made; the audit tool (tools/audit_source_documents.py) exists to detect the result.
-- No function is replaced, no grant is changed, and the canonical creation order of G1S 7.9.9 is not touched.

-- Direction 1: the referenced key. It contains the primary key, so it cannot make any digest value unique (G1S 7.9.5 sentence: evidence "carries no unique key on it" holds).
ALTER TABLE drawbridge_auth.eligibility_evidence
    ADD CONSTRAINT eligibility_evidence_registry_fk_target_uk UNIQUE (evidence_id, project_id, counterparty_id, document_digest);

-- MATCH SIMPLE is safe here: all four registry columns are NOT NULL, so the key is always fully checked. A first_evidence_id of evidence with a NULL digest has no match
-- in the target (a NULL never equals) and is refused with 23503.
ALTER TABLE drawbridge_auth.source_document_registry
    ADD CONSTRAINT source_document_registry_evidence_fk
    FOREIGN KEY (first_evidence_id, project_id, counterparty_id, document_digest)
    REFERENCES drawbridge_auth.eligibility_evidence (evidence_id, project_id, counterparty_id, document_digest) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- Direction 2. SECURITY DEFINER with a fixed search_path so the check does not depend on the privileges of the role that happens to be current when the deferred event fires.
CREATE FUNCTION drawbridge_auth.check_obligation_u2_registry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE v_digest text;
BEGIN
    SELECT e.document_digest INTO v_digest FROM drawbridge_auth.eligibility_evidence e WHERE e.evidence_id = NEW.eligibility_evidence_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'U2: obligation % cites no evidence row', NEW.obligation_id USING ERRCODE = '23514';
    END IF;
    IF v_digest IS NULL THEN
        -- only a replacement may rest on evidence without a document; a root must carry one (AD-18)
        IF NEW.replaces_obligation_id IS NULL THEN
            RAISE EXCEPTION 'U2: root obligation % has evidence without a document digest', NEW.obligation_id USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM drawbridge_auth.source_document_registry r
                    WHERE r.document_digest = v_digest AND r.project_id = NEW.project_id AND r.counterparty_id = NEW.counterparty_id
                      AND r.lineage_id = NEW.lineage_id) THEN
        RAISE EXCEPTION 'U2: obligation % has no source_document_registry row for its evidence digest in its own lineage', NEW.obligation_id USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END $f$;
CREATE CONSTRAINT TRIGGER obligation_has_u2_registry AFTER INSERT ON drawbridge_auth.obligation DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.check_obligation_u2_registry();

REVOKE ALL ON FUNCTION drawbridge_auth.check_obligation_u2_registry() FROM PUBLIC;

-- AWX-P2-G2B-R2 / 0010: trusted raw-byte identity boundary and scan-provenance marker (forward-only; 0001-0009 are not edited).
-- Plan: docs/phase2/g2/G2B_R2_CONSOLIDATED_CORRECTION_PLAN.md sections 2.4, 4.4, 6. Owner record: G2B_R2_OWNER_AUTHORIZATION.md (V01): OD-9, OD-10, DEV-G1S-7.9.4-001.
-- Frozen G1S is unchanged.
--
-- The defect repaired (G2B-R1 rejection, D-1 / D-5): a text parameter is converted from the client encoding to UTF8 when the protocol message that carries it is received.
-- A check made when the function executes (assert_client_encoding_utf8) cannot see that earlier conversion, so it is not a boundary and is kept only as a secondary,
-- restrictive control (OD-10). Identity-bearing input (the invoice reference and the scan candidates) now crosses the boundary as bytea. The DATABASE decodes it, strictly,
-- as UTF8 (convert_from, which refuses invalid, overlong, surrogate and NUL sequences with 22021) and derives every stored identity from those bytes alone.
-- The original bytes are stored beside the decoded text, and CHECK constraints make the decoded text and the candidate keys a pure function of the stored bytes.
-- Every remaining text parameter is a closed-set constant or an ASCII token (assert_ascii_token): a character above U+007F in a token is refused, never converted.
--
-- What this does NOT claim:
--  * that the bytes are what the invoice says (a hostile authority_svc chooses the bytes; same class as R-3 / R-2d);
--  * that a text-format bytea parameter carrying raw bytes of 0x80 or above was not converted by PostgreSQL BEFORE the database saw it: the client conversion applies to
--    the text of any text-format parameter, including bytea written in escape format. Only hex-format (backslash-x) text and binary-format bytea are copied unconverted.
--    The service must send bytea in binary or hex form (plan section 2.4 service connection rule). The database records the bytes it received.
--  * that the scan result is true or independently verified: it is stated by authority_svc and is permanently marked AUTHORITY_ASSERTED (DEV-G1S-7.9.4-001, open);
--  * protection against a superuser or the table owner.

-- Fail-closed pre-flight (same pattern as 0004 and 0008). Rows written before this boundary hold text-decoded identity without raw bytes and cannot be bound to bytes.
-- Nothing is altered, deleted or repaired to get past this; a populated scratch database is rebuilt (bootstrap, then the migrations in order).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM drawbridge_auth.eligibility_evidence) OR EXISTS (SELECT 1 FROM drawbridge_auth.source_document)
       OR EXISTS (SELECT 1 FROM drawbridge_auth.source_document_registry) OR EXISTS (SELECT 1 FROM drawbridge_auth.payable_lineage)
       OR EXISTS (SELECT 1 FROM drawbridge_auth.obligation) THEN
        RAISE EXCEPTION 'G2B-R2: rows hold text-decoded identity without raw bytes; rebuild the scratch database' USING ERRCODE = '23514';
    END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------- internal helpers (no EXECUTE for any role)
-- Strict decode. 22021 (from convert_from) on invalid UTF-8, overlong forms, surrogate code points and NUL; 22023 on NULL, empty or more than 512 bytes (OD-9).
CREATE FUNCTION drawbridge_auth.decode_identity_utf8(p_bytes bytea, p_what text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
BEGIN
    IF p_bytes IS NULL THEN
        RAISE EXCEPTION '%', p_what || '_REQUIRED' USING ERRCODE = '22023';
    END IF;
    IF octet_length(p_bytes) = 0 THEN
        RAISE EXCEPTION '%', p_what || '_EMPTY' USING ERRCODE = '22023';
    END IF;
    IF octet_length(p_bytes) > 512 THEN
        RAISE EXCEPTION '%', p_what || '_TOO_LONG' USING ERRCODE = '22023';
    END IF;
    RETURN convert_from(p_bytes, 'UTF8');
END $f$;

-- ASCII token (OD-9): printable ASCII U+0021..U+007E, no space, no control character, nothing above U+007F; length 1..p_max. Never trims, truncates or coerces.
CREATE FUNCTION drawbridge_auth.assert_ascii_token(p_value text, p_what text, p_max integer, p_required boolean) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
BEGIN
    IF p_value IS NULL THEN
        IF p_required THEN
            RAISE EXCEPTION '%', p_what || '_REQUIRED' USING ERRCODE = '22023';
        END IF;
        RETURN;
    END IF;
    IF char_length(p_value) NOT BETWEEN 1 AND p_max OR (p_value COLLATE "C") !~ '^[!-~]+$' THEN
        RAISE EXCEPTION 'NON_ASCII_OR_INVALID_TOKEN' USING ERRCODE = '22023';
    END IF;
END $f$;

-- The scan candidate keys: decode every candidate strictly, normalize it, drop the unusable ones, de-duplicate, sort. Used by ingest AND by a CHECK constraint, so the
-- stored keys are, by construction and by constraint, a pure function of the stored raw candidate bytes. At most 64 candidates (OD-9), one dimension, no NULL element.
CREATE FUNCTION drawbridge_auth.candidate_keys_v1(p_raw bytea[]) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE v_keys text[];
BEGIN
    IF p_raw IS NULL THEN
        RAISE EXCEPTION 'SCAN_CANDIDATES_NULL' USING ERRCODE = '22023';
    END IF;
    IF array_ndims(p_raw) > 1 THEN
        RAISE EXCEPTION 'SCAN_CANDIDATES_NOT_ONE_DIMENSIONAL' USING ERRCODE = '22023';
    END IF;
    IF cardinality(p_raw) > 64 THEN
        RAISE EXCEPTION 'TOO_MANY_CANDIDATES' USING ERRCODE = '22023';
    END IF;
    -- normalize_invoice_ref_v1 may raise 22023 (over-long): not caught, nothing is stored (RC-4)
    SELECT COALESCE(array_agg(DISTINCT s.n ORDER BY s.n), '{}'::text[]) INTO v_keys
      FROM (SELECT drawbridge_auth.normalize_invoice_ref_v1(drawbridge_auth.decode_identity_utf8(c.b, 'CANDIDATE')) AS n FROM unnest(p_raw) AS c(b)) s
     WHERE s.n IS NOT NULL;
    RETURN v_keys;
END $f$;

-- ---------------------------------------------------------------------------------------------------------------- the document store
-- Raw candidate bytes and the permanent provenance marker. scan_source has no parameter anywhere: no caller can set it.
ALTER TABLE drawbridge_auth.source_document ADD COLUMN scan_candidate_raw bytea[] NOT NULL DEFAULT '{}';
ALTER TABLE drawbridge_auth.source_document ADD COLUMN scan_source text COLLATE "C" NOT NULL DEFAULT 'AUTHORITY_ASSERTED';
ALTER TABLE drawbridge_auth.source_document ADD CONSTRAINT source_document_scan_source_chk CHECK (scan_source = 'AUTHORITY_ASSERTED');
ALTER TABLE drawbridge_auth.source_document ADD CONSTRAINT source_document_candidate_keys_derived CHECK (scan_candidate_keys = drawbridge_auth.candidate_keys_v1(scan_candidate_raw));

-- ---------------------------------------------------------------------------------------------------------------- evidence
ALTER TABLE drawbridge_auth.eligibility_evidence ADD COLUMN doc_ref_raw_bytes bytea;
ALTER TABLE drawbridge_auth.eligibility_evidence ADD COLUMN scan_source text COLLATE "C";
ALTER TABLE drawbridge_auth.eligibility_evidence ADD CONSTRAINT eligibility_evidence_raw_bytes_iff_raw CHECK ((doc_ref_raw_bytes IS NULL) = (doc_ref_raw IS NULL));
ALTER TABLE drawbridge_auth.eligibility_evidence ADD CONSTRAINT eligibility_evidence_raw_bytes_len CHECK (doc_ref_raw_bytes IS NULL OR octet_length(doc_ref_raw_bytes) BETWEEN 1 AND 512);
-- INV-ENC: the stored text IS the strict UTF-8 decoding of the stored bytes. convert_from is STABLE, not IMMUTABLE; PostgreSQL 18.6 accepts it in a CHECK (confirmed by this
-- statement succeeding) and re-evaluates it on every insert and on restore. The decoded text then feeds the unchanged normalization CHECK of 0005.
ALTER TABLE drawbridge_auth.eligibility_evidence ADD CONSTRAINT eligibility_evidence_raw_decoded CHECK (doc_ref_raw_bytes IS NULL OR doc_ref_raw = convert_from(doc_ref_raw_bytes, 'UTF8'));
ALTER TABLE drawbridge_auth.eligibility_evidence ADD CONSTRAINT eligibility_evidence_scan_source_iff_document CHECK ((scan_source IS NULL) = (document_digest IS NULL));
-- ASCII tokens (OD-9). Widths follow the existing preparer CHECK (128); attested_by 128; signature_ref 256. None is wider than before (signature_ref was unbounded).
-- (The length is a separate bound: PostgreSQL regular expressions accept at most 255 repetitions, so {1,256} would fail at first use.)
ALTER TABLE drawbridge_auth.eligibility_evidence ADD CONSTRAINT eligibility_evidence_preparer_ascii CHECK (char_length(preparer_id) BETWEEN 1 AND 128 AND preparer_id COLLATE "C" ~ '^[!-~]+$');
ALTER TABLE drawbridge_auth.eligibility_evidence ADD CONSTRAINT eligibility_evidence_attested_by_ascii CHECK (attested_by IS NULL OR (char_length(attested_by) BETWEEN 1 AND 128 AND attested_by COLLATE "C" ~ '^[!-~]+$'));
ALTER TABLE drawbridge_auth.eligibility_evidence ADD CONSTRAINT eligibility_evidence_signature_ref_ascii CHECK (signature_ref IS NULL OR (char_length(signature_ref) BETWEEN 1 AND 256 AND signature_ref COLLATE "C" ~ '^[!-~]+$'));

-- The evidence-to-document key now also binds the provenance marker (the 0008 key is rebuilt; both tables are empty, checked above).
ALTER TABLE drawbridge_auth.eligibility_evidence DROP CONSTRAINT eligibility_evidence_source_document_fk;
ALTER TABLE drawbridge_auth.source_document DROP CONSTRAINT source_document_fk_target_uk;
ALTER TABLE drawbridge_auth.source_document ADD CONSTRAINT source_document_fk_target_uk UNIQUE (document_id, document_digest, scan_status, scan_candidate_keys, scan_source);
ALTER TABLE drawbridge_auth.eligibility_evidence ADD CONSTRAINT eligibility_evidence_source_document_fk
    FOREIGN KEY (source_document_id, document_digest, scan_status, scan_candidate_keys, scan_source)
    REFERENCES drawbridge_auth.source_document (document_id, document_digest, scan_status, scan_candidate_keys, scan_source) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------------------------------------------- entry functions
-- The two text-typed signatures are DROPPED (not wrapped): leaving them callable would leave the defect reachable by name. Their grants go with them.
DROP FUNCTION drawbridge_auth.ingest_source_document(bytea, text, text[]);
DROP FUNCTION drawbridge_auth.record_eligibility_evidence(uuid, uuid, text, uuid, text, text, uuid, text, text, text, timestamptz, text);

-- Ingestion: own committed transaction, first record wins, takes no L1-L7 lock, writes only source_document. The scan status and candidates are STATED BY THE CALLER
-- (authority_svc) and are marked AUTHORITY_ASSERTED permanently (DEV-G1S-7.9.4-001): they are not independently verified.
CREATE FUNCTION drawbridge_auth.ingest_source_document(p_content bytea, p_scan_status text, p_scan_candidates bytea[])
RETURNS TABLE (document_id uuid, document_digest text, scan_status text, already_existed boolean, scan_source text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE
    v_keys text[]; v_hash text; v_row drawbridge_auth.source_document%ROWTYPE; v_new boolean := false;
BEGIN
    IF session_user <> 'authority_svc' THEN
        RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    PERFORM drawbridge_auth.assert_client_encoding_utf8();            -- secondary control only (OD-10); NOT the encoding boundary
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
    -- strict decode of every candidate inside the database; never accepted pre-normalized, never trimmed, truncated, replaced or dropped for size
    v_keys := drawbridge_auth.candidate_keys_v1(p_scan_candidates);
    IF (p_scan_status = 'CANDIDATES_RECORDED') <> (cardinality(v_keys) > 0) THEN
        RAISE EXCEPTION 'SCAN_CANDIDATES_INCONSISTENT' USING ERRCODE = '22023';
    END IF;
    v_hash := encode(sha256(p_content), 'hex');                      -- lookup key only; the stored digest is the generated column
    SELECT sd.* INTO v_row FROM drawbridge_auth.source_document sd WHERE sd.document_digest = v_hash;
    IF NOT FOUND THEN
        INSERT INTO drawbridge_auth.source_document AS sd (content, scan_status, scan_candidate_keys, scan_candidate_raw) VALUES (p_content, p_scan_status, v_keys, p_scan_candidates)
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
    RETURN QUERY SELECT v_row.document_id, v_row.document_digest, v_row.scan_status, NOT v_new, v_row.scan_source;
END $f$;

-- Evidence recording. p_doc_ref_raw is bytea; the three identifiers are ASCII tokens; kind and replacement reason are closed sets; the digest is a refusal-only cross-check.
CREATE FUNCTION drawbridge_auth.record_eligibility_evidence(
    p_project uuid, p_counterparty uuid, p_kind text, p_source_document_id uuid, p_expected_digest text, p_doc_ref_raw bytea,
    p_replaces_obligation uuid, p_replacement_reason text, p_preparer_id text, p_attested_by text, p_attested_at timestamptz, p_signature_ref text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE v_ref text; v_norm text; v_doc drawbridge_auth.source_document%ROWTYPE; v_id uuid := gen_random_uuid();
BEGIN
    IF session_user <> 'authority_svc' THEN
        RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    PERFORM drawbridge_auth.assert_client_encoding_utf8();            -- secondary control only (OD-10); NOT the encoding boundary
    PERFORM drawbridge_auth.assert_normalization_pin();
    -- R-ENC-1: closed sets and ASCII tokens only; nothing outside them is accepted, trimmed or converted
    IF p_kind IS NULL OR p_kind NOT IN ('INVOICE_DOCUMENT', 'PAYABLE_IDENTITY_ATTESTATION', 'REPLACEMENT_ATTESTATION') THEN
        RAISE EXCEPTION 'KIND_INVALID' USING ERRCODE = '22023';
    END IF;
    IF p_replacement_reason IS NOT NULL AND p_replacement_reason NOT IN ('CORRECTION', 'REBILL', 'AMOUNT_CHANGE') THEN
        RAISE EXCEPTION 'REPLACEMENT_REASON_INVALID' USING ERRCODE = '22023';
    END IF;
    PERFORM drawbridge_auth.assert_ascii_token(p_preparer_id, 'PREPARER_ID', 128, true);
    PERFORM drawbridge_auth.assert_ascii_token(p_attested_by, 'ATTESTED_BY', 128, false);
    PERFORM drawbridge_auth.assert_ascii_token(p_signature_ref, 'SIGNATURE_REF', 256, false);
    -- T-77(viii): the optional digest is a refusal-only cross-check. It can reject; it never sets, selects or authorizes anything. ASCII by construction.
    IF p_expected_digest IS NOT NULL AND (p_expected_digest COLLATE "C") !~ '^[0-9a-f]{64}$' THEN
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
    -- INV-ENC: the reference text is decoded here, strictly, from the received bytes; the U1 key is normalize_v1(decode(bytes)) and depends on no session setting.
    -- A NULL reference (an attestation without one) stays NULL; zero bytes are not a value and are refused. 22021 / 22023 are NOT caught (RC-4): never routed to an attested path.
    IF p_doc_ref_raw IS NOT NULL THEN
        v_ref := drawbridge_auth.decode_identity_utf8(p_doc_ref_raw, 'REFERENCE');
    END IF;
    v_norm := drawbridge_auth.normalize_invoice_ref_v1(v_ref);
    -- OD-4 / frozen 7.9.10 variant (d): the caller's own scope is tested first. Plain reads before any insert; the code only is returned.
    IF p_kind = 'INVOICE_DOCUMENT' AND v_norm IS NOT NULL
       AND EXISTS (SELECT 1 FROM drawbridge_auth.payable_ref_registry r WHERE r.project_id = p_project AND r.counterparty_id = p_counterparty AND r.normalized_invoice_ref = v_norm) THEN
        RAISE EXCEPTION 'DUPLICATE_PAYABLE_KEY' USING ERRCODE = 'DW409';
    END IF;
    -- D6 early refusal for root kinds, on the digest READ FROM THE STORED DOCUMENT
    IF p_kind IN ('INVOICE_DOCUMENT', 'PAYABLE_IDENTITY_ATTESTATION') AND v_doc.document_digest IS NOT NULL
       AND EXISTS (SELECT 1 FROM drawbridge_auth.source_document_registry r WHERE r.document_digest = v_doc.document_digest) THEN
        RAISE EXCEPTION 'DUPLICATE_SOURCE_DOCUMENT' USING ERRCODE = 'DW409';
    END IF;
    INSERT INTO drawbridge_auth.eligibility_evidence (evidence_id, project_id, counterparty_id, kind, source_document_id, document_digest, doc_ref_raw, doc_ref_raw_bytes,
        doc_ref_normalized, doc_ref_key, scan_status, scan_candidate_keys, scan_source, replaces_obligation_id, replacement_reason, preparer_id, attested_by, attested_at, signature_ref)
    VALUES (v_id, p_project, p_counterparty, p_kind, v_doc.document_id, v_doc.document_digest, v_ref, p_doc_ref_raw,
        v_norm, COALESCE(v_norm, '∅'), v_doc.scan_status, COALESCE(v_doc.scan_candidate_keys, '{}'::text[]), v_doc.scan_source,
        p_replaces_obligation, p_replacement_reason, p_preparer_id, p_attested_by, p_attested_at, p_signature_ref);
    RETURN v_id;
END $f$;

-- ---------------------------------------------------------------------------------------------------------------- grants
-- EXECUTE for authority_svc on exactly four functions: the two new ones here, and create_root_obligation / create_replacement_obligation (0007/0008, unchanged: they take
-- no free text). The helpers have no grant. Nothing to PUBLIC or drawbridge_reader. No table privilege to any service role.
REVOKE ALL ON FUNCTION
    drawbridge_auth.decode_identity_utf8(bytea, text),
    drawbridge_auth.assert_ascii_token(text, text, integer, boolean),
    drawbridge_auth.candidate_keys_v1(bytea[]),
    drawbridge_auth.ingest_source_document(bytea, text, bytea[]),
    drawbridge_auth.record_eligibility_evidence(uuid, uuid, text, uuid, text, bytea, uuid, text, text, text, timestamptz, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    drawbridge_auth.ingest_source_document(bytea, text, bytea[]),
    drawbridge_auth.record_eligibility_evidence(uuid, uuid, text, uuid, text, bytea, uuid, text, text, text, timestamptz, text)
  TO authority_svc;

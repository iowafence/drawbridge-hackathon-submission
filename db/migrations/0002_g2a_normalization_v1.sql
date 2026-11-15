-- AWX-P2-G2A / 0002: normalization v1 (§7.9.4) and the normalization pin (§7.10.3).
-- psql variable :corpus_sha256 is supplied by the runner (sha256 of fixtures/normalization_corpus_v1.json).

-- Step 0 is enforced on the raw text; the text type itself cannot hold NUL, and an invalid UTF-8 byte
-- sequence is refused by PostgreSQL at input (UTF8 database), before this function is reached.
-- Rejections raise SQLSTATE 22023; "unusable" returns NULL.
CREATE FUNCTION drawbridge_auth.normalize_invoice_ref_v1(p_raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v text;
BEGIN
    IF char_length(p_raw) > 128 OR octet_length(p_raw) > 512 THEN
        RAISE EXCEPTION 'invoice reference exceeds 128 characters or 512 octets' USING ERRCODE = '22023';
    END IF;
    v := normalize(p_raw, NFKC);
    v := translate(v, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    v := regexp_replace(v COLLATE "C", '[^A-Z0-9]', '', 'g');
    v := regexp_replace(v COLLATE "C", '(^|[A-Z])0+([0-9])', '\1\2', 'g');
    IF char_length(v) > 128 THEN
        RAISE EXCEPTION 'normalized invoice reference exceeds 128 characters' USING ERRCODE = '22023';
    END IF;
    IF char_length(v) < 3 OR v !~ '[0-9]' THEN
        RETURN NULL;
    END IF;
    RETURN v;
END $f$;
REVOKE ALL ON FUNCTION drawbridge_auth.normalize_invoice_ref_v1(text) FROM PUBLIC;

CREATE TABLE drawbridge_auth.normalization_pin (
    normalization_version text COLLATE "C" PRIMARY KEY CHECK (normalization_version = 'v1'),
    pg_major              integer NOT NULL,
    server_encoding       text COLLATE "C" NOT NULL CHECK (server_encoding = 'UTF8'),
    unicode_version       text COLLATE "C" NOT NULL,
    function_source_sha256 text COLLATE "C" NOT NULL CHECK (function_source_sha256 ~ '^[0-9a-f]{64}$'),
    corpus_sha256         text COLLATE "C" NOT NULL CHECK (corpus_sha256 ~ '^[0-9a-f]{64}$'),
    pinned_by             text COLLATE "C" NOT NULL DEFAULT session_user,
    pinned_at             timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER normalization_pin_no_update BEFORE UPDATE ON drawbridge_auth.normalization_pin
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_update();
CREATE TRIGGER normalization_pin_no_delete BEFORE DELETE ON drawbridge_auth.normalization_pin
    FOR EACH ROW EXECUTE FUNCTION drawbridge_auth.forbid_delete();
CREATE TRIGGER normalization_pin_no_truncate BEFORE TRUNCATE ON drawbridge_auth.normalization_pin
    FOR EACH STATEMENT EXECUTE FUNCTION drawbridge_auth.forbid_truncate();

-- Pin written by the migrator in the migration that creates the function.
INSERT INTO drawbridge_auth.normalization_pin
    (normalization_version, pg_major, server_encoding, unicode_version, function_source_sha256, corpus_sha256)
SELECT 'v1',
       current_setting('server_version_num')::integer / 10000,
       current_setting('server_encoding'),
       unicode_version(),
       encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
       :'corpus_sha256'
FROM pg_proc p WHERE p.oid = 'drawbridge_auth.normalize_invoice_ref_v1(text)'::regprocedure;

-- Raises NORMALIZATION_PIN_MISMATCH (SQLSTATE DW500) on any drift. Reads built-in server facts only to refuse;
-- it authorizes nothing (§9.1 unaffected). Internal helper: no EXECUTE to any role.
CREATE FUNCTION drawbridge_auth.assert_normalization_pin() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, drawbridge_auth, pg_temp AS $f$
DECLARE pin drawbridge_auth.normalization_pin%ROWTYPE; live_src text;
BEGIN
    SELECT * INTO pin FROM drawbridge_auth.normalization_pin WHERE normalization_version = 'v1';
    SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') INTO live_src
      FROM pg_proc p WHERE p.oid = 'drawbridge_auth.normalize_invoice_ref_v1(text)'::regprocedure;
    IF NOT FOUND OR pin.normalization_version IS NULL
       OR pin.pg_major IS DISTINCT FROM current_setting('server_version_num')::integer / 10000
       OR pin.server_encoding IS DISTINCT FROM current_setting('server_encoding')
       OR pin.unicode_version IS DISTINCT FROM unicode_version()
       OR pin.function_source_sha256 IS DISTINCT FROM live_src THEN
        RAISE EXCEPTION 'NORMALIZATION_PIN_MISMATCH' USING ERRCODE = 'DW500';
    END IF;
END $f$;
REVOKE ALL ON FUNCTION drawbridge_auth.assert_normalization_pin() FROM PUBLIC;

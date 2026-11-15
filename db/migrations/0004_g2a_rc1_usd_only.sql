-- AWX-P2-G2A-ADR RC-1: allocation currency is USD only (G1S §3.3 "Allocation measures (allocation α, USD)", P11, journal CHECK, N4).
-- Existing rows are validated first so the failure names the cause. Constraint: allocation_currency_usd_only.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM drawbridge_auth.allocation WHERE currency <> 'USD') THEN
        RAISE EXCEPTION 'RC-1: non-USD allocation rows exist; refusing to add allocation_currency_usd_only' USING ERRCODE = '23514';
    END IF;
END $$;
ALTER TABLE drawbridge_auth.allocation ADD CONSTRAINT allocation_currency_usd_only CHECK (currency = 'USD');

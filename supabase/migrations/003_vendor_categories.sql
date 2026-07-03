CREATE TABLE IF NOT EXISTS vendor_categories (
    id          BIGSERIAL   PRIMARY KEY,
    pattern     TEXT        NOT NULL,
    match_type  TEXT        NOT NULL DEFAULT 'contains'
                            CHECK (match_type IN ('exact', 'contains', 'starts_with')),
    category    TEXT        NOT NULL
                            CHECK (category IN (
                                'INCOME','SALARY','OTHER','INSURANCE','LOAN',
                                'CASH','TRAVEL','PHONE','CHARGES',
                                'Bank_Transfer','HMRC','RENT','BILLS'
                            )),
    notes       TEXT,
    active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vendor_categories_active_idx ON vendor_categories (active);

-- Seed with initial known vendors from the Softov Barclays statement
INSERT INTO vendor_categories (pattern, match_type, category, notes) VALUES
    ('Commission Charges',          'contains',     'CHARGES',       'Barclays account commission fee'),
    ('Internet Banking Transfer',   'contains',     'Bank_Transfer', 'Barclays inter-account transfer'),
    ('Online Banking Transfer',     'contains',     'Bank_Transfer', 'Barclays inter-account transfer'),
    ('Shell',                       'contains',     'TRAVEL',        'Petrol station'),
    ('BP ',                         'starts_with',  'TRAVEL',        'Petrol station — BP (space prevents matching e.g. BPS)'),
    ('Esso',                        'contains',     'TRAVEL',        'Petrol station'),
    ('Texaco',                      'contains',     'TRAVEL',        'Petrol station'),
    ('HMRC',                        'contains',     'HMRC',          'All HMRC payments')
ON CONFLICT DO NOTHING;

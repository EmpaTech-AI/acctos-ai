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
    source      TEXT        NOT NULL DEFAULT 'manual'
                            CHECK (source IN ('manual', 'ai')),
    notes       TEXT,
    active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (pattern, match_type)
);

CREATE INDEX IF NOT EXISTS vendor_categories_active_idx ON vendor_categories (active);

-- Seed with initial known vendors
INSERT INTO vendor_categories (pattern, match_type, category, source, notes) VALUES
    ('Commission Charges',          'contains',     'CHARGES',       'manual', 'Barclays account commission fee'),
    ('Internet Banking Transfer',   'contains',     'Bank_Transfer', 'manual', 'Barclays inter-account transfer'),
    ('Online Banking Transfer',     'contains',     'Bank_Transfer', 'manual', 'Barclays inter-account transfer'),
    ('Shell',                       'contains',     'TRAVEL',        'manual', 'Petrol station'),
    ('BP ',                         'starts_with',  'TRAVEL',        'manual', 'Petrol station'),
    ('Esso',                        'contains',     'TRAVEL',        'manual', 'Petrol station'),
    ('Texaco',                      'contains',     'TRAVEL',        'manual', 'Petrol station'),
    ('HMRC',                        'contains',     'HMRC',          'manual', 'All HMRC payments')
ON CONFLICT (pattern, match_type) DO NOTHING;

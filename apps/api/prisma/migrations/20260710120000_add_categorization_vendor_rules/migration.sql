-- Categorization vendor rules — keyword-based, ordered by specificity within each category.
-- Rules are first-match-wins by id ASC. Insertions within this script are ordered so that
-- more specific patterns (e.g. TESCO BANK) get lower IDs than broader siblings (e.g. TESCO).

-- ── INSURANCE ────────────────────────────────────────────────────────────────
INSERT INTO "vendor_categories" (pattern, match_type, category, active, source) VALUES
('AVIVA',           'contains', 'INSURANCE', true, 'manual'),
('HASTINGS DIRECT', 'contains', 'INSURANCE', true, 'manual'),
('ADMIRAL',         'contains', 'INSURANCE', true, 'manual'),
('AXA',             'contains', 'INSURANCE', true, 'manual'),
('LEGAL & GENERAL', 'contains', 'INSURANCE', true, 'manual'),
('DIRECT LINE',     'contains', 'INSURANCE', true, 'manual'),
('NFU MUTUAL',      'contains', 'INSURANCE', true, 'manual'),
('ZURICH INSUR',    'contains', 'INSURANCE', true, 'manual'),
('LV INSURANCE',    'contains', 'INSURANCE', true, 'manual');

-- ── TRAVEL — fuel & transport (TFL already exists) ───────────────────────────
INSERT INTO "vendor_categories" (pattern, match_type, category, active, source) VALUES
('ESSO',            'contains', 'TRAVEL', true, 'manual'),
('TEXACO',          'contains', 'TRAVEL', true, 'manual'),
('TRAINLINE',       'contains', 'TRAVEL', true, 'manual'),
('NATIONAL RAIL',   'contains', 'TRAVEL', true, 'manual'),
('GREATER ANGLIA',  'contains', 'TRAVEL', true, 'manual'),
('SOUTH WESTERN',   'contains', 'TRAVEL', true, 'manual'),
('GATWICK EXPRESS', 'contains', 'TRAVEL', true, 'manual'),
('HEATHROW EXPRESS','contains', 'TRAVEL', true, 'manual'),
('BOLT RIDE',       'contains', 'TRAVEL', true, 'manual'),
('UBER',            'contains', 'TRAVEL', true, 'manual'),
('JUSTPARK',        'contains', 'TRAVEL', true, 'manual'),
('RINGGO',          'contains', 'TRAVEL', true, 'manual');

-- ── PHONE / MOBILE ───────────────────────────────────────────────────────────
INSERT INTO "vendor_categories" (pattern, match_type, category, active, source) VALUES
('VODAFONE',        'contains', 'PHONE', true, 'manual'),
('BT MOBILE',       'contains', 'PHONE', true, 'manual'),
('BT GROUP',        'contains', 'PHONE', true, 'manual'),
('TALKTALK',        'contains', 'PHONE', true, 'manual'),
('SKY MOBILE',      'contains', 'PHONE', true, 'manual'),
('SKY BROADBAND',   'contains', 'PHONE', true, 'manual'),
('VIRGIN MEDIA',    'contains', 'PHONE', true, 'manual'),
('PLUSNET',         'contains', 'PHONE', true, 'manual'),
('GiffGaff',        'contains', 'PHONE', true, 'manual'),
('SMARTY',          'contains', 'PHONE', true, 'manual');

-- ── BILLS / UTILITIES ────────────────────────────────────────────────────────
INSERT INTO "vendor_categories" (pattern, match_type, category, active, source) VALUES
('COUNCIL TAX',     'contains', 'BILLS', true, 'manual'),
('THAMES WATER',    'contains', 'BILLS', true, 'manual'),
('BRITISH GAS',     'contains', 'BILLS', true, 'manual'),
('ANGLIAN WATER',   'contains', 'BILLS', true, 'manual'),
('SEVERN TRENT',    'contains', 'BILLS', true, 'manual'),
('SCOTTISH POWER',  'contains', 'BILLS', true, 'manual'),
('SOUTHERN WATER',  'contains', 'BILLS', true, 'manual'),
('YORKSHIRE WATER', 'contains', 'BILLS', true, 'manual'),
('UNITED UTILITIES','contains', 'BILLS', true, 'manual'),
('E.ON ENERGY',     'contains', 'BILLS', true, 'manual'),
('EON ENERGY',      'contains', 'BILLS', true, 'manual'),
('NPOWER',          'contains', 'BILLS', true, 'manual'),
('SHELL ENERGY',    'contains', 'BILLS', true, 'manual'),
('OVO ENERGY',      'contains', 'BILLS', true, 'manual'),
('OCTOPUS ENERGY',  'contains', 'BILLS', true, 'manual'),
('BULB ENERGY',     'contains', 'BILLS', true, 'manual'),
('WATER DIRECT',    'contains', 'BILLS', true, 'manual');

-- ── Bank_Transfer — specific digital banks ───────────────────────────────────
INSERT INTO "vendor_categories" (pattern, match_type, category, active, source) VALUES
('REVOLUT',         'contains', 'Bank_Transfer', true, 'manual'),
('STARLING',        'contains', 'Bank_Transfer', true, 'manual'),
('TESCO BANK',      'contains', 'Bank_Transfer', true, 'manual'),
('VIRGIN MONEY',    'contains', 'Bank_Transfer', true, 'manual'),
('ATOM BANK',       'contains', 'Bank_Transfer', true, 'manual');

-- ── OTHER — retail & general spending ────────────────────────────────────────
-- TESCO BANK inserted above (higher priority); plain TESCO → OTHER
INSERT INTO "vendor_categories" (pattern, match_type, category, active, source) VALUES
('TESCO',           'contains', 'OTHER', true, 'manual'),
('SAINSBURY',       'contains', 'OTHER', true, 'manual'),
('ASDA',            'contains', 'OTHER', true, 'manual'),
('LIDL',            'contains', 'OTHER', true, 'manual'),
('ALDI',            'contains', 'OTHER', true, 'manual'),
('MORRISONS',       'contains', 'OTHER', true, 'manual'),
('WAITROSE',        'contains', 'OTHER', true, 'manual'),
('CO-OP',           'contains', 'OTHER', true, 'manual'),
('EBAY',            'contains', 'OTHER', true, 'manual'),
('AMAZON',          'contains', 'OTHER', true, 'manual'),
('IKEA',            'contains', 'OTHER', true, 'manual'),
('PRIMARK',         'contains', 'OTHER', true, 'manual'),
('MARKS & SPENCER', 'contains', 'OTHER', true, 'manual'),
('CURRYS',          'contains', 'OTHER', true, 'manual'),
('ARGOS',           'contains', 'OTHER', true, 'manual'),
('BOOTS',           'contains', 'OTHER', true, 'manual'),
('SCREWFIX',        'contains', 'OTHER', true, 'manual'),
('HALFORDS',        'contains', 'OTHER', true, 'manual'),
('SPORTS DIRECT',   'contains', 'OTHER', true, 'manual'),
('JD SPORTS',       'contains', 'OTHER', true, 'manual'),
('MCDONALDS',       'contains', 'OTHER', true, 'manual'),
('SUBWAY',          'contains', 'OTHER', true, 'manual'),
('GREGGS',          'contains', 'OTHER', true, 'manual'),
('COSTA',           'contains', 'OTHER', true, 'manual'),
('STARBUCKS',       'contains', 'OTHER', true, 'manual'),
('DELIVEROO',       'contains', 'OTHER', true, 'manual'),
('JUST EAT',        'contains', 'OTHER', true, 'manual'),
('UBER EATS',       'contains', 'OTHER', true, 'manual');

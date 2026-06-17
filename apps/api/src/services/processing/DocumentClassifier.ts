export type BankType =
    | 'hsbc' | 'revolut' | 'monzo' | 'wise' | 'starling'
    | 'natwest' | 'mettle' | 'nationwide' | 'santander' | 'barclays' | 'barclaycard' | 'metro'
    | 'lloyds' | 'tsb' | 'tide' | 'rbs' | 'virginmoney' | 'pockit' | 'zempler' | 'countingup'
    | 'halifax' | 'anna'
    | 'generic';

export type DocType = 'bank_statement' | 'vat';
export type FileFormat = 'pdf' | 'excel';
export type ProcessingPath = 'azure_parser' | 'assistant' | 'excel';

export interface Classification {
    bankType: BankType;
    docType: DocType;
    fileFormat: FileFormat;
    processingPath: ProcessingPath;
}

export function classify(filename: string, mimeType: string): Classification {
    const lower = filename.toLowerCase();
    const mime = (mimeType || '').toLowerCase();

    const fileFormat = detectFormat(lower, mime);
    const bankType = detectBank(lower);
    const docType = detectDocType(lower);
    const processingPath = fileFormat === 'excel'
        ? 'excel'
        : bankType !== 'generic' ? 'azure_parser' : 'assistant';

    console.log(`[DocumentClassifier] bank=${bankType} docType=${docType} format=${fileFormat} path=${processingPath}`);
    return { bankType, docType, fileFormat, processingPath };
}

function detectFormat(lower: string, mime: string): FileFormat {
    if (lower.endsWith('.pdf') || mime.includes('pdf')) return 'pdf';
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv')
        || mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) {
        return 'excel';
    }
    return 'pdf'; // default to PDF
}

function detectBank(lower: string): BankType {
    if (lower.includes('zempler'))                                return 'zempler';
    if (lower.includes('countingup') || lower.includes('counting-up')) return 'countingup';
    if (lower.includes('hsbc'))                                   return 'hsbc';
    if (lower.includes('revolut'))                                return 'revolut';
    if (lower.includes('monzo'))                                  return 'monzo';
    if (lower.includes('wise') || lower.includes('transferwise')) return 'wise';
    if (lower.includes('starling'))                               return 'starling';
    if (lower.includes('mettle'))                                  return 'mettle';
    if (lower.includes('halifax'))                                 return 'halifax';
    if (lower.includes('natwest') || lower.includes('nat west'))  return 'natwest';
    if (lower.includes('rbs') || lower.includes('royal bank'))    return 'rbs';
    if (lower.includes('virgin money') || lower.includes('virginmoney') || lower.includes('virgin_money')) return 'virginmoney';
    if (lower.includes('pockit'))                                  return 'pockit';
    if (lower.includes('nationwide'))                             return 'nationwide';
    if (lower.includes('santander'))                              return 'santander';
    if (lower.includes('barclaycard'))                            return 'barclaycard';
    if (lower.includes('barclays'))                               return 'barclays';
    if (lower.includes('metro'))                                  return 'metro';
    if (lower.includes('lloyds'))                                 return 'lloyds';
    if (lower.includes('tsb'))                                    return 'tsb';
    if (lower.includes('tide'))                                   return 'tide';
    if (lower.includes('anna'))                                   return 'anna';
    return 'generic';
}

/** Scan extracted document text for bank name mentions when filename gave no result. */
export function detectBankFromContent(text: string): BankType {
    const t = text.toLowerCase();
    // Check institutional bank names first — before generic brand names that appear as payees
    if (/\bzempler\b/.test(t))                                         return 'zempler';
    if (/\bcounting\s*up\b/.test(t) || t.includes('countingup'))         return 'countingup';
    // Halifax: check before NatWest — Halifax statements contain "NATWEST BANK" as a payee
    // which would otherwise trigger NatWest detection. Use footer text unique to Halifax.
    if (t.includes('halifax is a division') || (/\bhalifax\b/.test(t) && t.includes('bank of scotland'))) return 'halifax';
    // HSBC: check before NatWest — HSBC statements routinely contain "NATWEST" in ATM
    // transaction descriptions (e.g. "CASH NATWEST APR18"). Identify by BIC prefix or product name.
    if (t.includes('hbukgb') || t.includes('hsbc kinetic') || /\bhsbc\s+uk\b/.test(t)) return 'hsbc';
    // NatWest must come before Mettle — NatWest FSCS footer text mentions "mettle" as a subsidiary,
    // so a generic /\bmettle\b/ check would misidentify NatWest statements as Mettle.
    if (t.includes('nwbkgb2l') || /\bnatwest\b/.test(t) || /\bnat west\b/.test(t)) return 'natwest';
    // Mettle: require specific branding text, not just the word "mettle" which appears in other banks' FSCS disclosures.
    if (t.includes('the mettle bank account') || t.includes('mettle.co.uk')) return 'mettle';
    if (/\btide\b/.test(t))                                          return 'tide';
    // Metro Bank — must appear before santander/monzo/rbs which can appear as payees in Metro statements.
    // OCR often splits "Metro" as "M ETRO"; detect by BIC (MYMBGB2L) or domain as unique fallbacks.
    if (/m\s*etro\s+bank/i.test(t) || t.includes('mymbgb') || t.includes('metrobankonline')) return 'metro';
    // Nationwide: nationwide.co.uk and flexaccount are unique to Nationwide's own header/footer,
    // so they are checked before Santander. "nationwide building society" alone is NOT sufficient —
    // Santander statements contain "CASH WITHDRAWAL AT NATIONWIDE BUILDING SOCIETY ATM ..." in
    // transaction descriptions, which would otherwise trigger a false Nationwide match.
    if (t.includes('nationwide.co.uk') || /\bflexaccount\b/.test(t)) return 'nationwide';
    // Santander before broad "nationwide building society" — Santander ATMs appear in
    // transaction descriptions as "AT NATIONWIDE BUILDING SOCIETY ATM". Nationwide statements
    // that lack the specific header markers above will still be caught by the fallback on line 101.
    if (/\bsantander\b/.test(t))                                     return 'santander';
    if (/\bnationwide\s+building\s+society\b/.test(t))               return 'nationwide';
    // Revolut before broad bank-name sweeps — Revolut Business PDFs can contain "nationwide"
    // or "starling" in transaction descriptions (e.g. "Nationwide ATM withdrawal"), which
    // would otherwise trigger a false match for those banks further down the list.
    if (/\brevolut\b/.test(t))                                       return 'revolut';
    if (/\blloyds\s+bank\b/.test(t))                                 return 'lloyds';
    if (/\bhsbc\b/.test(t))                                          return 'hsbc';
    if (/\bmonzo\b/.test(t))                                         return 'monzo';
    if (/wise\.com\/help/.test(t) || /\bref:\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t)) return 'wise';
    if (/\bstarling\b/.test(t))                                      return 'starling';
    if (/\b(rbs|royal bank of scotland)\b/.test(t))                  return 'rbs';
    if (t.includes('internet-banking.ib.apps.virginmoney.com/vm/homepage')) return 'virginmoney';
    if (/\bpockit\b/.test(t) || /help@pockit\.com/.test(t))          return 'pockit';
    if (/\bnationwide\b/.test(t))                                    return 'nationwide';
    // Nationwide without "nationwide" in text — detected by unique footer/summary phrase
    if (t.includes('balance carried forward to next statement'))     return 'nationwide';
    if (/\bbarclaycard\b/i.test(t))                                  return 'barclaycard';
    if (/\bbarclays\b/.test(t))                                      return 'barclays';
    if (/\btsb\b/.test(t) || /203\s*284\s*1576/.test(t))            return 'tsb';
    if (/\blloyds\b/.test(t))                                        return 'lloyds';
    // ANNA Money — Payrnet is ANNA's banking institution, unique to their statements
    if (t.includes('payrnet') || /\banna\s+(?:business|money|subscription)\b/.test(t)) return 'anna';
    return 'generic';
}

function detectDocType(lower: string): DocType {
    if (lower.includes('vat') || lower.includes('invoice') || lower.includes('purchase')) return 'vat';
    return 'bank_statement';
}

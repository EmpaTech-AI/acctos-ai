export type BankType =
    | 'hsbc' | 'revolut' | 'monzo' | 'wise' | 'starling'
    | 'natwest' | 'mettle' | 'nationwide' | 'santander' | 'barclays' | 'metro'
    | 'lloyds' | 'tsb' | 'tide' | 'rbs' | 'virginmoney' | 'pockit'
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
    if (lower.includes('hsbc'))                                   return 'hsbc';
    if (lower.includes('revolut'))                                return 'revolut';
    if (lower.includes('monzo'))                                  return 'monzo';
    if (lower.includes('wise') || lower.includes('transferwise')) return 'wise';
    if (lower.includes('starling'))                               return 'starling';
    if (lower.includes('mettle'))                                  return 'mettle';
    if (lower.includes('natwest') || lower.includes('nat west'))  return 'natwest';
    if (lower.includes('rbs') || lower.includes('royal bank'))    return 'rbs';
    if (lower.includes('virgin money') || lower.includes('virginmoney') || lower.includes('virgin_money')) return 'virginmoney';
    if (lower.includes('pockit'))                                  return 'pockit';
    if (lower.includes('nationwide'))                             return 'nationwide';
    if (lower.includes('santander'))                              return 'santander';
    if (lower.includes('barclays'))                               return 'barclays';
    if (lower.includes('metro'))                                  return 'metro';
    if (lower.includes('lloyds'))                                 return 'lloyds';
    if (lower.includes('tsb'))                                    return 'tsb';
    if (lower.includes('tide'))                                   return 'tide';
    return 'generic';
}

/** Scan extracted document text for bank name mentions when filename gave no result. */
export function detectBankFromContent(text: string): BankType {
    const t = text.toLowerCase();
    // Check institutional bank names first — before generic brand names that appear as payees
    if (/\bmettle\b/.test(t) || t.includes('the mettle bank account')) return 'mettle';
    if (/\btide\b/.test(t))                                          return 'tide';
    if (/\bsantander\b/.test(t))                                     return 'santander';
    if (/\blloyds\s+bank\b/.test(t))                                 return 'lloyds';
    if (/\bhsbc\b/.test(t))                                          return 'hsbc';
    if (/\bmonzo\b/.test(t))                                         return 'monzo';
    if (/wise\.com\/help/.test(t) || /\bref:\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t)) return 'wise';
    if (/\bstarling\b/.test(t))                                      return 'starling';
    if (/\b(natwest|nat west|national westminster)\b/.test(t))       return 'natwest';
    if (/\b(rbs|royal bank of scotland)\b/.test(t))                  return 'rbs';
    if (t.includes('internet-banking.ib.apps.virginmoney.com/vm/homepage')) return 'virginmoney';
    if (/\bpockit\b/.test(t) || /help@pockit\.com/.test(t))          return 'pockit';
    if (/\bnationwide\b/.test(t))                                    return 'nationwide';
    if (/\bbarclays\b/.test(t))                                      return 'barclays';
    if (/\bmetro bank\b/.test(t))                                    return 'metro';
    if (/\btsb\b/.test(t) || /203\s*284\s*1576/.test(t))            return 'tsb';
    if (/\brevolut\b/.test(t))                                       return 'revolut';
    if (/\blloyds\b/.test(t))                                        return 'lloyds';
    return 'generic';
}

function detectDocType(lower: string): DocType {
    if (lower.includes('vat') || lower.includes('invoice') || lower.includes('purchase')) return 'vat';
    return 'bank_statement';
}

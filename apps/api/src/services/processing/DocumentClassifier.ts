export type BankType =
    | 'hsbc' | 'revolut' | 'monzo' | 'wise' | 'starling'
    | 'natwest' | 'nationwide' | 'santander' | 'barclays' | 'metro'
    | 'lloyds' | 'tsb' | 'tide'
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
    if (lower.includes('natwest') || lower.includes('nat west'))  return 'natwest';
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
    // Use word-boundary-style checks to reduce false positives
    if (/\bhsbc\b/.test(t))                                          return 'hsbc';
    if (/\brevolut\b/.test(t))                                       return 'revolut';
    if (/\bmonzo\b/.test(t))                                         return 'monzo';
    if (/\b(wise|transferwise)\b/.test(t))                           return 'wise';
    if (/\bstarling\b/.test(t))                                      return 'starling';
    if (/\b(natwest|nat west|national westminster)\b/.test(t))       return 'natwest';
    if (/\bnationwide\b/.test(t))                                    return 'nationwide';
    if (/\bsantander\b/.test(t))                                     return 'santander';
    if (/\bbarclays\b/.test(t))                                      return 'barclays';
    if (/\bmetro bank\b/.test(t))                                    return 'metro';
    if (/\blloyds\b/.test(t))                                        return 'lloyds';
    if (/\btsb\b/.test(t) || /203\s*284\s*1576/.test(t))            return 'tsb';
    if (/\btide\b/.test(t))                                          return 'tide';
    return 'generic';
}

function detectDocType(lower: string): DocType {
    if (lower.includes('vat') || lower.includes('invoice') || lower.includes('purchase')) return 'vat';
    return 'bank_statement';
}

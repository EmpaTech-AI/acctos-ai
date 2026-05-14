import { ParsedTransaction } from './parsers/shared.js';
import { CategorizedTransaction } from './AssistantCategorizer.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanField(v: unknown): string {
    return String(v ?? '')
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isEmptyAmount(v: string): boolean {
    const s = cleanField(v);
    return !s || s === '-';
}

function parseMoney(v: string): number | null {
    if (isEmptyAmount(v)) return null;
    const cleaned = cleanField(v).replace(/,/g, '').replace(/[^\d.\-]/g, '');
    if (!cleaned || cleaned === '-') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

function formatMoney(n: number): string {
    return Math.abs(n).toLocaleString('en-GB', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

const ACRONYMS = ['HMRC', 'UK', 'DVLA', 'TFL', 'VAT', 'PAYE', 'LTD', 'PLC', 'LLP', 'NHS', 'SST'];

function titleCase(str: string): string {
    let out = cleanField(str)
        .replace(/^\)+\s*/i, '')   // strip leading )))
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, c => c.toUpperCase());

    for (const a of ACRONYMS) {
        out = out.replace(new RegExp(`\\b${a}\\b`, 'gi'), a);
    }

    return out
        .replace(/\bTfl\b/g, 'TFL')
        .replace(/\bUk\b/g, 'UK')
        .replace(/\bHmrc\b/g, 'HMRC')
        .replace(/\bLtd\b/g, 'Ltd')
        .replace(/\bPlc\b/g, 'Plc')
        .trim();
}

function looksLikePersonalTransfer(desc: string): boolean {
    const d = cleanField(desc);
    return (
        /\btransfer\b/i.test(d) ||
        /\btransfer to acc\b/i.test(d) ||
        /\bmonzo\b/i.test(d) ||
        /\brevolut\b/i.test(d) ||
        /\bgift\b/i.test(d) ||
        /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/.test(titleCase(d))
    );
}

// ── Amount derivation ─────────────────────────────────────────────────────────
// Money Out / Money In columns are source of truth — description never overrides.

function deriveAmount(desc: string, moneyInRaw: string, moneyOutRaw: string): number | null {
    const descClean = cleanField(desc);
    const moneyIn  = parseMoney(moneyInRaw);
    const moneyOut = parseMoney(moneyOutRaw);

    const hasIn  = moneyIn  !== null;
    const hasOut = moneyOut !== null;

    if (hasOut && !hasIn)  return -Math.abs(moneyOut!);
    if (hasIn  && !hasOut) return  Math.abs(moneyIn!);

    if (hasIn && hasOut) {
        if (
            /^(DD|OBP|DR|ATM|\)\)\))/i.test(descClean) ||
            /\b(credit card payment|card payment|direct debit|bill payment|cash withdrawal|transfer to)\b/i.test(descClean)
        ) return -Math.abs(moneyOut!);

        if (/^(CR|PIM)/i.test(descClean)) return Math.abs(moneyIn!);

        if (Math.abs(moneyOut!) > 0) return -Math.abs(moneyOut!);
        return Math.abs(moneyIn!);
    }

    return null;
}

// ── Categorization ────────────────────────────────────────────────────────────

type Category = keyof Omit<CategorizedTransaction, 'DATE' | 'Type and Description' | 'Balance'>;

function categorize(desc: string, amount: number | null): Category | null {
    if (amount === null) return null;
    if (amount > 0) return 'INCOME';

    // Credit card payment with money out → expense, not income
    if (/\bcredit card payment\b/i.test(desc)) return 'OTHER';

    // LOAN — personal loans, mortgages, hire purchase, bank loan payments
    if (/\b(loan|mortgage|hire purchase|finance ltd)\b/i.test(desc)) return 'LOAN';
    if (/\b(lloyds|barclays|natwest|santander|halifax|hsbc)\b.*\b(loan|mortgage)\b/i.test(desc)) return 'LOAN';

    // SALARY — outgoing payroll to staff
    if (/\b(payroll|wages|staff pay|employee pay)\b/i.test(desc)) return 'SALARY';

    // HMRC — tax, VAT, PAYE, and known HMRC payment office locations
    if (/\b(hmrc|tax|vat|paye|cumbria|shipley)\b/i.test(desc)) return 'HMRC';

    // RENT — standing orders and keywords for landlords / letting agents
    if (/\b(rent|landlord|letting|tenancy|sage homes|wework|regus|housing association)\b/i.test(desc)) return 'RENT';
    // SO (Standing Order) with no other match will fall to Bank_Transfer below

    // PHONE — mobile operators incl. H3G (Three's internal HSBC code)
    if (/\b(vodafone|o2|ee|three|h3g|lebara|lycamobile|giffgaff)\b/i.test(desc)) return 'PHONE';

    // BILLS — utilities, broadband, TV, councils, energy
    if (/\b(octopus|british gas|edf|e\.on|scottish power|thames water|united utilities|anglian water|council|borough|authority|tv licence|seethelight|bt|sky|virgin media|apple\.com\/bill|gym|subscription|electric|gas bill|water bill)\b/i.test(desc))
        return 'BILLS';

    // INSURANCE — common UK insurers
    if (/\b(insurance|swiftcover|admiral|aviva|axa|direct\s*line|zurich|lv=?|saga|nfu|acorn insurance)\b/i.test(desc)) return 'INSURANCE';

    // TRAVEL — transport, fuel, parking, flights, airports, ride-hailing
    if (
        /\b(shell|esso|texaco|british petroleum|tfl|trainline|national rail|dvla|vehicle|bus|car\b|metro|subway|travel|petrol|parking|ringgo|easyjet|wizz\s*air|ryanair|british airways|ncp|q-?park|apcoa|stansted|gatwick|luton|uber|bolt|carpark|eaglemovers)\b/i.test(desc) ||
        /\bnott\s*emr\b/i.test(desc)
    ) return 'TRAVEL';

    // CHARGES — bank fees, FX, overdraft, account fees, interest
    if (/\b(bank fee|bank charge|fx fee|foreign currency conversion|monthly\s*(account)?\s*fee|overdraft\s*(fee|interest|charge)|total charges|account fee|interest charge|arranged overdraft)\b/i.test(desc)) return 'CHARGES';

    // CASH — ATM withdrawals
    if (/\b(atm|cash withdrawal|cash machine|link atm)\b/i.test(desc)) return 'CASH';

    // BANK TRANSFER — explicit codes and keywords
    if (/\bTRF\b/.test(desc)) return 'Bank_Transfer';                                          // TRF = internal HSBC transfer
    if (/^SO\b/i.test(desc)) return 'Bank_Transfer';                                           // SO (Standing Order) with no category match
    if (/^BP\b/i.test(desc) && looksLikePersonalTransfer(desc)) return 'Bank_Transfer';        // BP + personal name
    if (/\b(transfer|transfer to acc|bank transfer|faster payments.*to|bill payment to|to savings|to isa|monzo|revolut|divident|devident)\b/i.test(desc)) return 'Bank_Transfer';

    return 'OTHER';
}

// ── Main export ───────────────────────────────────────────────────────────────

export function categorizeTransactions(transactions: ParsedTransaction[]): CategorizedTransaction[] {
    return transactions.map(t => {
        const item: CategorizedTransaction = {
            DATE: t.date || '',
            'Type and Description': titleCase([t.type, t.description].filter(Boolean).join(' ')),
            INCOME: '', SALARY: '', OTHER: '', INSURANCE: '', LOAN: '',
            CASH: '', TRAVEL: '', PHONE: '', CHARGES: '', Bank_Transfer: '',
            HMRC: '', RENT: '', BILLS: '',
            Balance: t.balance || '',
        };

        const fullDesc = [t.type, t.description].filter(Boolean).join(' ');
        const amount   = deriveAmount(fullDesc, t.moneyIn, t.moneyOut);
        const category = categorize(cleanField(fullDesc), amount);

        if (category && amount !== null) {
            item[category] = formatMoney(amount);
        }

        return item;
    });
}

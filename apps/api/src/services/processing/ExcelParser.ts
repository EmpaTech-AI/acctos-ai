import * as XLSX from 'xlsx';
import { Anthropic } from '@anthropic-ai/sdk';
import { excelSerialToDate, parseDateToDDMMYYYY } from './parsers/shared.js';

export interface ExcelTransaction {
    Date: string;
    Type: string;
    'Type and Description': string;
    'Money in': string;
    'Money out': string;
    Balance: string;
}

// ── Deterministic cell helpers ────────────────────────────────────────────────

function normStr(v: any): string {
    return String(v ?? '').trim().replace(/\s+/g, ' ');
}

function colIdx(v: string | undefined): number {
    if (!v || v === '') return -1;
    const n = parseInt(v, 10);
    return isNaN(n) ? -1 : n;
}

function cellToDate(val: any): string {
    if (val == null || val === '') return '';
    if (val instanceof Date) {
        if (isNaN(val.getTime())) return '';
        const d  = String(val.getDate()).padStart(2, '0');
        const mo = String(val.getMonth() + 1).padStart(2, '0');
        return `${d}/${mo}/${val.getFullYear()}`;
    }
    if (typeof val === 'number') return excelSerialToDate(val);
    return parseDateToDDMMYYYY(String(val));
}

function cellToAmount(val: any): number {
    if (val == null || val === '') return 0;
    if (typeof val === 'number') return Math.abs(val);
    let s = String(val).trim();
    // Parentheses = negative (we always take abs here)
    s = s.replace(/^\((.+)\)$/, '$1');
    // Strip currency symbols/codes
    s = s.replace(/[£$€]/g, '').replace(/\b(GBP|USD|EUR|CHF)\b/gi, '').trim();
    // EU thousands format: 1.234,56 → 1234.56
    if (/\d{1,3}(\.\d{3})+,\d{2}$/.test(s)) {
        s = s.replace(/\./g, '').replace(',', '.');
    } else {
        s = s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    return isNaN(n) ? 0 : Math.abs(n);
}

function cellToSigned(val: any): number {
    if (val == null || val === '') return 0;
    if (typeof val === 'number') return val;
    const s = String(val).trim();
    const negative = s.startsWith('-') || /^\(.+\)$/.test(s);
    const abs = cellToAmount(val);
    return negative ? -abs : abs;
}

function cellToBalance(val: any): string {
    if (val == null || val === '') return '';
    if (typeof val === 'number') return val.toFixed(2);
    const s = String(val).trim();
    const isOD = /\b(OD|DR)\b/i.test(s);
    const cleaned = s.replace(/\b(OD|DR)\b/gi, '').trim();
    const n = cellToAmount(cleaned);
    if (!n) return '';
    return isOD ? (-n).toFixed(2) : n.toFixed(2);
}

const SKIP_ROW_RE = /\b(opening\s+balance|closing\s+balance|balance\s+b[\/]d|balance\s+c[\/]d|brought\s+forward|carried\s+forward|b\/f\b|c\/f\b|total\b|sub[\-\s]?total)\b/i;

function extractDeterministic(rawRows: any[][], schemaMap: Record<string, string>): ExcelTransaction[] {
    const dateCol   = colIdx(schemaMap['Transaction Date']);
    const descCol   = colIdx(schemaMap['Transaction Description']);
    const typeCol   = colIdx(schemaMap['Transaction Type']);
    const creditCol = colIdx(schemaMap['Credit Amount']);
    const debitCol  = colIdx(schemaMap['Debit Amount']);
    const signedCol = colIdx(schemaMap['Signed Amount']);
    const balCol    = colIdx(schemaMap['Balance']);

    if (dateCol < 0) return [];

    // Find header row: first row where dateCol value is a text label, not a real date
    let startRow = 0;
    for (let i = 0; i < Math.min(10, rawRows.length); i++) {
        const v = normStr(rawRows[i][dateCol] ?? '');
        if (/^(date|transaction[\s_]date|booking[\s_]date|value[\s_]date|дата)/i.test(v)) {
            startRow = i + 1;
            break;
        }
    }

    const result: ExcelTransaction[] = [];

    for (let i = startRow; i < rawRows.length; i++) {
        const row = rawRows[i];

        const date = cellToDate(row[dateCol]);
        if (!date) continue;

        const desc = descCol >= 0 ? normStr(row[descCol]) : '';
        const type = typeCol >= 0 ? normStr(row[typeCol]) : '';

        if (SKIP_ROW_RE.test(desc) || SKIP_ROW_RE.test(type)) continue;

        let moneyIn  = '';
        let moneyOut = '';

        if (creditCol >= 0 || debitCol >= 0) {
            const credit = creditCol >= 0 ? cellToAmount(row[creditCol]) : 0;
            const debit  = debitCol  >= 0 ? cellToAmount(row[debitCol])  : 0;
            if (credit > 0) moneyIn  = credit.toFixed(2);
            if (debit  > 0) moneyOut = debit.toFixed(2);
        } else if (signedCol >= 0) {
            const signed = cellToSigned(row[signedCol]);
            if (signed > 0) moneyIn  = signed.toFixed(2);
            if (signed < 0) moneyOut = Math.abs(signed).toFixed(2);
        }

        if (!moneyIn && !moneyOut) continue;

        const balance    = balCol >= 0 ? cellToBalance(row[balCol]) : '';
        const typeAndDesc = (type && desc && !desc.toLowerCase().startsWith(type.toLowerCase()))
            ? `${type} ${desc}`.trim()
            : (desc || type);

        result.push({
            Date: date,
            Type: type,
            'Type and Description': typeAndDesc,
            'Money in':  moneyIn,
            'Money out': moneyOut,
            Balance: balance,
        });
    }

    return result;
}

// Phase 1: Schema detection — identify which column maps to which canonical field
const SCHEMA_DETECTION_PROMPT = `You are a bank statement column header detector. Analyze the provided spreadsheet rows and return a JSON object identifying which column index (0-based) maps to each canonical field.

Canonical fields and synonyms:
- "Transaction Date": Date, Booking Date, Value Date, Transaction Date, Дата, Entry Date, Processing Date, Post Date, Settlement Date, Trade Date, Invoice Date, Inv.Date, Дата на фактура
- "Transaction Description": Description, Details, Narrative, Memo, Explanation, Particolari, Reference, Remarks, Particulars, Transaction Details, Payment Details, Beneficiary, Counterparty, Дата описание
- "Transaction Type": Type, Code, Reference, Entry Type, Inv.No, Transaction Type, Category, Payment Type, Ttype, Ref, Doc No, Document Number
- "Credit Amount": Credit, Deposit, Paid In, Money In, Credit Amount, Received, Amount In, Additions, CR, In, Incoming, Plus, Кредит
- "Debit Amount": Debit, Withdrawal, Paid Out, Money Out, Debit Amount, Sent, Amount Out, DR, Out, Outgoing, Minus, Дебит, Charges
- "Balance": Balance, Closing Balance, Running Balance, Available Balance, End Balance, Ledger Balance, Account Balance, Салдо
- "Signed Amount": Amount, Net Amount, Transaction Amount, Value, Sum, Net, Turnover, Сума

Priority rules:
- Return column index as a string, or "" if not found
- Only ONE date column, ONE description column
- If two columns both look like dates, prefer the one labeled "Transaction Date" or "Date" over "Value Date" or "Booking Date"
- If BOTH Credit/Debit AND Signed Amount columns exist, ALWAYS prefer Credit/Debit pair; set "Signed Amount": ""
- If only one amount column exists (no separate credit/debit), use "Signed Amount" for it
- Never map the same column index to two canonical fields
- "Balance" column is usually the rightmost numeric column
- For VAT/invoice sheets: "Inv.Date" → Transaction Date, "Explanation" → Transaction Description, "Inv.No" → Transaction Type, "Gross Amount" → Debit Amount — ignore Net Amount and VAT Amount columns
- If a sheet has "Total Amount" and "Amount" columns, prefer "Total Amount" for the amount field
- Return ONLY valid JSON, no markdown, no explanations

Output format:
{
  "Transaction Date": "0",
  "Transaction Description": "1",
  "Transaction Type": "",
  "Credit Amount": "3",
  "Debit Amount": "4",
  "Balance": "5",
  "Signed Amount": ""
}`;


let openAIQuotaExhausted = false;
const CLAUDE_FALLBACK_MODEL = 'claude-sonnet-5';
const MAX_RETRIES = 4;

async function callClaude(systemPrompt: string, userContent: string): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('OpenAI quota exhausted and ANTHROPIC_API_KEY is not set — cannot fall back to Claude');
    console.warn(`[ExcelParser] Falling back to Claude (${CLAUDE_FALLBACK_MODEL}) for schema detection`);
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
        model: CLAUDE_FALLBACK_MODEL,
        max_tokens: 1024,
        system: systemPrompt + '\n\nReturn ONLY valid JSON with no markdown or code fences.',
        messages: [{ role: 'user', content: userContent }],
    });
    const text = message.content[0].type === 'text' ? message.content[0].text : '';
    return text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
}

async function callOpenAI(systemPrompt: string, userContent: string, jsonMode: boolean, attempt = 0): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || openAIQuotaExhausted) return callClaude(systemPrompt, userContent);

    const model = process.env.OPENAI_MODEL_EXTRACT || 'gpt-4o';
    const body: any = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        if (res.status === 429) {
            const errBody = await res.clone().json().catch(() => ({})) as any;
            if (errBody?.error?.code === 'insufficient_quota') {
                openAIQuotaExhausted = true;
            } else if (attempt < 1) {
                // One short retry for transient rate limits, then fall back to Claude
                const retryAfter = Number(res.headers.get('retry-after') || '0');
                const waitMs = retryAfter > 0 ? retryAfter * 1000 : 5000;
                console.warn(`[ExcelParser] OpenAI 429 — retrying in ${Math.round(waitMs / 1000)}s...`);
                await new Promise(r => setTimeout(r, waitMs));
                return callOpenAI(systemPrompt, userContent, jsonMode, 1);
            }
            // Quota exhausted or retries used up → fall back to Claude immediately
            return callClaude(systemPrompt, userContent);
        }
        if (res.status >= 500 && attempt < 2) {
            const waitMs = 3000 * (attempt + 1);
            console.warn(`[ExcelParser] OpenAI ${res.status} — retrying after ${waitMs / 1000}s...`);
            await new Promise(r => setTimeout(r, waitMs));
            return callOpenAI(systemPrompt, userContent, jsonMode, attempt + 1);
        }
        // For other errors fall back to Claude rather than crash
        console.warn(`[ExcelParser] OpenAI error ${res.status} — falling back to Claude`);
        return callClaude(systemPrompt, userContent);
    }

    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content?.trim() || '';
}

function rowsToText(rows: any[][]): string {
    return rows.map((row, i) => {
        const cols = row.map((cell, j) => {
            let val = cell ?? '';
            // Annotate Excel serial dates so the model knows to apply the 1899-12-30 base conversion
            if (typeof val === 'number' && val > 25000 && val < 60000) {
                val = `${val} (serial)`;
            }
            return `col${j}: ${val}`;
        }).join(', ');
        return `row${i + 1}: ${cols}`;
    }).join('\n');
}

export async function parseExcel(fileBuffer: Buffer): Promise<ExcelTransaction[]> {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: '',
        raw: true,
    }) as any[][];

    if (rawRows.length === 0) return [];

    // Phase 1: LLM schema detection on first 20 rows (1 API call)
    const first20Text = rowsToText(rawRows.slice(0, 20));
    const schemaRaw = await callOpenAI(SCHEMA_DETECTION_PROMPT, first20Text, true);

    let schemaMap: Record<string, string> = {};
    try {
        schemaMap = JSON.parse(schemaRaw);
        const hasDate   = schemaMap['Transaction Date'] !== '';
        const hasAmount = schemaMap['Credit Amount'] !== '' ||
                          schemaMap['Debit Amount']  !== '' ||
                          schemaMap['Signed Amount'] !== '';
        if (!hasDate || !hasAmount) {
            console.warn('[ExcelParser] Schema detection found no date or amount columns:', schemaMap);
            return [];
        }
    } catch {
        console.warn('[ExcelParser] Schema detection returned invalid JSON');
        return [];
    }

    // Phase 2: deterministic row extraction — no LLM, no batching, no dropped rows
    return extractDeterministic(rawRows, schemaMap);
}

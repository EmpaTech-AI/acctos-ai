// AI-powered fallback parser for unrecognised banks.
// Sends the first rows of cells to Claude Haiku to detect column mappings,
// then extracts transactions using those canonical column indices.
import {
    Cell, ParsedTransaction, ParseResult,
    normStr, parseMoney, formatMoney, parseDateToDDMMYYYY,
    buildGrid, getCell, maxRow,
} from './shared.js';

interface ColumnMapping {
    canonical_to_index: {
        'Transaction Date'?: string;
        'Transaction Description'?: string;
        'Transaction Type'?: string;
        'Credit Amount'?: string;
        'Debit Amount'?: string;
        'Balance'?: string;
    };
    source_header_row: Record<string, string>;
}

const DETECTION_SYSTEM = `You are a bank statement column detector. Analyse the cell data provided and return ONLY a JSON object — no extra text, no code fences.

Output format:
{
  "canonical_to_index": {
    "Transaction Date": "<column index as string, or empty string>",
    "Transaction Description": "<column index as string, or empty string>",
    "Transaction Type": "<column index as string, or empty string>",
    "Credit Amount": "<column index as string, or empty string>",
    "Debit Amount": "<column index as string, or empty string>",
    "Balance": "<column index as string, or empty string>"
  },
  "source_header_row": {
    "0": "<raw header value or empty string>",
    "1": "...",
    ...
  }
}

Rules:
- Canonical names EXACTLY as shown above.
- Priority mappings: Date → Transaction Date; Details / Description / Narration / Memo → Transaction Description; In / Credit / Money in → Credit Amount; Out / Debit / Money out → Debit Amount.
- If a header row exists in the data (lowest rowIndex row whose cells match ≥3 known keywords), map from it. Recognised keywords: Date, Transaction Date, Type, Transaction Type, Description, Details, Narration, Memo, In, Out, Credit, Debit, Money in, Money out, Balance.
- If NO header row is present, auto-map by column count:
    6 columns (indices 0-5): Transaction Date, Transaction Type, Transaction Description, Credit Amount, Debit Amount, Balance
    5 columns (indices 0-4): Transaction Date, Transaction Type, Transaction Description, Debit Amount, Balance (Credit Amount → "")
- source_header_row: return raw original values if a header row was found; otherwise use placeholder labels DATE / TYPE / TRANSACTION / IN / OUT / BALANCE.
- All missing canonical fields → empty string "".`;

async function detectColumns(sampleCells: Cell[]): Promise<ColumnMapping | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    const text = sampleCells
        .map(c => `rowIndex: ${c.rowIndex}, columnIndex: ${c.columnIndex}, content: ${c.content}`)
        .join(';');

    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 512,
                system: DETECTION_SYSTEM,
                messages: [{ role: 'user', content: text }],
            }),
        });

        if (!res.ok) {
            console.warn('[Fallback] Claude API error:', res.status, await res.text());
            return null;
        }

        const data = await res.json() as any;
        const raw: string = data.content?.[0]?.text ?? '';
        const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        return JSON.parse(cleaned) as ColumnMapping;
    } catch (err: any) {
        console.warn('[Fallback] Header detection failed:', err?.message ?? err);
        return null;
    }
}

function toIdx(s: string | undefined): number {
    if (!s) return -1;
    const n = parseInt(s, 10);
    return isNaN(n) ? -1 : n;
}

export async function parse(cells: Cell[]): Promise<ParseResult> {
    if (cells.length === 0) return { transactions: [] };

    const grid = buildGrid(cells);
    const rows = maxRow(cells);

    // Send first 10 data rows (excluding synthetic context cell at rowIndex -1) to Claude
    const sampleCells = cells.filter(c => c.rowIndex >= 0 && c.rowIndex <= 10);
    const mapping = await detectColumns(sampleCells);

    if (!mapping) {
        console.warn('[Fallback] No column mapping returned by Claude');
        return { transactions: [] };
    }

    console.log('[Fallback] Column mapping:', JSON.stringify(mapping.canonical_to_index));

    const ci = mapping.canonical_to_index;
    const dateIdx = toIdx(ci['Transaction Date']);
    const descIdx = toIdx(ci['Transaction Description']);
    const typeIdx = toIdx(ci['Transaction Type']);
    const inIdx   = toIdx(ci['Credit Amount']);
    const outIdx  = toIdx(ci['Debit Amount']);
    const balIdx  = toIdx(ci['Balance']);

    if (dateIdx < 0) {
        console.warn('[Fallback] Could not determine date column — aborting');
        return { transactions: [] };
    }

    // Skip row 0 if a real header row was detected
    const hasHeader = Object.values(mapping.source_header_row).some(v => v !== '');
    const startRow = hasHeader ? 1 : 0;

    const transactions: ParsedTransaction[] = [];

    for (let r = startRow; r <= rows; r++) {
        const rawDate = getCell(grid, r, dateIdx);
        if (!rawDate) continue;
        const date = parseDateToDDMMYYYY(rawDate);
        if (!date) continue;

        const description = descIdx >= 0 ? normStr(getCell(grid, r, descIdx)) : '';
        const type        = typeIdx >= 0 ? normStr(getCell(grid, r, typeIdx)) : '';
        const inAmt       = inIdx  >= 0  ? parseMoney(getCell(grid, r, inIdx))  : null;
        const outAmt      = outIdx >= 0  ? parseMoney(getCell(grid, r, outIdx)) : null;
        const balAmt      = balIdx >= 0  ? parseMoney(getCell(grid, r, balIdx)) : null;

        const moneyIn  = inAmt  !== null && inAmt  > 0 ? formatMoney(inAmt)  : '';
        const moneyOut = outAmt !== null && outAmt > 0 ? formatMoney(outAmt) : '';
        const balance  = balAmt !== null ? formatMoney(balAmt) : '';

        if (!moneyIn && !moneyOut) continue;

        transactions.push({ date, type, description, moneyIn, moneyOut, balance });
    }

    return { transactions };
}

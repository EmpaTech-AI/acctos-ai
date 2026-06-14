import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ParsedTransaction, formatTransactionsForAssistant } from './parsers/shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const SYSTEM_PROMPT = readFileSync(
    join(__dirname, '../../prompts/transaction-categorizer-system.txt'),
    'utf8'
);

export interface CategorizedTransaction {
    DATE: string;
    'Type and Description': string;
    INCOME: string;
    SALARY: string;
    OTHER: string;
    INSURANCE: string;
    LOAN: string;
    CASH: string;
    TRAVEL: string;
    PHONE: string;
    CHARGES: string;
    Bank_Transfer: string;
    HMRC: string;
    RENT: string;
    BILLS: string;
    Balance: string;
}

const EXPENSE_CATS = ['INCOME','SALARY','OTHER','INSURANCE','LOAN','CASH','TRAVEL','PHONE','CHARGES','Bank_Transfer','HMRC','RENT','BILLS'];

function parseMoney(s: string): number | null {
    if (!s) return null;
    const n = Number(String(s).replace(/,/g, '').trim());
    return isFinite(n) ? n : null;
}

function fmt(n: number): string {
    const abs = Math.abs(n);
    const [int, dec] = abs.toFixed(2).split('.');
    return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

/** Remove duplicate amounts across expense columns (AI sometimes puts the same amount in OTHER + Bank_Transfer etc.) */
function deduplicateExpenseColumns(row: CategorizedTransaction): void {
    const expOnly = ['SALARY','OTHER','INSURANCE','LOAN','CASH','TRAVEL','PHONE','CHARGES','Bank_Transfer','HMRC','RENT','BILLS'];
    const byAbs = new Map<number, string[]>();
    for (const key of expOnly) {
        const v = parseMoney((row as any)[key]);
        if (v !== null && v !== 0) {
            const abs = Math.abs(v);
            if (!byAbs.has(abs)) byAbs.set(abs, []);
            byAbs.get(abs)!.push(key);
        }
    }
    for (const [, cols] of byAbs) {
        if (cols.length <= 1) continue;
        const keepIdx = cols.findIndex(c => c !== 'OTHER');
        const keepCol = keepIdx >= 0 ? cols[keepIdx] : cols[0];
        for (const col of cols) {
            if (col !== keepCol) (row as any)[col] = '';
        }
    }
}

function applyFallbackToRow(row: CategorizedTransaction, src: any): void {
    const filledCount = EXPENSE_CATS.filter(k => ((row as any)[k] || '').trim() !== '').length;
    if (filledCount === 0) {
        const moneyOut = parseMoney(src['Money out']);
        const moneyIn  = parseMoney(src['Money in']);
        if (moneyOut !== null && moneyOut > 0) (row as any).OTHER = '-' + fmt(moneyOut);
        else if (moneyIn !== null && moneyIn > 0) (row as any).INCOME = fmt(moneyIn);
    }
}

function buildFallbackRow(src: any): CategorizedTransaction {
    const row = {} as CategorizedTransaction;
    row.DATE = src['Date'] || '';
    row['Type and Description'] = src['Description'] || '';
    row.Balance = src['Balance'] || '';
    for (const k of EXPENSE_CATS) (row as any)[k] = '';
    applyFallbackToRow(row, src);
    return row;
}

/**
 * Apply fallback categorization and fix two known AI failure modes:
 *  1. AI returns fewer items than the batch (skipped transactions) — realign by balance key
 *  2. AI puts the same amount in multiple expense columns — deduplicate
 *
 * IMPORTANT: when realigning, consume each matched row from catByKey so two
 * transactions with identical Date+Balance keys never share the same object.
 * Object aliasing would cause enforcement to overwrite it twice and
 * catIn/catOut to double-count it.
 */
function applyFallback(items: CategorizedTransaction[], rawTransactions: object[]): CategorizedTransaction[] {
    if (items.length === rawTransactions.length) {
        for (let i = 0; i < items.length; i++) {
            const src = rawTransactions[i] as any;
            const typeAndDesc = src['Description'] || '';
            if (typeAndDesc) items[i]['Type and Description'] = typeAndDesc;
            applyFallbackToRow(items[i], src);
            deduplicateExpenseColumns(items[i]);
        }
        return items;
    }

    console.warn(`[Categorizer] Item count mismatch: got ${items.length}, expected ${rawTransactions.length}. Re-aligning by balance key.`);
    const catByKey = new Map<string, CategorizedTransaction>();
    for (const item of items) {
        const key = `${item.DATE}|${item.Balance ?? ''}`;
        if (!catByKey.has(key)) catByKey.set(key, item);
    }

    return rawTransactions.map((src_: any) => {
        const key = `${src_['Date']}|${src_['Balance'] ?? ''}`;
        const matched = catByKey.get(key);
        if (matched) catByKey.delete(key);  // consume — prevents aliasing when multiple rows share the same key
        const row = matched ? { ...matched } : buildFallbackRow(src_);  // shallow-clone to ensure unique object
        const typeAndDesc = src_['Description'] || '';
        if (typeAndDesc) row['Type and Description'] = typeAndDesc;
        applyFallbackToRow(row, src_);
        deduplicateExpenseColumns(row);
        return row;
    });
}

const BATCH_SIZE = 25;
const MODEL      = 'gpt-4o-mini';

async function fetchCompletion(batch: object[], apiKey: string, attempt = 0): Promise<Response> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: MODEL, temperature: 0, max_tokens: 16384,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user',   content: JSON.stringify(batch) },
            ],
        }),
    });
    // Retry once on transient 5xx (e.g. Cloudflare 520 in front of OpenAI)
    if (!res.ok && res.status >= 500 && attempt === 0) {
        console.warn(`[Categorizer] OpenAI ${res.status} — retrying after 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        return fetchCompletion(batch, apiKey, 1);
    }
    return res;
}

async function categorizeBatch(batch: object[], apiKey: string): Promise<CategorizedTransaction[]> {
    const res = await fetchCompletion(batch, apiKey);

    if (!res.ok) {
        throw new Error(`OpenAI API error ${res.status}`);
    }

    const data         = await res.json() as any;
    const finishReason = data.choices?.[0]?.finish_reason;
    const usage        = data.usage;
    if (finishReason === 'length') {
        throw new Error('OpenAI response truncated (finish_reason=length) — batch too large for max_tokens');
    }
    const content = data.choices?.[0]?.message?.content || '';
    const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

    let parsed: any;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        throw new Error('OpenAI returned invalid JSON: ' + cleaned.slice(0, 300));
    }

    let items: CategorizedTransaction[] = Array.isArray(parsed) ? parsed : (parsed.items || []);
    if (items.length === 0 && batch.length > 0) {
        console.warn(`[Categorizer] Empty response — finish_reason=${finishReason} tokens=${JSON.stringify(usage)} content_len=${cleaned.length} first_tx=${JSON.stringify(batch[0]).slice(0, 100)}`);
    }

    // If GPT dropped items, retry the whole batch once before falling to realignment.
    // Realignment uses a Date|Balance key — many transactions share the same key when
    // Balance is empty, leading to object aliasing and double-counted catIn/catOut.
    if (items.length !== batch.length) {
        console.warn(`[Categorizer] Count mismatch (got ${items.length}, expected ${batch.length}) — retrying batch...`);
        try {
            const retryRes = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: MODEL, temperature: 0, max_tokens: 16384,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user',   content: JSON.stringify(batch) },
                    ],
                }),
            });
            if (retryRes.ok) {
                const retryData = await retryRes.json() as any;
                if (retryData.choices?.[0]?.finish_reason !== 'length') {
                    const retryContent = (retryData.choices?.[0]?.message?.content || '')
                        .replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
                    try {
                        const retryParsed = JSON.parse(retryContent);
                        const retryItems: CategorizedTransaction[] = Array.isArray(retryParsed) ? retryParsed : (retryParsed.items || []);
                        if (retryItems.length === batch.length) {
                            console.log(`[Categorizer] Batch retry succeeded — correct count.`);
                            items = retryItems;
                        } else {
                            console.warn(`[Categorizer] Retry still wrong count (${retryItems.length}), falling back to realignment.`);
                        }
                    } catch { /* keep original items */ }
                }
            }
        } catch { /* keep original items */ }
    }

    return applyFallback(items, batch);
}

export async function categorize(transactions: ParsedTransaction[]): Promise<CategorizedTransaction[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const inputArray   = formatTransactionsForAssistant(transactions);
    const totalBatches = Math.ceil(inputArray.length / BATCH_SIZE);

    const batches: object[][] = [];
    for (let i = 0; i < inputArray.length; i += BATCH_SIZE) {
        batches.push(inputArray.slice(i, i + BATCH_SIZE));
    }

    console.log(`[Categorizer] Running ${totalBatches} batch(es) in parallel — ${inputArray.length} transactions total`);

    const batchResults = await Promise.all(
        batches.map((batch, idx) => {
            console.log(`[Categorizer] Batch ${idx + 1}/${totalBatches} started — ${batch.length} transactions`);
            return categorizeBatch(batch, apiKey).then(result => {
                console.log(`[Categorizer] Batch ${idx + 1}/${totalBatches} done`);
                return result;
            });
        })
    );

    const results = batchResults.flat();

    // ── Post-categorization direction reconciliation ──────────────────────────
    // Compare AI results against parser-confirmed direction and fix mismatches.
    const autoFixedIn: number[] = [];
    const retryOutIndices: number[] = [];

    for (let i = 0; i < results.length; i++) {
        const t   = transactions[i];
        const row = results[i];
        const moneyIn  = parseMoney(t.moneyIn  || '');
        const moneyOut = parseMoney(t.moneyOut || '');

        if (moneyIn !== null && moneyIn > 0 && parseMoney(row.INCOME) === null) {
            // Parser says IN but AI put it in an expense column — auto-fix to INCOME
            const hasExpenseAmt = EXPENSE_CATS.filter(k => k !== 'INCOME')
                .some(k => parseMoney((row as any)[k]) !== null);
            if (hasExpenseAmt) {
                for (const k of EXPENSE_CATS) if (k !== 'INCOME') (row as any)[k] = '';
                row.INCOME = fmt(moneyIn);
                autoFixedIn.push(i);
            }
        }

        if (moneyOut !== null && moneyOut > 0 && parseMoney(row.INCOME) !== null) {
            // Parser says OUT but AI classified as INCOME — retry with explicit instruction
            retryOutIndices.push(i);
        }
    }

    if (autoFixedIn.length > 0) {
        console.log(`[Categorizer] Auto-fixed ${autoFixedIn.length} IN transaction(s) misclassified as expense.`);
    }

    if (retryOutIndices.length > 0) {
        console.log(`[Categorizer] Retrying ${retryOutIndices.length} OUT transaction(s) misclassified as INCOME...`);
        const retryInput = retryOutIndices.map(i => ({
            ...formatTransactionsForAssistant([transactions[i]])[0],
            '_note': 'OUTGOING PAYMENT — Money out. This is an expense. Do NOT put in INCOME. Choose the correct expense category.',
        }));

        // Split retry into same-sized batches to avoid truncation
        const retryBatches: object[][] = [];
        for (let i = 0; i < retryInput.length; i += BATCH_SIZE) {
            retryBatches.push(retryInput.slice(i, i + BATCH_SIZE));
        }
        const retryResults = await Promise.all(retryBatches.map(b => categorizeBatch(b, apiKey)));
        const retried = retryResults.flat();

        for (let j = 0; j < retryOutIndices.length; j++) {
            const i   = retryOutIndices[j];
            const row = retried[j];
            if (!row) continue;

            const moneyOut = parseMoney(transactions[i].moneyOut || '');
            if (parseMoney(row.INCOME) !== null) {
                // Retry still misclassified — force to OTHER as last resort
                row.INCOME = '';
                if (!row.OTHER && moneyOut !== null) row.OTHER = '-' + fmt(moneyOut);
                console.warn(`[Categorizer] "${transactions[i].description}" still misclassified after retry — forced to OTHER.`);
            }
            results[i] = row;
        }
    }

    // ── Enforce parser amounts ────────────────────────────────────────────────
    // AI chooses the category; parser owns the amount. Overwrite every row's
    // amount with the exact value from the parser so category totals always match.
    const EXP_ONLY = ['SALARY','OTHER','INSURANCE','LOAN','CASH','TRAVEL','PHONE','CHARGES','Bank_Transfer','HMRC','RENT','BILLS'] as const;

    for (let i = 0; i < results.length; i++) {
        const t   = transactions[i];
        const row = results[i];
        const moneyIn  = parseMoney(t.moneyIn  || '');
        const moneyOut = parseMoney(t.moneyOut || '');

        if (moneyIn !== null && moneyIn > 0) {
            row.INCOME = fmt(moneyIn);
            for (const k of EXP_ONLY) (row as any)[k] = '';
        } else if (moneyOut !== null && moneyOut > 0) {
            row.INCOME = '';
            const filled = EXP_ONLY.filter(k => parseMoney((row as any)[k]) !== null);
            const target = filled.find(k => k !== 'OTHER') ?? filled[0] ?? 'OTHER';
            for (const k of EXP_ONLY) (row as any)[k] = '';
            (row as any)[target] = '-' + fmt(moneyOut);
        } else {
            // Parser found no amount — clear any AI-hallucinated values
            row.INCOME = '';
            for (const k of EXP_ONLY) (row as any)[k] = '';
        }
    }

    // Post-enforcement sanity check — catIn/catOut must equal parser totals exactly.
    // Any remaining diff indicates a bug (e.g. aliased objects, null results).
    let postIn = 0, postOut = 0;
    for (const row of results) {
        const inc = parseMoney(row.INCOME);
        if (inc !== null && inc > 0) postIn += inc;
        for (const k of EXP_ONLY) {
            const v = parseMoney((row as any)[k]);
            if (v !== null && v !== 0) postOut += Math.abs(v);
        }
    }
    const expIn  = transactions.reduce((s, t) => s + (parseMoney(t.moneyIn  || '') ?? 0), 0);
    const expOut = transactions.reduce((s, t) => s + (parseMoney(t.moneyOut || '') ?? 0), 0);
    if (Math.abs(postIn - expIn) > 0.05 || Math.abs(postOut - expOut) > 0.05) {
        console.error(
            `[Categorizer] POST-ENFORCEMENT MISMATCH — ` +
            `catIn=${postIn.toFixed(2)} (expected ${expIn.toFixed(2)}, diff ${(postIn - expIn).toFixed(2)}), ` +
            `catOut=${postOut.toFixed(2)} (expected ${expOut.toFixed(2)}, diff ${(postOut - expOut).toFixed(2)})`
        );
    } else {
        console.log(`[Categorizer] Enforcement verified — catIn=${postIn.toFixed(2)} catOut=${postOut.toFixed(2)} ✓`);
    }

    return results;
}

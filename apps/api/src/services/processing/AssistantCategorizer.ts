import { ParsedTransaction, formatTransactionsForAssistant } from './parsers/shared.js';

const ASSISTANT_ID = 'asst_7WxK9GBeMrs86TmeBmtqfsC7';

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
        // Keep the most specific (first non-OTHER), clear the rest
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
    row['Type and Description'] = `${src['Type'] || ''} ${src['Description'] || ''}`.trim();
    row.Balance = src['Balance'] || '';
    for (const k of EXPENSE_CATS) (row as any)[k] = '';
    applyFallbackToRow(row, src);
    return row;
}

/**
 * Apply fallback categorization and fix two known AI failure modes:
 *  1. AI returns fewer items than the batch (skipped transactions) — realign by balance key
 *  2. AI puts the same amount in multiple expense columns — deduplicate
 */
function applyFallback(items: CategorizedTransaction[], rawTransactions: object[]): CategorizedTransaction[] {
    // Fast path: counts match, align positionally
    if (items.length === rawTransactions.length) {
        for (let i = 0; i < items.length; i++) {
            const src = rawTransactions[i] as any;
            applyFallbackToRow(items[i], src);
            deduplicateExpenseColumns(items[i]);
        }
        return items;
    }

    // Counts differ: realign by (date|balance|amount) key so skipped transactions get fallback rows
    console.warn(`[Categorizer] Item count mismatch: got ${items.length}, expected ${rawTransactions.length}. Re-aligning by balance key.`);
    const catByKey = new Map<string, CategorizedTransaction>();
    for (const item of items) {
        const key = `${item.DATE}|${item.Balance ?? ''}`;
        if (!catByKey.has(key)) catByKey.set(key, item);
    }

    return rawTransactions.map((src_: any) => {
        const key = `${src_['Date']}|${src_['Balance'] ?? ''}`;
        const row = catByKey.get(key) ?? buildFallbackRow(src_);
        applyFallbackToRow(row, src_);
        deduplicateExpenseColumns(row);
        return row;
    });
}

async function pollRun(threadId: string, runId: string, apiKey: string, timeoutMs = 420000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 1500));
        const res = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
            headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'assistants=v2' },
        });
        const run = await res.json() as any;
        if (run.status === 'completed') return;
        if (['failed','cancelled','expired'].includes(run.status)) {
            throw new Error(`Assistant run ${run.status}: ${run.last_error?.message || 'unknown'}`);
        }
    }
    throw new Error(`Assistant run timed out after ${timeoutMs}ms`);
}

const BATCH_SIZE = 50;

async function categorizeBatch(batch: object[], apiKey: string): Promise<CategorizedTransaction[]> {
    // Create thread
    const threadRes = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'OpenAI-Beta': 'assistants=v2' },
        body: JSON.stringify({}),
    });
    const thread = await threadRes.json() as any;
    if (!thread.id) throw new Error('Failed to create thread: ' + JSON.stringify(thread));

    try {
        // Add message
        await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'OpenAI-Beta': 'assistants=v2' },
            body: JSON.stringify({ role: 'user', content: JSON.stringify(batch) }),
        });

        // Run
        const runRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'OpenAI-Beta': 'assistants=v2' },
            body: JSON.stringify({ assistant_id: ASSISTANT_ID }),
        });
        const run = await runRes.json() as any;
        if (!run.id) throw new Error('Failed to create run: ' + JSON.stringify(run));

        await pollRun(thread.id, run.id, apiKey);

        // Get messages
        const msgsRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
            headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'assistants=v2' },
        });
        const msgs = await msgsRes.json() as any;
        const assistantMsg = msgs.data?.find((m: any) => m.role === 'assistant');
        if (!assistantMsg) throw new Error('No assistant response received');

        const content = assistantMsg.content[0]?.text?.value || '';
        const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

        let parsed: any;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            throw new Error('Assistant returned invalid JSON: ' + cleaned.slice(0, 300));
        }

        const items: CategorizedTransaction[] = Array.isArray(parsed) ? parsed : (parsed.items || []);
        return applyFallback(items, batch);

    } finally {
        fetch(`https://api.openai.com/v1/threads/${thread.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'assistants=v2' },
        }).catch(() => {});
    }
}

export async function categorize(transactions: ParsedTransaction[]): Promise<CategorizedTransaction[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const inputArray = formatTransactionsForAssistant(transactions);
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

    return batchResults.flat();
}

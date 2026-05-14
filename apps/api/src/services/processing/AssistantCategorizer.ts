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

/** Apply fallback categorization when the assistant leaves all categories empty */
function applyFallback(items: CategorizedTransaction[], rawTransactions: object[]): CategorizedTransaction[] {
    return items.map((row, i) => {
        const src = (rawTransactions[i] || {}) as any;
        const filledCount = EXPENSE_CATS.filter(k => ((row as any)[k] || '').trim() !== '').length;
        if (filledCount === 0) {
            const moneyOut = parseMoney(src['Money out']);
            const moneyIn  = parseMoney(src['Money in']);
            if (moneyOut !== null && moneyOut > 0) (row as any).OTHER = '-' + fmt(moneyOut);
            else if (moneyIn !== null && moneyIn > 0) (row as any).INCOME = fmt(moneyIn);
        }
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
    const results: CategorizedTransaction[] = [];

    for (let i = 0; i < inputArray.length; i += BATCH_SIZE) {
        const batch = inputArray.slice(i, i + BATCH_SIZE);
        console.log(`[Categorizer] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(inputArray.length / BATCH_SIZE)} — ${batch.length} transactions`);
        const batchResults = await categorizeBatch(batch, apiKey);
        results.push(...batchResults);
    }

    return results;
}

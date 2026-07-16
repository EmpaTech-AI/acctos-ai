import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Supabase Realtime requires WebSocket. Node.js < 22 has no native WebSocket,
// so we polyfill with 'ws' if available. No-ops silently if 'ws' isn't installed.
if (typeof globalThis.WebSocket === 'undefined') {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        (globalThis as any).WebSocket = (await import('ws')).default;
    } catch { /* ws not installed — Realtime features will be unavailable */ }
}
import type { PageData } from './processing/AzureExtractor.js';

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
    if (_client) return _client;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
        console.warn('[Supabase] getClient: missing env vars — SUPABASE_URL:', !!url, 'SUPABASE_SERVICE_KEY:', !!key);
        return null;
    }
    // Warn if anon key is used instead of service_role (anon keys are shorter)
    if (key.length < 200) console.warn('[Supabase] WARNING: SUPABASE_SERVICE_KEY looks like an anon key — Storage uploads will fail without proper RLS policies');
    _client = createClient(url, key);
    return _client;
}

const BUCKET = 'processed-files';

// ── Azure DI cache ────────────────────────────────────────────────────────────

export async function getAzureCache(fileHash: string): Promise<Array<PageData | null> | null> {
    const sb = getClient();
    if (!sb) return null;
    try {
        const { data, error } = await sb
            .from('azure_di_cache')
            .select('pages')
            .eq('file_hash', fileHash)
            .single();
        if (error || !data) return null;
        return data.pages as Array<PageData | null>;
    } catch {
        return null;
    }
}

export async function saveAzureCache(
    fileHash: string,
    filename: string,
    pages: Array<PageData | null>,
): Promise<void> {
    const sb = getClient();
    if (!sb) return;
    try {
        await sb.from('azure_di_cache').upsert(
            { file_hash: fileHash, filename, pages },
            { onConflict: 'file_hash', ignoreDuplicates: true },
        );
    } catch (err: any) {
        console.warn('[Supabase] Azure cache save failed:', err?.message);
    }
}

// ── Job persistence ───────────────────────────────────────────────────────────

export async function createJobRecord(params: {
    id: string;
    filename: string;
    processingMode?: string;
}): Promise<void> {
    const sb = getClient();
    if (!sb) return;
    try {
        await sb.from('processing_jobs').insert({
            id: params.id,
            filename: params.filename,
            processing_mode: params.processingMode ?? 'bank_statement',
            status: 'queued',
        });
    } catch (err: any) {
        console.warn('[Supabase] createJobRecord failed:', err?.message);
    }
}

export async function updateJobRecord(
    id: string,
    patch: Partial<{
        status: string;
        bank_type: string;
        transaction_count: number;
        error: string;
        error_type: string;
        output_path: string;
        completed_at: string;
        summary: Record<string, unknown>;
    }>,
): Promise<void> {
    const sb = getClient();
    if (!sb) return;
    try {
        const { error } = await sb.from('processing_jobs').update(patch).eq('id', id);
        if (error) throw error;
    } catch (err: any) {
        // If the update fails because the summary column doesn't exist yet,
        // retry without summary so status/completed_at are always persisted.
        if (patch.summary !== undefined && err?.message?.toLowerCase().includes('summary')) {
            console.warn('[Supabase] updateJobRecord: summary column missing — retrying without summary');
            const { summary: _s, ...patchWithoutSummary } = patch;
            try {
                await sb.from('processing_jobs').update(patchWithoutSummary).eq('id', id);
            } catch (e2: any) {
                console.warn('[Supabase] updateJobRecord (no summary) failed:', e2?.message);
            }
        } else {
            console.warn('[Supabase] updateJobRecord failed:', err?.message);
        }
    }
}

export async function saveOutputFile(jobId: string, buffer: Buffer): Promise<string | null> {
    const sb = getClient();
    if (!sb) { console.warn('[Supabase] saveOutputFile: no client — skipping storage save'); return null; }
    try {
        const path = `${jobId}.xlsx`;
        console.log(`[Supabase] saveOutputFile: uploading ${buffer.length} bytes → ${BUCKET}/${path}`);
        const { error } = await sb.storage.from(BUCKET).upload(path, buffer, {
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            upsert: true,
        });
        if (error) {
            console.warn('[Supabase] saveOutputFile upload error:', error.message, '| status:', (error as any).statusCode);
            return null;
        }
        console.log(`[Supabase] saveOutputFile: upload OK → ${path}`);
        return path;
    } catch (err: any) {
        console.warn('[Supabase] saveOutputFile failed:', err?.message);
        return null;
    }
}

export async function downloadOutputFile(outputPath: string): Promise<Buffer | null> {
    const sb = getClient();
    if (!sb) return null;
    try {
        const { data, error } = await sb.storage.from(BUCKET).download(outputPath);
        if (error || !data) return null;
        return Buffer.from(await data.arrayBuffer());
    } catch {
        return null;
    }
}

export async function getJobRecord(jobId: string): Promise<Record<string, any> | null> {
    const sb = getClient();
    if (!sb) return null;
    try {
        const { data, error } = await sb
            .from('processing_jobs')
            .select('*')
            .eq('id', jobId)
            .single();
        if (error || !data) return null;
        return data;
    } catch {
        return null;
    }
}

export interface VendorRule {
    pattern:    string;
    match_type: 'exact' | 'contains' | 'starts_with';
    category:   string;
}

export async function loadVendorCategories(): Promise<VendorRule[]> {
    const sb = getClient();
    if (!sb) return [];
    try {
        const { data, error } = await sb
            .from('vendor_categories')
            .select('pattern, match_type, category')
            .eq('active', true)
            .order('id', { ascending: true });
        if (error || !data) return [];
        return data as VendorRule[];
    } catch {
        return [];
    }
}

export async function saveAiVendorRule(pattern: string, category: string): Promise<void> {
    const sb = getClient();
    if (!sb) return;
    try {
        await sb.from('vendor_categories').insert({
            pattern,
            match_type: 'contains',
            category,
            source: 'ai',
        });
    } catch {
        // ignore — duplicate or constraint violation is expected and fine
    }
}

export async function listJobRecords(): Promise<Array<Record<string, any>>> {
    const sb = getClient();
    if (!sb) return [];
    try {
        const { data, error } = await sb
            .from('processing_jobs')
            .select('id, filename, bank_type, processing_mode, status, transaction_count, completed_at, created_at, output_path, summary')
            .order('created_at', { ascending: false })
            .limit(100);
        if (error || !data) return [];
        return data;
    } catch {
        return [];
    }
}

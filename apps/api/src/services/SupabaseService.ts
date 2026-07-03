import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { PageData } from './processing/AzureExtractor.js';

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
    if (_client) return _client;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) return null;
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
        await sb.from('processing_jobs').update(patch).eq('id', id);
    } catch (err: any) {
        console.warn('[Supabase] updateJobRecord failed:', err?.message);
    }
}

export async function saveOutputFile(jobId: string, buffer: Buffer): Promise<string | null> {
    const sb = getClient();
    if (!sb) return null;
    try {
        const path = `${jobId}.xlsx`;
        const { error } = await sb.storage.from(BUCKET).upload(path, buffer, {
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            upsert: true,
        });
        if (error) {
            console.warn('[Supabase] saveOutputFile upload error:', error.message);
            return null;
        }
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

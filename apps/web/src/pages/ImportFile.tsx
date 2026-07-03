import React, { useState, useRef, useEffect, useCallback, Fragment } from 'react';
import axios from 'axios';
import {
    Upload, FileSearch, Layers, AlignLeft, Sparkles, FileSpreadsheet,
    Loader2, CheckCircle2, XCircle, Download, FileUp, Eye, X, Clock,
} from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

// ── Types ────────────────────────────────────────────────────────────────────

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';
type StageKey = 'upload' | 'classify' | 'extract' | 'parse' | 'categorize' | 'output';
type StageState = 'idle' | 'active' | 'completed' | 'failed';

interface JobSummary {
    moneyIn?:          number;
    moneyOut?:         number;
    openingBalance?:   number | null;
    closingBalance?:   number | null;
    balanceOk?:        boolean;
    declaredIn?:       number;
    declaredOut?:      number;
    declaredOk?:       boolean;
    catTotalIn?:       number;
    catTotalOut?:      number;
    catOk?:            boolean;
    vatTotal?:         number;
    vatSalesCount?:    number;
    vatSalesTotal?:    number;
    vatExpensesCount?: number;
    vatExpensesTotal?: number;
}

interface Job {
    id: string;
    status: JobStatus;
    currentStage?: string;
    filename: string;
    bankType?: string;
    transactionCount?: number;
    pageCount?: number;
    currentFile?: number;
    totalFiles?: number;
    error?: string;
    summary?: JobSummary | null;
}

interface RecentJob {
    id: string;
    filename: string;
    completedAt: string;
    transactionCount?: number;
    summary?: JobSummary | null;
}

const LS_ACTIVE_KEY = 'acctos_active_job';

// ── Pipeline stage definitions ───────────────────────────────────────────────

const STAGES: { key: StageKey; label: string; Icon: React.FC<{ size: number; color: string }> }[] = [
    { key: 'upload',     label: 'Upload',     Icon: Upload as any },
    { key: 'classify',   label: 'Classify',   Icon: FileSearch as any },
    { key: 'extract',    label: 'Extract',    Icon: Layers as any },
    { key: 'parse',      label: 'Parse',      Icon: AlignLeft as any },
    { key: 'categorize', label: 'Categorize', Icon: Sparkles as any },
    { key: 'output',     label: 'Output',     Icon: FileSpreadsheet as any },
];

const SERVER_STAGES: StageKey[] = ['classify', 'extract', 'parse', 'categorize', 'output'];

function computeStates(isUploading: boolean, job: Job | null): Record<StageKey, StageState> {
    const s: Record<StageKey, StageState> = {
        upload: 'idle', classify: 'idle', extract: 'idle',
        parse: 'idle', categorize: 'idle', output: 'idle',
    };

    if (isUploading) { s.upload = 'active'; return s; }
    if (!job) return s;

    s.upload = 'completed';

    if (job.status === 'completed') {
        SERVER_STAGES.forEach(k => { s[k] = 'completed'; });
        return s;
    }

    // currentStage is only present in in-memory job responses (from active container).
    // Supabase fallback responses have no currentStage — in that case don't highlight
    // any specific stage so CLASSIFY doesn't falsely appear stuck/spinning.
    const currentIdx = job.currentStage
        ? Math.max(0, SERVER_STAGES.indexOf(job.currentStage as StageKey))
        : -1;

    SERVER_STAGES.forEach((k, i) => {
        if (currentIdx < 0) {
            s[k] = 'idle'; // no stage info — show upload done, all server stages idle
        } else if (job.status === 'failed') {
            s[k] = i < currentIdx ? 'completed' : i === currentIdx ? 'failed' : 'idle';
        } else {
            s[k] = i < currentIdx ? 'completed' : i === currentIdx ? 'active' : 'idle';
        }
    });

    return s;
}

// ── StageNode component ──────────────────────────────────────────────────────

interface StageNodeProps {
    stage: typeof STAGES[0];
    state: StageState;
    error?: string;
    isLast: boolean;
    lineCompleted: boolean;
}

function StageNode({ stage, state, error, isLast, lineCompleted }: StageNodeProps) {
    const [hovered, setHovered] = useState(false);
    const { Icon } = stage;

    const palette = {
        idle:      { bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.1)',  icon: 'rgba(255,255,255,0.2)',  label: 'rgba(255,255,255,0.22)' },
        active:    { bg: 'rgba(99,102,241,0.14)',  border: '#6366f1',                icon: '#6366f1',                label: 'var(--text-muted)' },
        completed: { bg: 'rgba(34,197,94,0.1)',    border: '#22c55e',               icon: '#22c55e',                label: 'var(--text-muted)' },
        failed:    { bg: 'rgba(239,68,68,0.1)',    border: '#ef4444',               icon: '#ef4444',                label: '#ef4444' },
    }[state];

    const showTooltip = hovered && state === 'failed' && !!error;

    return (
        <Fragment>
            <div
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 68, position: 'relative' }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            >
                {showTooltip && (
                    <div style={{
                        position: 'fixed', bottom: 'auto', top: 'auto',
                        left: '50%', transform: 'translate(-50%, -8px)',
                        background: 'rgba(10,10,16,0.97)',
                        border: '1px solid rgba(239,68,68,0.4)',
                        color: '#fca5a5', padding: '0.75rem 1rem', borderRadius: '0.6rem',
                        fontSize: '0.82rem', lineHeight: 1.55, whiteSpace: 'pre-wrap',
                        width: 'max-content', maxWidth: '480px', wordBreak: 'break-word',
                        zIndex: 9999, pointerEvents: 'none', textAlign: 'left',
                        boxShadow: '0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(239,68,68,0.15)',
                    }}>
                        <div style={{ fontWeight: 700, marginBottom: '0.3rem', color: '#ef4444', fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            Processing error
                        </div>
                        {error}
                    </div>
                )}

                <div style={{ height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {state === 'active'    && <Loader2 size={16} color="#6366f1" style={{ animation: 'spin 1s linear infinite' }} />}
                    {state === 'completed' && <CheckCircle2 size={16} color="#22c55e" />}
                    {state === 'failed'    && <XCircle size={16} color="#ef4444" />}
                </div>

                <div style={{
                    width: 52, height: 52, borderRadius: '50%',
                    background: palette.bg, border: `2px solid ${palette.border}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all 0.4s ease',
                    boxShadow: state === 'active' ? `0 0 0 4px ${palette.border}20, 0 0 16px ${palette.border}40` : 'none',
                    cursor: state === 'failed' ? 'help' : 'default',
                }}>
                    <Icon size={20} color={palette.icon} />
                </div>

                <span style={{
                    marginTop: '0.45rem', fontSize: '0.68rem', fontWeight: 600,
                    letterSpacing: '0.02em', color: palette.label,
                    textAlign: 'center', transition: 'color 0.4s', textTransform: 'uppercase',
                }}>
                    {stage.label}
                </span>
            </div>

            {!isLast && (
                <div style={{
                    flex: 1, height: 2, minWidth: 12, marginTop: 52,
                    background: lineCompleted ? 'linear-gradient(90deg, #22c55e, #22c55e)' : 'rgba(255,255,255,0.08)',
                    transition: 'background 0.5s ease', borderRadius: 1,
                }} />
            )}
        </Fragment>
    );
}

// ── Preview Modal ────────────────────────────────────────────────────────────

interface PreviewModalProps {
    jobId: string;
    filename: string;
    onClose: () => void;
    onDownload: () => void;
}

function PreviewModal({ jobId, filename, onClose, onDownload }: PreviewModalProps) {
    const [sheets, setSheets] = useState<{ name: string; rows: unknown[][] }[]>([]);
    const [activeSheet, setActiveSheet] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setActiveSheet(0);
        setSheets([]);
        setLoading(true);
        setError(null);
        axios.get(`/v1/processing/${jobId}/preview`)
            .then(res => setSheets(res.data.sheets as { name: string; rows: unknown[][] }[]))
            .catch(() => setError('Could not load preview.'))
            .finally(() => setLoading(false));
    }, [jobId]);

    const currentSheet = sheets[activeSheet];
    const headers = currentSheet?.rows[0] as string[] | undefined;
    const dataRows = currentSheet?.rows.slice(1) ?? [];

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '1.5rem',
        }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div style={{
                background: 'var(--surface, #1a1a2e)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '1.25rem',
                width: '100%', maxWidth: 900,
                maxHeight: '85vh',
                display: 'flex', flexDirection: 'column',
                boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
            }}>
                {/* Modal header */}
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '1.1rem 1.4rem',
                    borderBottom: sheets.length > 1 ? 'none' : '1px solid rgba(255,255,255,0.07)',
                    flexShrink: 0,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                        <FileSpreadsheet size={18} color="#22c55e" />
                        <span style={{ fontWeight: 600, fontSize: '0.92rem' }}>
                            {filename.replace(/\.[^.]+$/, '')}_processed.xlsx
                        </span>
                        {dataRows.length > 0 && (
                            <span style={{
                                fontSize: '0.72rem', color: 'var(--text-muted)',
                                background: 'rgba(255,255,255,0.06)',
                                padding: '0.2rem 0.55rem', borderRadius: '99px',
                            }}>
                                {dataRows.length} rows
                            </span>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <button className="btn-success" onClick={onDownload} style={{ padding: '0.45rem 0.9rem', fontSize: '0.8rem' }}>
                            <Download size={14} /> Download
                        </button>
                        <button onClick={onClose} style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: 'var(--text-muted)', padding: '0.3rem', borderRadius: '0.4rem',
                            display: 'flex', alignItems: 'center',
                        }}>
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* Sheet tabs — only shown for multi-sheet files (VAT) */}
                {sheets.length > 1 && (
                    <div style={{
                        display: 'flex', gap: '0.25rem',
                        padding: '0 1.4rem',
                        borderBottom: '1px solid rgba(255,255,255,0.07)',
                        flexShrink: 0,
                    }}>
                        {sheets.map((s, i) => (
                            <button key={i} onClick={() => setActiveSheet(i)} style={{
                                background: i === activeSheet ? 'rgba(34,197,94,0.12)' : 'none',
                                border: 'none',
                                borderBottom: i === activeSheet ? '2px solid #22c55e' : '2px solid transparent',
                                color: i === activeSheet ? '#22c55e' : 'var(--text-muted)',
                                fontSize: '0.78rem',
                                fontWeight: i === activeSheet ? 600 : 400,
                                padding: '0.5rem 0.85rem',
                                cursor: 'pointer',
                                borderRadius: '0',
                                transition: 'color 0.15s, border-color 0.15s',
                            }}>
                                {s.name}
                            </button>
                        ))}
                    </div>
                )}

                {/* Modal body */}
                <div style={{ overflowY: 'auto', overflowX: 'auto', flex: 1, padding: '0' }}>
                    {loading && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3rem', gap: '0.6rem', color: 'var(--text-muted)' }}>
                            <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
                            Loading preview…
                        </div>
                    )}
                    {error && (
                        <div style={{ padding: '2rem', textAlign: 'center', color: '#ef4444', fontSize: '0.88rem' }}>{error}</div>
                    )}
                    {!loading && !error && headers && (
                        <div>
                            <table style={{
                                width: '100%', borderCollapse: 'collapse',
                                fontSize: '0.78rem', tableLayout: 'auto',
                            }}>
                                <thead>
                                    <tr>
                                        {headers.map((h, i) => (
                                            <th key={i} style={{
                                                padding: '0.6rem 0.9rem',
                                                textAlign: 'left', fontWeight: 700,
                                                fontSize: '0.7rem', letterSpacing: '0.04em',
                                                textTransform: 'uppercase',
                                                color: 'var(--text-muted)',
                                                background: 'rgba(255,255,255,0.04)',
                                                borderBottom: '1px solid rgba(255,255,255,0.08)',
                                                whiteSpace: 'nowrap',
                                                position: 'sticky', top: 0, zIndex: 1,
                                            }}>
                                                {h as string}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {dataRows.map((row, ri) => (
                                        <tr key={ri} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                            {(row as unknown[]).map((cell, ci) => (
                                                <td key={ci} style={{
                                                    padding: '0.5rem 0.9rem',
                                                    color: String(cell) ? 'var(--text)' : 'var(--text-muted)',
                                                    whiteSpace: 'nowrap',
                                                    maxWidth: 260,
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                }}>
                                                    {String(cell ?? '')}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
    return new Date(iso).toLocaleString('en-GB', {
        timeZone: 'Europe/London',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        hour12: false,
    }) + ' (UK)';
}

interface ActiveJob { id: string; filename: string; }

function saveActiveJob(id: string, filename: string) {
    localStorage.setItem(LS_ACTIVE_KEY, JSON.stringify({ id, filename }));
}
function loadActiveJob(): ActiveJob | null {
    try { return JSON.parse(localStorage.getItem(LS_ACTIVE_KEY) || 'null'); } catch { return null; }
}
function clearActiveJob() { localStorage.removeItem(LS_ACTIVE_KEY); }

// ── Summary components ────────────────────────────────────────────────────────

const fmt = (n: number) => '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ok  = { color: '#22c55e' } as const;
const err = { color: '#f87171' } as const;

function SummaryPanel({ summary: s }: { summary: JobSummary }) {
    const rows: Array<[string, React.ReactNode]> = [];
    if (s.openingBalance != null) rows.push(['Opening balance', <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(s.openingBalance)}</span>]);
    if (s.moneyIn  != null) rows.push(['Money in',  <span style={ok}>{fmt(s.moneyIn)}</span>]);
    if (s.moneyOut != null) rows.push(['Money out', <span style={{ color: '#f97316' }}>{fmt(s.moneyOut)}</span>]);
    if (s.closingBalance != null) rows.push(['Closing balance', <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(s.closingBalance)}</span>]);
    if (s.balanceOk != null) rows.push(['Balance check', <span style={s.balanceOk ? ok : err}>{s.balanceOk ? '✓ OK' : '⚠ Mismatch'}</span>]);
    if (s.declaredIn != null) {
        rows.push(['Declared in',  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(s.declaredIn)}</span>]);
        rows.push(['Declared out', <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(s.declaredOut ?? 0)}</span>]);
        rows.push(['Declared totals', <span style={s.declaredOk ? ok : err}>{s.declaredOk ? '✓ Match' : '⚠ Mismatch'}</span>]);
    }
    if (s.catTotalIn != null) {
        rows.push(['Categorized in',  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(s.catTotalIn)}</span>]);
        rows.push(['Categorized out', <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(s.catTotalOut ?? 0)}</span>]);
        rows.push(['Category totals', <span style={s.catOk ? ok : err}>{s.catOk ? '✓ Match' : '⚠ Mismatch'}</span>]);
    }
    if (s.vatSalesCount    != null) rows.push(['Sales',    <span>{s.vatSalesCount} entries · {fmt(s.vatSalesTotal ?? 0)}</span>]);
    if (s.vatExpensesCount != null) rows.push(['Expenses', <span>{s.vatExpensesCount} entries · {fmt(s.vatExpensesTotal ?? 0)}</span>]);
    if (!rows.length) return null;
    return (
        <div style={{
            marginTop: '0.75rem', padding: '0.65rem 0.85rem',
            background: 'rgba(255,255,255,0.04)', borderRadius: '0.6rem',
            border: '1px solid rgba(255,255,255,0.08)', display: 'grid',
            gridTemplateColumns: 'auto 1fr', gap: '0.15rem 1rem', alignItems: 'center',
        }}>
            {rows.map(([label, val]) => (
                <Fragment key={label}>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{label}</span>
                    <span style={{ fontSize: '0.72rem', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{val}</span>
                </Fragment>
            ))}
        </div>
    );
}

function SummaryInline({ summary: s }: { summary: JobSummary }) {
    const parts: string[] = [];
    if (s.moneyIn  != null) parts.push(`In ${fmt(s.moneyIn)}`);
    if (s.moneyOut != null) parts.push(`Out ${fmt(s.moneyOut)}`);
    if (s.vatSalesCount != null) parts.push(`${s.vatSalesCount} sales · ${s.vatExpensesCount} expenses`);
    const allOk = [s.balanceOk, s.declaredOk, s.catOk].filter(v => v != null);
    const anyFail = allOk.some(v => !v);
    const checkStr = allOk.length ? (anyFail ? '⚠ Check mismatch' : '✓ Verified') : null;
    return (
        <div style={{ fontSize: '0.7rem', marginTop: '0.2rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {parts.map(p => <span key={p} style={{ color: 'var(--text-muted)' }}>{p}</span>)}
            {checkStr && <span style={anyFail ? err : ok}>{checkStr}</span>}
        </div>
    );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ImportFile() {
    const { t } = useLanguage();
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [job, setJob] = useState<Job | null>(null);
    const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
    const [previewJobId, setPreviewJobId] = useState<string | null>(null);
    const [previewFilename, setPreviewFilename] = useState('');
    const [processingMode, setProcessingMode] = useState<'bank_statement' | 'vat'>('bank_statement');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const pollRef   = useRef<ReturnType<typeof setInterval> | null>(null);
    const bgPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const jobRef    = useRef<Job | null>(null);

    // Load job history from Supabase on mount; also resume any in-progress job
    useEffect(() => {
        axios.get('/v1/processing').then(res => {
            const jobs: Array<Record<string, any>> = res.data.jobs ?? [];
            setRecentJobs(
                jobs
                    .filter((j: any) => j.status === 'completed' && j.output_path)
                    .map((j: any) => ({
                        id: j.id,
                        filename: j.filename,
                        completedAt: j.completed_at ?? j.created_at,
                        transactionCount: j.transaction_count,
                        summary: j.summary ?? null,
                    }))
            );
        }).catch(() => {});

        // Resume polling if a job was in-flight when the user navigated away
        const active = loadActiveJob();
        if (active) {
            axios.get(`/v1/processing/${active.id}`)
                .then(res => {
                    const j: Job = { id: active.id, filename: active.filename, ...res.data.job };
                    setJob(j);
                    if (j.status === 'completed') {
                        clearActiveJob();
                        addToRecent(j);
                    } else if (j.status === 'failed') {
                        clearActiveJob();
                    } else {
                        startPolling(active.id);
                    }
                })
                .catch(() => clearActiveJob());
        }
    }, []);

    // Keep jobRef current so the visibility handler always sees the latest job
    useEffect(() => { jobRef.current = job; }, [job]);

    // When the user returns to the tab, immediately poll instead of waiting for
    // the next interval tick (which may have been throttled while hidden)
    useEffect(() => {
        const handleVisibility = () => {
            const j = jobRef.current;
            if (document.hidden || !j || (j.status !== 'queued' && j.status !== 'processing')) return;
            axios.get(`/v1/processing/${j.id}`)
                .then(res => {
                    const updated: Job = { id: j.id, filename: j.filename, ...res.data.job };
                    setJob(updated);
                    if (updated.status === 'completed' || updated.status === 'failed') {
                        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
                        clearActiveJob();
                        if (updated.status === 'completed') addToRecent(updated);
                    } else if (!pollRef.current) {
                        startPolling(j.id);
                    }
                })
                .catch(() => {});
        };
        document.addEventListener('visibilitychange', handleVisibility);
        return () => document.removeEventListener('visibilitychange', handleVisibility);
    }, []);

    useEffect(() => () => {
        if (pollRef.current)   clearInterval(pollRef.current);
        if (bgPollRef.current) clearInterval(bgPollRef.current);
    }, []);

    // Background poll every 10s — picks up Gmail-triggered jobs automatically
    useEffect(() => {
        bgPollRef.current = setInterval(async () => {
            const currentJob = jobRef.current;
            if (currentJob?.status === 'queued' || currentJob?.status === 'processing') return;
            try {
                const res = await axios.get('/v1/processing');
                const jobs: Array<Record<string, any>> = res.data.jobs ?? [];
                const inProgress = jobs.find((j: any) => j.status === 'queued' || j.status === 'processing');
                if (inProgress) {
                    const picked: Job = {
                        id:               inProgress.id,
                        filename:         inProgress.filename,
                        status:           inProgress.status,
                        currentStage:     inProgress.current_stage,
                        bankType:         inProgress.bank_type,
                        transactionCount: inProgress.transaction_count,
                    };
                    setJob(picked);
                    startPolling(picked.id);
                } else {
                    setRecentJobs(
                        jobs
                            .filter((j: any) => j.status === 'completed' && j.output_path)
                            .map((j: any) => ({
                                id:               j.id,
                                filename:         j.filename,
                                completedAt:      j.completed_at ?? j.created_at,
                                transactionCount: j.transaction_count,
                                summary:          j.summary ?? null,
                            }))
                    );
                }
            } catch { /* ignore */ }
        }, 10000);
        return () => { if (bgPollRef.current) clearInterval(bgPollRef.current); };
    }, []);

    const addToRecent = useCallback((j: Job) => {
        setRecentJobs(prev => {
            const entry: RecentJob = {
                id: j.id,
                filename: j.filename,
                completedAt: new Date().toISOString(),
                transactionCount: j.transactionCount,
                summary: j.summary,
            };
            const filtered = prev.filter(r => r.id !== j.id);
            return [entry, ...filtered];
        });
    }, []);

    const reset = () => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        clearActiveJob();
        setJob(null);
        setUploadProgress(0);
        setUploadError(null);
        setSelectedFiles([]);
    };

    const handleFileSelect = (files: FileList | null) => {
        if (!files || files.length === 0) return;
        reset();
        setSelectedFiles(Array.from(files));
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);
        handleFileSelect(e.dataTransfer.files);
    };

    const handleDownload = async (jobId: string, filename: string) => {
        try {
            const res = await axios.get(`/v1/processing/${jobId}/download`, { responseType: 'blob' });
            const url = URL.createObjectURL(res.data);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename.replace(/\.[^.]+$/, '') + '_processed.xlsx';
            a.click();
            URL.revokeObjectURL(url);
        } catch {
            alert('Download failed. Please try again.');
        }
    };

    const startPolling = (jobId: string) => {
        if (pollRef.current) clearInterval(pollRef.current);
        // Fast poll (500ms) for the first 10s to catch quick cache-hit jobs,
        // then slow down to 2s for longer-running jobs.
        let ticks = 0;
        const FAST_TICKS = 20; // 20 × 500ms = 10s
        const poll = async () => {
            try {
                const res = await axios.get(`/v1/processing/${jobId}`);
                const j: Job = { id: jobId, ...res.data.job };
                setJob(j);
                if (j.status === 'completed' || j.status === 'failed') {
                    clearInterval(pollRef.current!);
                    pollRef.current = null;
                    clearActiveJob();
                    if (j.status === 'completed') addToRecent(j);
                    return;
                }
            } catch { /* ignore transient errors */ }
            ticks++;
            if (ticks === FAST_TICKS) {
                // Switch from fast to slow polling
                clearInterval(pollRef.current!);
                pollRef.current = setInterval(poll, 2000);
            }
        };
        pollRef.current = setInterval(poll, 500);
    };

    const handleUpload = async () => {
        if (selectedFiles.length === 0) return;
        reset();
        setIsUploading(true);

        const formData = new FormData();
        for (const f of selectedFiles) formData.append('files', f);

        const batchName = selectedFiles.length === 1
            ? selectedFiles[0].name
            : `${selectedFiles.length} files`;

        try {
            const res = await axios.post(`/v1/users/import?processingMode=${processingMode}`, formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                onUploadProgress: (e) => {
                    if (e.total) setUploadProgress(Math.round((e.loaded * 100) / e.total));
                },
            });
            setUploadProgress(100);
            const jobId: string = res.data.jobId;
            saveActiveJob(jobId, batchName);
            setJob({ id: jobId, status: 'queued', filename: batchName });
            setSelectedFiles([]);
            if (fileInputRef.current) fileInputRef.current.value = '';
            startPolling(jobId);
        } catch (err: any) {
            setUploadError(err.response?.data?.error?.message || t.uploadFailed);
        } finally {
            setIsUploading(false);
        }
    };

    const stageStates = computeStates(isUploading, job);
    const isProcessing = job && (job.status === 'queued' || job.status === 'processing');
    const isCompleted  = job?.status === 'completed';
    const isFailed     = job?.status === 'failed';
    const canUpload    = selectedFiles.length > 0 && !isUploading && !isProcessing;

    return (
        <div>
            <div style={{ marginBottom: '1.5rem' }}>
                <h2>{t.navImport}</h2>
            </div>

            <div className="card" style={{ maxWidth: 620 }}>

                {/* ── Header ── */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
                    <div style={{
                        width: 40, height: 40, borderRadius: '0.75rem',
                        background: 'rgba(99,102,241,0.15)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        <FileUp size={20} color="#6366f1" />
                    </div>
                    <div>
                        <p style={{ margin: 0, fontWeight: 600, fontSize: '0.95rem' }}>
                            {processingMode === 'vat' ? 'VAT Processor' : 'Bank Statement Processor'}
                        </p>
                        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                            {processingMode === 'vat'
                                ? 'Upload a PDF bank statement to populate the VAT Sales & Expenses template'
                                : 'Upload a PDF or Excel bank statement to extract and categorize transactions'}
                        </p>
                    </div>
                </div>

                {/* ── Mode selector ── */}
                {!isProcessing && !isCompleted && (
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
                        {([
                            { key: 'bank_statement', label: 'Bank Statement' },
                            { key: 'vat',            label: 'VAT' },
                        ] as const).map(({ key, label }) => {
                            const active = processingMode === key;
                            return (
                                <button
                                    key={key}
                                    onClick={() => setProcessingMode(key)}
                                    style={{
                                        flex: 1,
                                        padding: '0.5rem 0.75rem',
                                        borderRadius: '0.5rem',
                                        border: active ? '1.5px solid #6366f1' : '1.5px solid rgba(255,255,255,0.1)',
                                        background: active ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                                        color: active ? '#a5b4fc' : 'var(--text-muted)',
                                        fontWeight: active ? 600 : 400,
                                        fontSize: '0.85rem',
                                        cursor: 'pointer',
                                        transition: 'all 0.2s',
                                    }}
                                >
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* ── Pipeline visualization ── */}
                <div style={{
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.07)',
                    borderRadius: '1rem', padding: '1.25rem 1rem 1rem', marginBottom: '1.5rem',
                }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', width: '100%' }}>
                        {STAGES.map((stage, i) => (
                            <StageNode
                                key={stage.key}
                                stage={stage}
                                state={stageStates[stage.key]}
                                error={job?.error}
                                isLast={i === STAGES.length - 1}
                                lineCompleted={stageStates[stage.key] === 'completed'}
                            />
                        ))}
                    </div>

                    <div style={{ marginTop: '1rem', textAlign: 'center', minHeight: 20 }}>
                        {!job && !isUploading && (
                            <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.2)' }}>
                                Select a file below to begin
                            </span>
                        )}
                        {isUploading && (
                            <span style={{ fontSize: '0.75rem', color: '#6366f1' }}>
                                Uploading… {uploadProgress}%
                            </span>
                        )}
                        {isProcessing && (
                            <span style={{ fontSize: '0.75rem', color: '#6366f1' }}>
                                {job.totalFiles && job.totalFiles > 1
                                    ? `File ${job.currentFile || 1} of ${job.totalFiles}${job.bankType ? ` · ${job.bankType.toUpperCase()}` : ''}${job.currentStage ? ` · ${job.currentStage}` : ''}`
                                    : job.bankType
                                        ? `Processing ${job.bankType.toUpperCase()} statement${job.pageCount ? ` · ${job.pageCount} pages` : ''}`
                                        : 'Processing…'
                                }
                            </span>
                        )}
                        {isCompleted && (
                            <div>
                                <span style={{ fontSize: '0.75rem', color: '#22c55e', fontWeight: 600 }}>
                                    ✓ Complete — {job.transactionCount} transactions extracted
                                </span>
                                {job.summary && <SummaryPanel summary={job.summary} />}
                            </div>
                        )}
                        {isFailed && (
                            <span style={{ fontSize: '0.75rem', color: '#ef4444' }}>
                                {job.currentStage
                                    ? `Failed at the ${job.currentStage.charAt(0).toUpperCase() + job.currentStage.slice(1)} stage`
                                    : 'Processing failed'
                                } — hover the red icon for more details
                            </span>
                        )}
                    </div>
                </div>

                {/* ── Drop zone ── */}
                {!isProcessing && !isCompleted && (
                    <div
                        className={`drop-zone${isDragging ? ' dragging' : ''}${selectedFiles.length > 0 ? ' has-file' : ''}`}
                        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                        onDragLeave={() => setIsDragging(false)}
                        onDrop={handleDrop}
                        onClick={() => !isUploading && fileInputRef.current?.click()}
                    >
                        <Upload size={26} style={{ marginBottom: '0.6rem', opacity: 0.5 }} />
                        {selectedFiles.length === 0 && (
                            <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '0.88rem' }}>{t.dragDropFile}</p>
                        )}
                        {selectedFiles.length === 1 && (
                            <p style={{ fontWeight: 600, color: 'var(--text)', margin: 0 }}>{selectedFiles[0].name}</p>
                        )}
                        {selectedFiles.length > 1 && (
                            <div style={{ textAlign: 'center' }}>
                                <p style={{ fontWeight: 600, color: 'var(--text)', margin: '0 0 0.4rem' }}>
                                    {selectedFiles.length} files selected
                                </p>
                                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', maxHeight: 80, overflowY: 'auto' }}>
                                    {selectedFiles.map((f, i) => <div key={i}>{f.name}</div>)}
                                </div>
                            </div>
                        )}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".pdf,.xlsx,.xls,.csv"
                            multiple
                            style={{ display: 'none' }}
                            onChange={(e) => handleFileSelect(e.target.files)}
                        />
                    </div>
                )}

                {/* ── Upload progress bar ── */}
                {isUploading && (
                    <div style={{ marginTop: '1rem' }}>
                        <div className="progress-track">
                            <div className="progress-fill" style={{ width: `${uploadProgress}%` }} />
                        </div>
                    </div>
                )}

                {/* ── Upload error ── */}
                {uploadError && (
                    <div style={{
                        marginTop: '1rem', padding: '0.75rem 1rem',
                        background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
                        borderRadius: '0.5rem', color: '#ef4444', fontSize: '0.85rem',
                    }}>
                        {uploadError}
                    </div>
                )}

                {/* ── Action buttons ── */}
                <div style={{ marginTop: '1.25rem', display: 'flex', gap: '0.75rem' }}>
                    {(isCompleted || isFailed) && (
                        <button className="btn-secondary" onClick={() => { reset(); }} style={{ flex: 1, justifyContent: 'center' }}>
                            Upload another file
                        </button>
                    )}

                    {isCompleted && (
                        <>
                            <button
                                className="btn-secondary"
                                onClick={() => { setPreviewFilename(job!.filename); setPreviewJobId(job!.id); }}
                                style={{ flex: 1, justifyContent: 'center' }}
                            >
                                <Eye size={16} /> Preview
                            </button>
                            <button
                                className="btn-success"
                                onClick={() => handleDownload(job!.id, job!.filename)}
                                style={{ flex: 1, justifyContent: 'center' }}
                            >
                                <Download size={16} /> {t.download}
                            </button>
                        </>
                    )}

                    {!isCompleted && !isFailed && (
                        <button
                            className="btn-primary"
                            onClick={handleUpload}
                            disabled={!canUpload}
                            style={{ flex: 1, justifyContent: 'center' }}
                        >
                            {isUploading
                                ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> {t.uploading}</>
                                : <><Upload size={16} /> {t.uploadFile}</>
                            }
                        </button>
                    )}
                </div>
            </div>

            {/* ── Recent jobs list ── */}
            {recentJobs.length > 0 && (
                <div className="card" style={{ maxWidth: 620, marginTop: '1.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1rem' }}>
                        <Clock size={16} color="var(--text-muted)" />
                        <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>Recent files</span>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            — all processed files
                        </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {recentJobs.map(rj => (
                            <div key={rj.id} style={{
                                display: 'flex', alignItems: 'center', gap: '0.75rem',
                                padding: '0.65rem 0.9rem',
                                background: 'rgba(255,255,255,0.03)',
                                border: '1px solid rgba(255,255,255,0.06)',
                                borderRadius: '0.75rem',
                            }}>
                                <FileSpreadsheet size={16} color="#22c55e" style={{ flexShrink: 0 }} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{
                                        fontWeight: 500, fontSize: '0.83rem',
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    }}>
                                        {rj.filename}
                                    </div>
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                                        {formatDate(rj.completedAt)}
                                        {rj.transactionCount != null && ` · ${rj.transactionCount} transactions`}
                                    </div>
                                    {rj.summary && <SummaryInline summary={rj.summary} />}
                                </div>
                                <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
                                    <button
                                        className="btn-secondary"
                                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.76rem' }}
                                        onClick={() => { setPreviewFilename(rj.filename); setPreviewJobId(rj.id); }}
                                    >
                                        <Eye size={13} /> Preview
                                    </button>
                                    <button
                                        className="btn-success"
                                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.76rem' }}
                                        onClick={() => handleDownload(rj.id, rj.filename)}
                                    >
                                        <Download size={13} /> Download
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Preview modal ── */}
            {previewJobId && (
                <PreviewModal
                    jobId={previewJobId}
                    filename={previewFilename}
                    onClose={() => setPreviewJobId(null)}
                    onDownload={() => handleDownload(previewJobId, previewFilename)}
                />
            )}

            <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }

        .btn-primary, .btn-secondary, .btn-success {
          display: inline-flex; align-items: center; gap: 0.5rem;
          padding: 0.6rem 1.25rem; border: none; border-radius: 0.75rem;
          font-weight: 600; font-size: 0.88rem; cursor: pointer;
          transition: opacity 0.2s, transform 0.1s;
        }
        .btn-primary { background: linear-gradient(135deg, var(--primary), var(--secondary)); color: white; }
        .btn-secondary { background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); color: var(--text-muted); }
        .btn-success { background: rgba(34,197,94,0.15); border: 1px solid rgba(34,197,94,0.3); color: #22c55e; }
        .btn-primary:hover, .btn-secondary:hover, .btn-success:hover { opacity: 0.85; }
        .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }

        .drop-zone {
          border: 2px dashed var(--glass-border); border-radius: 1rem;
          padding: 2rem 1.5rem;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          cursor: pointer; transition: border-color 0.2s, background 0.2s; text-align: center;
        }
        .drop-zone:hover, .drop-zone.dragging {
          border-color: var(--primary); background: rgba(99,102,241,0.05);
        }
        .drop-zone.has-file {
          border-color: rgba(99,102,241,0.5); background: rgba(99,102,241,0.04);
        }

        .progress-track {
          width: 100%; height: 5px;
          background: rgba(255,255,255,0.07); border-radius: 99px; overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--primary), var(--secondary));
          border-radius: 99px; transition: width 0.2s ease;
        }
      `}</style>
        </div>
    );
}

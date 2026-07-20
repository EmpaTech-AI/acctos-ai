import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

const PdfIcon = ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="#ef4444"/>
        <polyline points="14,2 14,8 20,8" fill="#fca5a5" stroke="#fca5a5" strokeWidth="0.5"/>
        <text x="5.5" y="17" fontSize="5.5" fill="white" fontWeight="bold" fontFamily="sans-serif">PDF</text>
    </svg>
);

const ExcelIcon = ({ size = 16 }: { size?: number }) => (
    <img src={`${import.meta.env.BASE_URL}excel_logo.png`} alt="Excel" width={size} height={size} style={{ objectFit: 'contain', flexShrink: 0 }} />
);
import { Zap, FileText, TrendingUp, RefreshCw, Euro, Download, Brain, Settings, X, CheckCircle, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

interface UsageSummary {
    period: string;
    from: string;
    to: string;
    summary: Record<string, { eventCount: number; totalCost: string; totalTokens: number }>;
    totals: { events: number; cost: string; currency: string };
}

interface TimeseriesPoint {
    date: string;
    make: { events: number; cost: number };
    azure: { events: number; cost: number };
    openai: { events: number; cost: number };
    total: { events: number; cost: number };
}

interface DocumentUsageData {
    customerId: string;
    from: string | null;
    to: string | null;
    days: Array<{
        date: string;
        pagesSpent: number;
        rowsUsed: number;
        documentsHandled: number;
    }>;
    totals: {
        pagesSpent: number;
        rowsUsed: number;
        documentsHandled: number;
    };
}

// ... inside Dashboard component ...

export default function Dashboard() {
    const { isAdmin } = useAuth();
    const { t } = useLanguage();

    // 1. All State Hooks
    const [summary, setSummary] = useState<UsageSummary | null>(null);
    const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([]);
    const [documentUsage, setDocumentUsage] = useState<DocumentUsageData | null>(null);
    type OpenAICostData = { inputTokens: number; outputTokens: number; totalTokens: number; costEur: string; error?: string };
    const [openaiCostsMap, setOpenaiCostsMap] = useState<Record<string, OpenAICostData>>({});
    const [loading, setLoading] = useState(true);
    const [filterMode, setFilterMode] = useState<'7d' | '30d' | 'custom'>('30d');
    const [customDays, setCustomDays] = useState('');
    const [customDaysError, setCustomDaysError] = useState('');
    const [activeDays, setActiveDays] = useState(30);
    const [infraDocUsage, setInfraDocUsage] = useState<{ pagesSpent: number; rowsUsed: number } | null>(null);
    type MonthlyEntry = { year: number; month: number; monthLabel: string; pagesSpent: number; rowsUsed: number; documentsHandled: number; isCurrent: boolean };
    const [monthlyHistory, setMonthlyHistory] = useState<MonthlyEntry[]>([]);

    // Settings State
    const [showSettings, setShowSettings] = useState(false);
    const [makeApiKey, setMakeApiKey] = useState('');
    const [makeFolderId, setMakeFolderId] = useState('');
    const [makeOrgId, setMakeOrgId] = useState('');
    const [azureApiKey, setAzureApiKey] = useState('');
    const [azureEndpoint, setAzureEndpoint] = useState('');
    const [testingConnection, setTestingConnection] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState<{ success: boolean; message: string } | null>(null);
    const [testingAzureConnection, setTestingAzureConnection] = useState(false);
    const [azureConnectionStatus, setAzureConnectionStatus] = useState<{ success: boolean; message: string } | null>(null);
    const [activeTab, setActiveTab] = useState<'infrastructure' | 'document' | 'reports'>(isAdmin ? 'infrastructure' : 'document');
    const [reports, setReports] = useState<Array<{ id: string; date: string; content: string; createdAt: string }>>([]);
    const [expandedReports, setExpandedReports] = useState<Set<string>>(new Set());
    const [reportPage, setReportPage] = useState(1);
    const REPORTS_PER_PAGE = 10;
    const [syncCooldown, setSyncCooldown] = useState(false);
    const [scenarioActionLoading, setScenarioActionLoading] = useState(false);
    const [scenarioActionError, setScenarioActionError] = useState<string | null>(null);
    const [resettingUsage, setResettingUsage] = useState(false);
    const [adjustDocsAmount, setAdjustDocsAmount] = useState('');
    const [adjustingDocs, setAdjustingDocs] = useState(false);
    const [generatingReport, setGeneratingReport] = useState(false);
    const [deletingReportId, setDeletingReportId] = useState<string | null>(null);

    // Usage limits (for Document Usage tab)
    const [usageLimits, setUsageLimits] = useState<{
        currentPages: number; currentRows: number; currentDocs: number;
        totalPagesLimit: number; totalRowsLimit: number;
        addonPagesLimit: number; addonRowsLimit: number;
        pagesRemaining: number; rowsRemaining: number;
        limitWarning: boolean;
        scenariosPaused: boolean;
        lastResetAt: string; nextResetAt: string; billingResetDay: number;
    } | null>(null);
    const [docMonthFilter, setDocMonthFilter] = useState<'30d' | 'current-month' | 'prev-month'>('30d');
    const [billingDocsTotal, setBillingDocsTotal] = useState(0);

    // 2. Helper Functions
    const fetchData = async (days = activeDays) => {
        setLoading(true);
        try {
            const toDate = new Date();
            const fromDate = new Date();
            fromDate.setDate(toDate.getDate() - days);
            const from = fromDate.toISOString().split('T')[0];
            const to = toDate.toISOString().split('T')[0];

            const [summaryRes, timeseriesRes, infraDocRes] = await Promise.allSettled([
                axios.get(`/v1/usage/summary?period=${days}d`),
                axios.get(`/v1/usage/timeseries?days=${days}`),
                axios.get('/v1/usage/document-usage', { params: { from, to } }),
            ]);
            if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value.data);
            if (timeseriesRes.status === 'fulfilled') setTimeseries(timeseriesRes.value.data.data);
            if (infraDocRes.status === 'fulfilled') {
                setInfraDocUsage(infraDocRes.value.data.totals);
            }
        } catch (error) {
            console.error('Failed to fetch usage data:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchOpenAICosts = async (days = activeDays) => {
        const res = await Promise.allSettled([axios.get(`/v1/usage/openai-costs?days=${days}`)]);
        if (res[0].status === 'fulfilled') {
            setOpenaiCostsMap(prev => ({ ...prev, [String(days)]: res[0].value.data }));
        }
    };

    const fetchMonthlyHistory = async () => {
        try {
            const res = await axios.get('/v1/usage/monthly-history');
            setMonthlyHistory(res.data.months || []);
        } catch { /* ignore */ }
    };

    const fetchDocumentUsage = async (monthFilter: '30d' | 'current-month' | 'prev-month' = '30d') => {
        setLoading(true);
        try {
            const now = new Date();
            const pad = (n: number) => String(n).padStart(2, '0');
            const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            const resetDay = usageLimits?.billingResetDay ?? 4;

            // Billing period dates — always needed for the docs card, independent of chart filter
            const billingFrom = now.getDate() >= resetDay
                ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(resetDay)}`
                : (() => { const p = new Date(now.getFullYear(), now.getMonth() - 1, 1); return `${p.getFullYear()}-${pad(p.getMonth() + 1)}-${pad(resetDay)}`; })();
            const billingTo = localDate(now);

            let from: string;
            let to: string;
            if (monthFilter === 'current-month') {
                from = usageLimits?.lastResetAt ? usageLimits.lastResetAt.split('T')[0] : billingFrom;
                to = billingTo;
            } else if (monthFilter === 'prev-month') {
                const curStart = now.getDate() >= resetDay
                    ? new Date(now.getFullYear(), now.getMonth(), resetDay)
                    : new Date(now.getFullYear(), now.getMonth() - 1, resetDay);
                const prevStart = new Date(curStart.getFullYear(), curStart.getMonth() - 1, resetDay);
                const prevEnd   = new Date(curStart.getFullYear(), curStart.getMonth(), resetDay - 1);
                from = localDate(prevStart);
                to   = localDate(prevEnd);
            } else {
                const f = new Date(now);
                f.setDate(f.getDate() - 30);
                from = localDate(f);
                to   = localDate(now);
            }

            const [docRes, limitsRes, billingDocRes] = await Promise.allSettled([
                axios.get('/v1/usage/document-usage', { params: { from, to } }),
                axios.get('/v1/billing/usage-status'),
                axios.get('/v1/usage/document-usage', { params: { from: billingFrom, to: billingTo } }),
            ]);

            if (docRes.status === 'fulfilled') {
                setDocumentUsage(docRes.value.data);
            }
            if (billingDocRes.status === 'fulfilled') {
                const billingDays: any[] = billingDocRes.value.data?.days ?? [];
                setBillingDocsTotal(billingDays.reduce((s, d) => s + Math.max(0, d.documentsHandled ?? 0), 0));
            }
            if (limitsRes.status === 'fulfilled') {
                const d = limitsRes.value.data;
                setUsageLimits({
                    currentPages:    d.currentPages ?? 0,
                    currentRows:     d.currentRows ?? 0,
                    currentDocs:     d.currentDocs ?? 0,
                    totalPagesLimit: d.totalPagesLimit ?? d.pagesLimit,
                    totalRowsLimit:  d.totalRowsLimit ?? d.rowsLimit,
                    addonPagesLimit: d.addonPagesLimit,
                    addonRowsLimit:  d.addonRowsLimit,
                    pagesRemaining:  d.pagesRemaining ?? ((d.totalPagesLimit ?? d.pagesLimit) - (d.currentPages ?? 0)),
                    rowsRemaining:   d.rowsRemaining  ?? ((d.totalRowsLimit  ?? d.rowsLimit)  - (d.currentRows  ?? 0)),
                    limitWarning:    d.limitWarning ?? false,
                    scenariosPaused: d.scenariosPaused,
                    lastResetAt:     d.lastResetAt ?? '',
                    nextResetAt:     d.nextResetAt ?? '',
                    billingResetDay: d.billingResetDay ?? 4,
                });
            }
        } catch (error) {
            console.error('Failed to fetch document usage data:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchReports = async () => {
        try {
            const res = await axios.get('/v1/reports');
            setReports(res.data.reports ?? []);
        } catch (error) {
            console.error('Failed to fetch reports:', error);
        }
    };

    const handleSync = async () => {
        if (syncCooldown) return;

        setSyncCooldown(true);
        setTimeout(() => setSyncCooldown(false), 5000);

        setLoading(true);
        try {
            if (activeTab === 'document') {
                await fetchDocumentUsage(docMonthFilter);
            } else {
                // Trigger backend sync then refresh all data including OpenAI costs
                await axios.post('/v1/integrations/make/sync');
                await Promise.all([fetchData(activeDays), fetchOpenAICosts(activeDays), fetchMonthlyHistory()]);
            }
        } catch (error) {
            console.error('Sync failed:', error);
            setLoading(false);
            alert(t.syncFailed);
        }
    };

    const handlePauseScenarios = async () => {
        setScenarioActionLoading(true);
        setScenarioActionError(null);
        try {
            const res = await axios.post('/v1/integrations/make/pause-all');
            if (res.data.scenariosPaused === 0 && res.data.scenariosFailed > 0) {
                setScenarioActionError(t.pauseErrorAll(res.data.scenariosFailed));
            }
            await fetchDocumentUsage();
        } catch {
            setScenarioActionError(t.pauseErrorServer);
        } finally {
            setScenarioActionLoading(false);
        }
    };

    const handleResumeScenarios = async () => {
        setScenarioActionLoading(true);
        setScenarioActionError(null);
        try {
            const res = await axios.post('/v1/integrations/make/resume-all');
            if (res.data.scenariosResumed === 0 && res.data.scenariosFailed > 0) {
                setScenarioActionError(t.resumeErrorAll(res.data.scenariosFailed));
            }
            await fetchDocumentUsage();
        } catch {
            setScenarioActionError(t.resumeErrorServer);
        } finally {
            setScenarioActionLoading(false);
        }
    };

    const handleResetUsage = async () => {
        if (!window.confirm(t.resetConfirm)) return;
        setResettingUsage(true);
        try {
            await axios.post('/v1/billing/reset-usage');
            // Refresh both tabs so all views show 0
            await Promise.all([fetchDocumentUsage(), fetchData()]);
        } catch (err: any) {
            const detail = err.response?.data?.error?.message || err.message || '';
            alert(detail ? `${t.resetFailed}\n\n${detail}` : t.resetFailed);
        } finally {
            setResettingUsage(false);
        }
    };

    const handleGenerateReportNow = async () => {
        setGeneratingReport(true);
        try {
            await axios.post('/v1/reports/generate-now');
            await fetchReports();
        } catch (err: any) {
            const detail = err.response?.data?.error?.message || err.message || '';
            alert(detail ? `Failed to generate report.\n\n${detail}` : 'Failed to generate report.');
        } finally {
            setGeneratingReport(false);
        }
    };

    const handleDeleteReport = async (reportId: string) => {
        if (!window.confirm('Delete this report? This cannot be undone.')) return;
        setDeletingReportId(reportId);
        try {
            await axios.delete(`/v1/reports/${reportId}`);
            await fetchReports();
        } catch (err: any) {
            const detail = err.response?.data?.error?.message || err.message || '';
            alert(detail ? `Failed to delete report.\n\n${detail}` : 'Failed to delete report.');
        } finally {
            setDeletingReportId(null);
        }
    };

    const handleAdjustDocs = async (sign: 1 | -1) => {
        const amount = parseInt(adjustDocsAmount, 10);
        if (isNaN(amount) || amount <= 0) return;
        setAdjustingDocs(true);
        try {
            await axios.put('/v1/billing/adjust-credits', { docs: sign * amount });
            setAdjustDocsAmount('');
            await fetchDocumentUsage(docMonthFilter);
        } catch (err: any) {
            const detail = err.response?.data?.error?.message || err.message || '';
            alert(detail ? `Failed to adjust documents.\n\n${detail}` : 'Failed to adjust documents.');
        } finally {
            setAdjustingDocs(false);
        }
    };

    const handleSaveSettings = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            await axios.post('/api/auth/profile', {
                makeApiKey,
                makeFolderId,
                makeOrgId,
                azureApiKey,
                azureEndpoint
            });
            alert(t.settingsSaved);
            setShowSettings(false);
            setMakeApiKey(''); // Clear secrets from memory
            setAzureApiKey('');
        } catch (error) {
            alert(t.settingsFailed);
            console.error(error);
        }
    };

    const testAzureConnection = async () => {
        setTestingAzureConnection(true);
        setAzureConnectionStatus(null);
        try {
            if (azureApiKey || azureEndpoint) {
                await axios.post('/api/auth/profile', { azureApiKey: azureApiKey || undefined, azureEndpoint: azureEndpoint || undefined });
            }
            const res = await axios.get('/v1/integrations/azure/check');
            setAzureConnectionStatus({
                success: true,
                message: `Connected! ${res.data.modelsAvailable} model(s) available.`,
            });
        } catch (error: any) {
            setAzureConnectionStatus({
                success: false,
                message: error.response?.data?.error?.message || 'Connection failed',
            });
        } finally {
            setTestingAzureConnection(false);
        }
    };

    const testMakeConnection = async () => {
        setTestingConnection(true);
        setConnectionStatus(null);
        try {
            // First save the keys if they are typed in
            if (makeApiKey) {
                await axios.post('/api/auth/profile', { makeApiKey });
            }

            const res = await axios.get('/v1/integrations/make/check');
            setConnectionStatus({
                success: true,
                message: `Connected to EU2 Zone! User: ${res.data.user.name} (${res.data.user.email})`
            });
        } catch (error: any) {
            setConnectionStatus({
                success: false,
                message: error.response?.data?.message || 'Connection failed'
            });
        } finally {
            setTestingConnection(false);
        }
    };

    const handleExport = async () => {
        try {
            const response = await axios.get(`/v1/usage/exports?days=${activeDays}`, {
                responseType: 'blob',
            });
            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `usage-export-${Date.now()}.csv`);
            document.body.appendChild(link);
            link.click();
            link.remove();
        } catch (error) {
            console.error('Export failed:', error);
        }
    };

    // 3. Effects
    useEffect(() => {
        if (activeTab === 'infrastructure') {
            fetchData(activeDays);
            fetchOpenAICosts(activeDays);
        } else {
            fetchDocumentUsage(docMonthFilter);
        }
    }, [activeDays, activeTab]);

    useEffect(() => { fetchMonthlyHistory(); }, []);

    // Fetch integration config when settings open
    useEffect(() => {
        if (showSettings) {
            const loadProfile = async () => {
                try {
                    const res = await axios.get('/api/auth/me');
                    const integrations = res.data.integrations;
                    if (integrations) {
                        setMakeOrgId(integrations.makeOrgId || '');
                        setMakeFolderId(integrations.makeFolderId || '');
                        setAzureEndpoint(integrations.azureEndpoint || '');
                    }
                } catch (err) { console.error(err); }
            };
            loadProfile();
        }
    }, [showSettings]);

    console.log('Dashboard render:', { loading, summary, timeseriesCount: timeseries.length });

    // 4. Derived State
    // Transform timeseries for chart
    const chartData = timeseries.map((point) => ({
        date: point.date,
        'Make.com Credits': point.make.cost,
        'Azure OCR': point.azure.cost,
        'OpenAI': point.openai.cost,
    }));

    // Pricing calculations
    // Make.com: 1.06 EUR per 1,000 credits
    const makeCredits = parseFloat(summary?.summary?.make?.totalCost || '0');
    const makeEurCost = makeCredits * 1.06 / 1000;
    // Azure OCR: 1.50 EUR per 1,000 pages (each event = 1 page)
    const azurePages = summary?.summary?.azure?.eventCount || 0;
    const azureEurCost = azurePages * 1.50 / 1000;
    // OpenAI: real cost fetched directly from OpenAI API (GPT-4o pricing, converted to EUR)
    const openaiCosts = openaiCostsMap[String(activeDays)] ?? null;
    const openaiCost = parseFloat(openaiCosts?.costEur || '0');
    // Total across all sources
    const eurTotal = (makeEurCost + azureEurCost + openaiCost).toFixed(2);
    const totalEvents = (summary?.summary?.make?.eventCount || 0) + azurePages + (summary?.summary?.openai?.eventCount || 0);

    // 5. Render
    if (loading && !summary) {
        return (
            <div className="loading-container">
                <div className="spinner"></div>
                <p style={{ marginTop: '1rem', color: 'var(--text-muted)' }}>{t.loadingUsage}</p>
            </div>
        );
    }

    return (

        <div>
            {/* Header */}
            <div className="page-header">
                <div>
                    <h2>{t.usageDashboard}</h2>
                    <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                        {t.usageDashboardSubtitle}
                    </p>
                </div>
                <div style={{ display: 'flex', gap: '1rem' }}>
                    <button className="btn-secondary" onClick={handleExport}>
                        <Download size={16} />
                        {t.export}
                    </button>
                    <button className="btn-secondary" onClick={handleSync} disabled={syncCooldown || loading}>
                        <RefreshCw size={16} />
                        {syncCooldown ? t.wait : t.refreshSync}
                    </button>
                    <button className="btn-secondary" onClick={() => setShowSettings(true)}>
                        <Settings size={16} />
                        {t.settings}
                    </button>
                </div>
            </div>

            {/* Period filter — infrastructure tab only */}
            {isAdmin && activeTab === 'infrastructure' && (
                <div className="period-filter">
                    <button
                        className={`period-btn ${filterMode === '7d' ? 'active' : ''}`}
                        onClick={() => { setFilterMode('7d'); setActiveDays(7); setCustomDaysError(''); fetchData(7); fetchOpenAICosts(7); }}
                    >{t.last7days}</button>
                    <button
                        className={`period-btn ${filterMode === '30d' ? 'active' : ''}`}
                        onClick={() => { setFilterMode('30d'); setActiveDays(30); setCustomDaysError(''); fetchData(30); fetchOpenAICosts(30); }}
                    >{t.last30days}</button>
                    <button
                        className={`period-btn ${filterMode === 'custom' ? 'active' : ''}`}
                        onClick={() => { setFilterMode('custom'); setCustomDays(''); setCustomDaysError(''); }}
                    >{t.custom}</button>
                    {filterMode === 'custom' && (
                        <div className="custom-days-wrap">
                            <input
                                type="number"
                                className="custom-days-input"
                                placeholder={t.daysPlaceholder}
                                value={customDays}
                                min={1}
                                max={30}
                                onChange={(e) => { setCustomDays(e.target.value); setCustomDaysError(''); }}
                            />
                            <button
                                className="period-btn active"
                                onClick={() => {
                                    const d = parseInt(customDays);
                                    if (isNaN(d) || d < 1) {
                                        setCustomDaysError(t.customDaysError1);
                                        return;
                                    }
                                    if (d > 30) {
                                        setCustomDaysError(t.customDaysError2);
                                        return;
                                    }
                                    setCustomDaysError('');
                                    setActiveDays(d);
                                }}
                            >{t.apply}</button>
                        </div>
                    )}
                    {customDaysError && <span className="custom-days-error">{customDaysError}</span>}
                </div>
            )}

            {/* Tab Switcher */}
            <div className="tab-switcher">
                {isAdmin && (
                    <button
                        className={`tab-btn ${activeTab === 'infrastructure' ? 'active' : ''}`}
                        onClick={() => setActiveTab('infrastructure')}
                    >
                        {t.infrastructureUsage}
                    </button>
                )}
                <button
                    className={`tab-btn ${activeTab === 'document' ? 'active' : ''}`}
                    onClick={() => setActiveTab('document')}
                >
                    {t.documentUsage}
                </button>
                <button
                    className={`tab-btn ${activeTab === 'reports' ? 'active' : ''}`}
                    onClick={() => { setActiveTab('reports'); fetchReports(); }}
                >
                    Reports
                </button>
            </div>

            {activeTab === 'reports' ? (
                <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                        <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Daily Reports</h2>
                        {isAdmin && (
                            <button
                                onClick={handleGenerateReportNow}
                                disabled={generatingReport}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                                    padding: '0.45rem 1rem', fontSize: '0.85rem',
                                    background: 'rgba(99,102,241,0.12)',
                                    border: '1px solid rgba(99,102,241,0.35)',
                                    borderRadius: '0.6rem', color: '#818cf8', cursor: 'pointer',
                                }}
                            >
                                <Brain size={14} />
                                {generatingReport ? 'Generating…' : 'Generate Now (Yesterday)'}
                            </button>
                        )}
                    </div>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
                        AI-generated summaries of daily usage. Reports are created automatically every day at midnight EET.
                    </p>
                    {reports.length === 0 ? (
                        <div className="card" style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-muted)' }}>
                            No reports yet. The first report will appear after midnight EET tonight.
                        </div>
                    ) : (
                        <>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            {reports.slice((reportPage - 1) * REPORTS_PER_PAGE, reportPage * REPORTS_PER_PAGE).map((report, idx) => {
                                const isExpanded = expandedReports.has(report.id);
                                const globalIdx = (reportPage - 1) * REPORTS_PER_PAGE + idx;

                                // Parse structured format: "METRICS:pages=X,rows=Y,docs=Z,credits=W\n---\nNarrative"
                                const parts = report.content.split('\n---\n');
                                const hasStructured = parts.length >= 2 && parts[0].startsWith('METRICS:');
                                let metrics: { pages: number; rows: number; docs: number; credits: number } | null = null;
                                let narrative = report.content;
                                if (hasStructured) {
                                    const raw = parts[0].replace('METRICS:', '');
                                    const m: Record<string, string> = {};
                                    raw.split(',').forEach(kv => { const [k, v] = kv.split('='); m[k] = v; });
                                    metrics = { pages: Number(m.pages ?? 0), rows: Number(m.rows ?? 0), docs: Number(m.docs ?? 0), credits: Number(m.credits ?? 0) };
                                    narrative = parts.slice(1).join('\n---\n');
                                }

                                const dateObj = new Date(report.date + 'T00:00:00');
                                const dayName = dateObj.toLocaleDateString('en-GB', { weekday: 'long' });
                                const dateFull = dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
                                const reportNumber = reports.length - globalIdx;

                                const toggleExpand = () => setExpandedReports(prev => {
                                    const next = new Set(prev);
                                    if (next.has(report.id)) next.delete(report.id); else next.add(report.id);
                                    return next;
                                });

                                return (
                                    <div key={report.id} className="card" style={{ padding: 0, overflow: 'hidden', border: isExpanded ? '1px solid rgba(99,102,241,0.3)' : undefined }}>

                                        {/* Collapsed header — always visible */}
                                        <div onClick={toggleExpand} style={{ padding: '1rem 1.25rem', cursor: 'pointer', userSelect: 'none' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: metrics ? '0.75rem' : 0 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                                    <Brain size={16} color="#818cf8" />
                                                    <div>
                                                        <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>
                                                            {dayName} — Daily Usage Report
                                                        </div>
                                                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                                                            #{reportNumber} · {dateFull}
                                                        </div>
                                                    </div>
                                                </div>
                                                <ChevronDown
                                                    size={16}
                                                    color="var(--text-muted)"
                                                    style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease', flexShrink: 0 }}
                                                />
                                            </div>

                                            {/* Metrics chips — only when collapsed and data available */}
                                            {!isExpanded && metrics && (
                                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.78rem', padding: '0.2rem 0.6rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '1rem', color: '#818cf8' }}>
                                                        <FileText size={11} /> {metrics.pages.toLocaleString()} pages
                                                    </span>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.78rem', padding: '0.2rem 0.6rem', background: 'rgba(236,72,153,0.08)', border: '1px solid rgba(236,72,153,0.2)', borderRadius: '1rem', color: '#ec4899' }}>
                                                        <TrendingUp size={11} /> {metrics.rows.toLocaleString()} rows
                                                    </span>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.78rem', padding: '0.2rem 0.6rem', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '1rem', color: '#10b981' }}>
                                                        <CheckCircle size={11} /> {metrics.docs.toLocaleString()} docs
                                                    </span>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.78rem', padding: '0.2rem 0.6rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '1rem', color: '#f59e0b' }}>
                                                        <Zap size={11} /> {metrics.credits} credits
                                                    </span>
                                                </div>
                                            )}
                                        </div>

                                        {/* Expanded body */}
                                        {isExpanded && (
                                            <div style={{ borderTop: '1px solid var(--glass-border)' }}>
                                                {/* Metrics row inside expanded */}
                                                {metrics && (
                                                    <div style={{ display: 'flex', gap: '1rem', padding: '1rem 1.25rem 0', flexWrap: 'wrap' }}>
                                                        {[
                                                            { label: 'PDF Pages', value: metrics.pages.toLocaleString(), color: '#818cf8', bg: 'rgba(99,102,241,0.08)', border: 'rgba(99,102,241,0.2)', icon: <FileText size={13} /> },
                                                            { label: 'Excel Rows', value: metrics.rows.toLocaleString(), color: '#ec4899', bg: 'rgba(236,72,153,0.08)', border: 'rgba(236,72,153,0.2)', icon: <TrendingUp size={13} /> },
                                                            { label: 'Documents', value: metrics.docs.toLocaleString(), color: '#10b981', bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.2)', icon: <CheckCircle size={13} /> },
                                                            { label: 'Make.com Credits', value: String(metrics.credits), color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.2)', icon: <Zap size={13} /> },
                                                        ].map(m => (
                                                            <div key={m.label} style={{ flex: '1 1 120px', background: m.bg, border: `1px solid ${m.border}`, borderRadius: '0.75rem', padding: '0.6rem 0.85rem' }}>
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                                                                    {m.icon}{m.label}
                                                                </div>
                                                                <div style={{ fontSize: '1.2rem', fontWeight: 700, color: m.color }}>{m.value}</div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}

                                                {/* Narrative */}
                                                <div style={{ padding: '1rem 1.25rem', fontSize: '0.92rem', lineHeight: 1.8, color: 'var(--text-primary)' }}>
                                                    {narrative.split('\n\n').map((para, i) => (
                                                        <p key={i} style={{ margin: i > 0 ? '0.85rem 0 0' : 0 }}>{para}</p>
                                                    ))}
                                                </div>

                                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 1.25rem 1rem' }}>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); setExpandedReports(prev => { const next = new Set(prev); next.delete(report.id); return next; }); }}
                                                        style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'none', border: '1px solid var(--glass-border)', borderRadius: '0.5rem', padding: '0.3rem 0.75rem', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.8rem' }}
                                                    >
                                                        <ChevronUp size={13} /> Collapse
                                                    </button>
                                                    {isAdmin && (
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); handleDeleteReport(report.id); }}
                                                            disabled={deletingReportId === report.id}
                                                            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'none', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '0.5rem', padding: '0.3rem 0.75rem', cursor: 'pointer', color: '#ef4444', fontSize: '0.8rem', opacity: deletingReportId === report.id ? 0.5 : 1 }}
                                                        >
                                                            <X size={13} /> {deletingReportId === report.id ? 'Deleting…' : 'Delete Report'}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        {reports.length > REPORTS_PER_PAGE && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', marginTop: '1.25rem' }}>
                                <button
                                    onClick={() => setReportPage(p => Math.max(1, p - 1))}
                                    disabled={reportPage === 1}
                                    style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'none', border: '1px solid var(--glass-border)', borderRadius: '0.5rem', padding: '0.35rem 0.85rem', cursor: reportPage === 1 ? 'default' : 'pointer', color: reportPage === 1 ? 'var(--text-muted)' : 'var(--text)', fontSize: '0.85rem', opacity: reportPage === 1 ? 0.45 : 1 }}
                                >
                                    <ChevronUp size={13} style={{ transform: 'rotate(-90deg)' }} /> Newer
                                </button>
                                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                    Page {reportPage} of {Math.ceil(reports.length / REPORTS_PER_PAGE)}
                                </span>
                                <button
                                    onClick={() => setReportPage(p => Math.min(Math.ceil(reports.length / REPORTS_PER_PAGE), p + 1))}
                                    disabled={reportPage === Math.ceil(reports.length / REPORTS_PER_PAGE)}
                                    style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'none', border: '1px solid var(--glass-border)', borderRadius: '0.5rem', padding: '0.35rem 0.85rem', cursor: reportPage === Math.ceil(reports.length / REPORTS_PER_PAGE) ? 'default' : 'pointer', color: reportPage === Math.ceil(reports.length / REPORTS_PER_PAGE) ? 'var(--text-muted)' : 'var(--text)', fontSize: '0.85rem', opacity: reportPage === Math.ceil(reports.length / REPORTS_PER_PAGE) ? 0.45 : 1 }}
                                >
                                    Older <ChevronUp size={13} style={{ transform: 'rotate(90deg)' }} />
                                </button>
                            </div>
                        )}
                        </>
                    )}
                </>
            ) : isAdmin && activeTab === 'infrastructure' ? (
                <>
                    {/* Make.com scenario controls */}
                    <div className="scenario-controls">
                        <div className="scenario-status">
                            <span
                                className="scenario-status-dot"
                                style={{ background: usageLimits?.scenariosPaused ? '#ef4444' : '#10b981' }}
                            />
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                                {t.scenarios} <strong style={{ color: 'var(--text)' }}>
                                    {usageLimits?.scenariosPaused ? t.paused : t.running}
                                </strong>
                            </span>
                        </div>
                        <div style={{ display: 'flex', gap: '0.75rem' }}>
                            <button
                                className="sc-btn sc-btn-pause"
                                onClick={handlePauseScenarios}
                                disabled={scenarioActionLoading || usageLimits?.scenariosPaused === true}
                            >
                                {scenarioActionLoading ? t.working : t.pauseScenarios}
                            </button>
                            <button
                                className="sc-btn sc-btn-resume"
                                onClick={handleResumeScenarios}
                                disabled={scenarioActionLoading || usageLimits?.scenariosPaused === false}
                            >
                                {scenarioActionLoading ? t.working : t.resumeScenarios}
                            </button>
                            <button
                                className="sc-btn sc-btn-reset"
                                onClick={handleResetUsage}
                                disabled={resettingUsage}
                            >
                                {resettingUsage ? t.resetting : t.resetPagesRowsDocs}
                            </button>
                        </div>
                    </div>

                    {/* Scenario action error */}
                    {scenarioActionError && (
                        <div className="sc-error-banner">
                            <span>⚠ {scenarioActionError}</span>
                            <button className="sc-error-dismiss" onClick={() => setScenarioActionError(null)}>✕</button>
                        </div>
                    )}

                    {/* Stats Grid */}
                    <div className="stats-grid">
                        <div className="card">
                            <div className="card-title">
                                <h3>Make.com</h3>
                                <Zap size={20} color="#6366f1" />
                            </div>
                            <div className="usage-value">
                                {parseFloat(summary?.summary?.make?.totalCost || '0').toFixed(2)}
                                <span className="usage-unit">{t.credits}</span>
                            </div>
                            <div className="cost-display">
                                <Zap size={18} />
                                <span>{summary?.summary?.make?.eventCount || 0} {t.operations}</span>
                            </div>
                            <div className="cost-display" style={{ marginTop: '0.25rem' }}>
                                <Euro size={18} />
                                <span>{makeEurCost.toFixed(2)} EUR</span>
                            </div>
                        </div>

                        <div className="card">
                            <div className="card-title">
                                <h3>Azure OCR</h3>
                                <FileText size={20} color="#ec4899" />
                            </div>
                            <div className="usage-value">
                                {summary?.summary?.azure?.eventCount || 0}
                                <span className="usage-unit">{t.events}</span>
                            </div>
                            <div className="cost-display">
                                <Euro size={18} />
                                <span>{azureEurCost.toFixed(2)} EUR</span>
                            </div>
                        </div>

                        <div className="card">
                            <div className="card-title">
                                <h3>OpenAI</h3>
                                <Brain size={20} color="#10b981" />
                            </div>
                            <div className="usage-value">
                                {(openaiCosts?.totalTokens ?? 0).toLocaleString()}
                                <span className="usage-unit">{t.tokens}</span>
                            </div>
                            <div className="cost-display" style={{ marginTop: '0.5rem' }}>
                                <Euro size={18} />
                                <span>{openaiCosts?.costEur ?? '0.00'} EUR</span>
                            </div>
                            <div className="cost-display" style={{ marginTop: '0.25rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                <span>↑ {(openaiCosts?.inputTokens ?? 0).toLocaleString()} in</span>
                                <span style={{ marginLeft: '0.5rem' }}>↓ {(openaiCosts?.outputTokens ?? 0).toLocaleString()} out</span>
                            </div>
                            {openaiCosts?.error && (
                                <div style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: 'var(--error, #ef4444)' }}>
                                    ⚠ {openaiCosts.error}
                                </div>
                            )}
                        </div>

                        <div className="card aggregate-card">
                            <div className="card-title">
                                <h3>{t.totalCost}</h3>
                                <TrendingUp size={20} color="#f59e0b" />
                            </div>
                            <div className="usage-value" style={{ color: '#f59e0b' }}>
                                {eurTotal}
                                <span className="usage-unit">EUR</span>
                            </div>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '1rem' }}>
                                {t.totalEventsDesc(totalEvents, activeDays)}
                            </p>
                        </div>
                    </div>

                    {/* Pages & Rows for the selected period */}
                    <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(2,1fr)', marginBottom: '2rem' }}>
                        <div className="card">
                            <div className="card-title">
                                <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><PdfIcon size={18} /> {t.pdfPagesProcessed}</h3>
                                <FileText size={20} color="#6366f1" />
                            </div>
                            <div className="usage-value">{(infraDocUsage?.pagesSpent ?? 0).toLocaleString()}<span className="usage-unit">{t.pages}</span></div>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.75rem' }}>{t.lastNDays(activeDays)}</p>
                        </div>
                        <div className="card">
                            <div className="card-title">
                                <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><ExcelIcon size={18} /> {t.excelRowsExtracted}</h3>
                                <TrendingUp size={20} color="#ec4899" />
                            </div>
                            <div className="usage-value">{(infraDocUsage?.rowsUsed ?? 0).toLocaleString()}<span className="usage-unit">{t.rows}</span></div>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.75rem' }}>{t.lastNDays(activeDays)}</p>
                        </div>
                    </div>

                    {/* Chart */}
                    <div className="chart-section">
                        <h3 style={{ marginBottom: '1.5rem' }}>{t.usageOverTime}</h3>
                        <div style={{ height: 400 }}>
                            <ResponsiveContainer>
                                <AreaChart data={chartData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                                    <XAxis dataKey="date" stroke="var(--text-muted)" />
                                    <YAxis stroke="var(--text-muted)" />
                                    <Tooltip
                                        contentStyle={{
                                            backgroundColor: 'rgba(15, 23, 42, 0.95)',
                                            borderRadius: '0.75rem',
                                            border: '1px solid var(--glass-border)',
                                        }}
                                    />
                                    <Legend />
                                    <Area type="monotone" dataKey="Make.com Credits" stroke="#6366f1" fill="#6366f1" fillOpacity={0.1} />
                                    <Area type="monotone" dataKey="Azure OCR" stroke="#ec4899" fill="#ec4899" fillOpacity={0.1} />
                                    <Area type="monotone" dataKey="OpenAI" stroke="#10b981" fill="#10b981" fillOpacity={0.1} />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Monthly Usage History */}
                    <div className="card" style={{ marginTop: '2rem' }}>
                        <h3 style={{ marginBottom: '1.5rem' }}>{t.monthlyUsageHistory}</h3>
                        {monthlyHistory.length === 0 ? (
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{t.noMonthlyHistory}</p>
                        ) : (
                            <table className="monthly-table">
                                <thead>
                                    <tr>
                                        <th>{t.month}</th>
                                        <th>{t.pdfPages}</th>
                                        <th>{t.excelRows}</th>
                                        <th>Documents</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {monthlyHistory.map((m) => (
                                        <tr key={`${m.year}-${m.month}`} className={m.isCurrent ? 'current-month-row' : ''}>
                                            <td>{m.monthLabel}</td>
                                            <td>{m.pagesSpent.toLocaleString()}</td>
                                            <td>{m.rowsUsed.toLocaleString()}</td>
                                            <td>{(m.documentsHandled ?? 0).toLocaleString()}</td>
                                            <td>{m.isCurrent && <span className="current-badge">{t.current}</span>}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </>
            ) : (
                <>
                    {/* Low-limit warning */}
                    {usageLimits?.limitWarning && !usageLimits?.scenariosPaused && (
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: '0.75rem',
                            padding: '1rem 1.25rem',
                            background: 'rgba(245,158,11,0.1)',
                            border: '1px solid rgba(245,158,11,0.35)',
                            borderRadius: '1rem', color: '#f59e0b',
                            marginBottom: '1.5rem', fontSize: '0.9rem'
                        }}>
                            <AlertCircle size={18} style={{ flexShrink: 0 }} />
                            <span>
                                <strong>Usage limit approaching — </strong>
                                {usageLimits.pagesRemaining <= 500 && <span>only <strong>{usageLimits.pagesRemaining.toLocaleString()}</strong> PDF pages remaining. </span>}
                                {usageLimits.rowsRemaining <= 500 && <span>only <strong>{usageLimits.rowsRemaining.toLocaleString()}</strong> Excel rows remaining. </span>}
                                Your automations will stop when the limit is reached. Purchase more capacity in Billing.
                            </span>
                        </div>
                    )}

                    {/* Paused notice */}
                    {usageLimits?.scenariosPaused && (
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: '0.75rem',
                            padding: '1rem 1.25rem',
                            background: 'rgba(239,68,68,0.1)',
                            border: '1px solid rgba(239,68,68,0.3)',
                            borderRadius: '1rem', color: '#ef4444',
                            marginBottom: '1.5rem', fontSize: '0.9rem'
                        }}>
                            <TrendingUp size={18} />
                            <span><strong>{t.agentPaused}</strong>{t.agentPausedDesc}</span>
                        </div>
                    )}

                    <div className="stats-grid">
                        {/* Documents Handled card */}
                        <div className="card">
                            <div className="card-title">
                                <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><CheckCircle size={18} /> Documents Handled</h3>
                                <Brain size={20} color="#10b981" />
                            </div>
                            <div className="doc-usage-row">
                                <span className="doc-usage-current" style={{ color: '#10b981' }}>{billingDocsTotal.toLocaleString()}</span>
                            </div>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.75rem' }}>
                                Documents processed in the current billing cycle
                            </p>
                            {isAdmin && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
                                    <input
                                        type="number"
                                        min="1"
                                        placeholder="Amount"
                                        value={adjustDocsAmount}
                                        onChange={(e) => setAdjustDocsAmount(e.target.value)}
                                        disabled={adjustingDocs}
                                        style={{
                                            width: 80, padding: '0.3rem 0.5rem',
                                            background: 'rgba(255,255,255,0.06)',
                                            border: '1px solid var(--glass-border)',
                                            borderRadius: '0.5rem', color: 'var(--text)',
                                            fontSize: '0.85rem',
                                        }}
                                    />
                                    <button
                                        onClick={() => handleAdjustDocs(1)}
                                        disabled={adjustingDocs || !adjustDocsAmount}
                                        style={{
                                            padding: '0.3rem 0.75rem', fontSize: '0.8rem',
                                            background: 'rgba(16,185,129,0.15)',
                                            border: '1px solid rgba(16,185,129,0.35)',
                                            borderRadius: '0.5rem', color: '#10b981', cursor: 'pointer',
                                        }}
                                    >+ Add</button>
                                    <button
                                        onClick={() => handleAdjustDocs(-1)}
                                        disabled={adjustingDocs || !adjustDocsAmount}
                                        style={{
                                            padding: '0.3rem 0.75rem', fontSize: '0.8rem',
                                            background: 'rgba(239,68,68,0.1)',
                                            border: '1px solid rgba(239,68,68,0.3)',
                                            borderRadius: '0.5rem', color: '#ef4444', cursor: 'pointer',
                                        }}
                                    >− Remove</button>
                                </div>
                            )}
                        </div>

                        {/* Pages card */}
                        <div className="card">
                            <div className="card-title">
                                <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><PdfIcon size={18} /> {t.pdfPagesSpent}</h3>
                                <FileText size={20} color="#6366f1" />
                            </div>
                            <div className="doc-usage-row">
                                <span className="doc-usage-current">{(usageLimits?.currentPages ?? 0).toLocaleString()}</span>
                                <span className="doc-usage-sep">/</span>
                                <span className="doc-usage-limit">{(usageLimits?.totalPagesLimit ?? 5000).toLocaleString()}</span>
                            </div>
                            <div className="doc-quota-bar">
                                <div
                                    className="doc-quota-fill"
                                    style={{
                                        width: `${Math.min(100, ((usageLimits?.currentPages ?? 0) / (usageLimits?.totalPagesLimit ?? 5000)) * 100)}%`,
                                        background: (usageLimits?.currentPages ?? 0) >= (usageLimits?.totalPagesLimit ?? 5000) ? '#ef4444' : undefined,
                                    }}
                                />
                            </div>
                            {usageLimits && usageLimits.addonPagesLimit > 0 && (
                                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                                    +{usageLimits.addonPagesLimit.toLocaleString()} {t.extraPdfPages}
                                </p>
                            )}
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.75rem' }}>
                                {t.pdfPagesBillingCycle}
                            </p>
                        </div>

                        {/* Rows card */}
                        <div className="card">
                            <div className="card-title">
                                <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><ExcelIcon size={18} /> {t.excelRowsUsed}</h3>
                                <TrendingUp size={20} color="#ec4899" />
                            </div>
                            <div className="doc-usage-row">
                                <span className="doc-usage-current">{(usageLimits?.currentRows ?? 0).toLocaleString()}</span>
                                <span className="doc-usage-sep">/</span>
                                <span className="doc-usage-limit">{(usageLimits?.totalRowsLimit ?? 5000).toLocaleString()}</span>
                            </div>
                            <div className="doc-quota-bar">
                                <div
                                    className="doc-quota-fill"
                                    style={{
                                        width: `${Math.min(100, ((usageLimits?.currentRows ?? 0) / (usageLimits?.totalRowsLimit ?? 5000)) * 100)}%`,
                                        background: (usageLimits?.currentRows ?? 0) >= (usageLimits?.totalRowsLimit ?? 5000) ? '#ef4444' : undefined,
                                    }}
                                />
                            </div>
                            {usageLimits && usageLimits.addonRowsLimit > 0 && (
                                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                                    +{usageLimits.addonRowsLimit.toLocaleString()} {t.extraExcelRows}
                                </p>
                            )}
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.75rem' }}>
                                {t.excelRowsBillingCycle}
                            </p>
                        </div>
                    </div>

                    <div className="card" style={{ marginTop: '1.5rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                                <h3>{t.documentUsageOverTime}</h3>
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                    <button
                                        className={`period-btn ${docMonthFilter === '30d' ? 'active' : ''}`}
                                        onClick={() => { setDocMonthFilter('30d'); fetchDocumentUsage('30d'); }}
                                    >Last 30 days</button>
                                    <button
                                        className={`period-btn ${docMonthFilter === 'current-month' ? 'active' : ''}`}
                                        onClick={() => { setDocMonthFilter('current-month'); fetchDocumentUsage('current-month'); }}
                                    >Current month</button>
                                    <button
                                        className={`period-btn ${docMonthFilter === 'prev-month' ? 'active' : ''}`}
                                        onClick={() => { setDocMonthFilter('prev-month'); fetchDocumentUsage('prev-month'); }}
                                    >Previous month</button>
                                </div>
                            </div>
                            {documentUsage && documentUsage.days.length > 0 && (() => {
                                const totalPages = Math.max(0, documentUsage.days.reduce((s, d) => s + (d.pagesSpent ?? 0), 0));
                                const totalRows  = Math.max(0, documentUsage.days.reduce((s, d) => s + (d.rowsUsed  ?? 0), 0));
                                const totalDocs  = Math.max(0, documentUsage.days.reduce((s, d) => s + (d.documentsHandled ?? 0), 0));
                                return (
                                    <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
                                        <div style={{ flex: 1, minWidth: 140, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '0.75rem', padding: '0.75rem 1rem' }}>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Total pages</div>
                                            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#6366f1' }}>{totalPages.toLocaleString()}</div>
                                        </div>
                                        <div style={{ flex: 1, minWidth: 140, background: 'rgba(236,72,153,0.08)', border: '1px solid rgba(236,72,153,0.2)', borderRadius: '0.75rem', padding: '0.75rem 1rem' }}>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Total rows</div>
                                            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#ec4899' }}>{totalRows.toLocaleString()}</div>
                                        </div>
                                        <div style={{ flex: 1, minWidth: 140, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '0.75rem', padding: '0.75rem 1rem' }}>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Documents handled</div>
                                            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#10b981' }}>{totalDocs.toLocaleString()}</div>
                                        </div>
                                    </div>
                                );
                            })()}
                            {documentUsage && documentUsage.days.length > 0 ? (
                                <div style={{ height: 400 }}>
                                    <ResponsiveContainer>
                                        <AreaChart data={documentUsage.days}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                                            <XAxis dataKey="date" stroke="var(--text-muted)" />
                                            <YAxis stroke="var(--text-muted)" />
                                            <Tooltip
                                                contentStyle={{
                                                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                                                    borderRadius: '0.75rem',
                                                    border: '1px solid var(--glass-border)',
                                                }}
                                            />
                                            <Legend />
                                            <Area type="monotone" dataKey="pagesSpent" name="Pages Spent" stroke="#6366f1" fill="#6366f1" fillOpacity={0.1} />
                                            <Area type="monotone" dataKey="rowsUsed" name="Rows Used" stroke="#ec4899" fill="#ec4899" fillOpacity={0.1} />
                                            <Area type="monotone" dataKey="documentsHandled" name="Documents Handled" stroke="#10b981" fill="#10b981" fillOpacity={0.1} />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                            ) : (
                                <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                                    No usage data for this period.
                                </div>
                            )}
                        </div>
                </>
            )}

            {/* Settings Modal */}
            {showSettings && (
                <div className="modal-overlay" onClick={() => setShowSettings(false)}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                            <h3>{t.integrationSettings}</h3>
                            <button onClick={() => setShowSettings(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                                <X size={20} />
                            </button>
                        </div>
                        <form onSubmit={handleSaveSettings}>
                            <h4 style={{ marginBottom: '0.75rem', color: '#6366f1' }}>Make.com</h4>

                            <label className="settings-label">{t.apiKey}</label>
                            <input
                                type="password"
                                className="settings-input"
                                placeholder={t.enterMakeApiKey}
                                value={makeApiKey}
                                onChange={(e) => setMakeApiKey(e.target.value)}
                            />

                            <label className="settings-label">{t.organizationId}</label>
                            <input
                                type="text"
                                className="settings-input"
                                placeholder="e.g. 1054340"
                                value={makeOrgId}
                                onChange={(e) => setMakeOrgId(e.target.value)}
                            />

                            <label className="settings-label">{t.folderId}</label>
                            <input
                                type="text"
                                className="settings-input"
                                placeholder="e.g. 449625"
                                value={makeFolderId}
                                onChange={(e) => setMakeFolderId(e.target.value)}
                            />

                            <button
                                type="button"
                                onClick={testMakeConnection}
                                disabled={testingConnection}
                                className="btn-secondary"
                                style={{ marginTop: '0.75rem', marginBottom: '1rem' }}
                            >
                                {testingConnection ? t.testingConn : t.testConnection}
                            </button>

                            {connectionStatus && (
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    marginBottom: '1rem',
                                    color: connectionStatus.success ? '#10b981' : '#ef4444'
                                }}>
                                    {connectionStatus.success ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                                    <span style={{ fontSize: '0.85rem' }}>{connectionStatus.message}</span>
                                </div>
                            )}

                            <hr style={{ border: 'none', borderTop: '1px solid var(--glass-border)', margin: '1.5rem 0' }} />

                            <h4 style={{ marginBottom: '0.75rem', color: '#ec4899' }}>Azure OCR</h4>

                            <label className="settings-label">{t.apiKey}</label>
                            <input
                                type="password"
                                className="settings-input"
                                placeholder={t.enterAzureApiKey}
                                value={azureApiKey}
                                onChange={(e) => setAzureApiKey(e.target.value)}
                            />

                            <label className="settings-label">{t.endpoint}</label>
                            <input
                                type="text"
                                className="settings-input"
                                placeholder="https://..."
                                value={azureEndpoint}
                                onChange={(e) => setAzureEndpoint(e.target.value)}
                            />

                            <button
                                type="button"
                                onClick={testAzureConnection}
                                disabled={testingAzureConnection}
                                className="btn-secondary"
                                style={{ marginTop: '0.75rem', marginBottom: '1rem' }}
                            >
                                {testingAzureConnection ? t.testingConn : t.testAzureConnection}
                            </button>

                            {azureConnectionStatus && (
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    marginBottom: '1rem',
                                    color: azureConnectionStatus.success ? '#10b981' : '#ef4444'
                                }}>
                                    {azureConnectionStatus.success ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                                    <span style={{ fontSize: '0.85rem' }}>{azureConnectionStatus.message}</span>
                                </div>
                            )}

                            <button type="submit" className="btn-primary" style={{ marginTop: '1.5rem', width: '100%' }}>
                                {t.saveSettings}
                            </button>
                        </form>
                    </div>
                </div>
            )}

            <style>{`
        .page-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 2rem;
        }
        .page-header h2 {
          font-size: 1.75rem;
        }
        .period-select {
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 0.75rem;
          padding: 0.5rem 1rem;
          color: var(--text);
          cursor: pointer;
        }
        .btn-secondary {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 1rem;
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 0.75rem;
          color: var(--text);
          cursor: pointer;
          transition: all 0.2s;
        }
        .btn-secondary:hover {
          border-color: var(--primary);
          color: var(--primary);
        }
        .tab-switcher {
          display: flex;
          gap: 1rem;
          margin-bottom: 2rem;
          padding: 0.25rem;
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 1rem;
          width: fit-content;
        }
        .tab-btn {
          padding: 0.6rem 1.5rem;
          border: none;
          background: none;
          color: var(--text-muted);
          font-weight: 600;
          cursor: pointer;
          border-radius: 0.75rem;
          transition: all 0.2s;
        }
        .tab-btn:hover {
          color: var(--text);
        }
        .tab-btn.active {
          background: var(--primary);
          color: white;
          box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
        }
        .scenario-controls {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.85rem 1.25rem;
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 1rem;
          margin-bottom: 1.5rem;
        }
        .scenario-status {
          display: flex;
          align-items: center;
          gap: 0.6rem;
        }
        .scenario-status-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .sc-btn {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.45rem 1rem;
          border: none;
          border-radius: 0.65rem;
          font-size: 0.85rem;
          font-weight: 600;
          cursor: pointer;
          transition: opacity 0.2s;
        }
        .sc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .sc-btn-pause {
          background: rgba(239, 68, 68, 0.15);
          color: #ef4444;
          border: 1px solid rgba(239, 68, 68, 0.3);
        }
        .sc-btn-pause:not(:disabled):hover { background: rgba(239, 68, 68, 0.25); }
        .sc-btn-resume {
          background: rgba(16, 185, 129, 0.15);
          color: #10b981;
          border: 1px solid rgba(16, 185, 129, 0.3);
        }
        .sc-btn-resume:not(:disabled):hover { background: rgba(16, 185, 129, 0.25); }
        .sc-btn-reset {
          background: rgba(99, 102, 241, 0.12);
          color: var(--primary);
          border: 1px solid rgba(99, 102, 241, 0.3);
        }
        .sc-btn-reset:not(:disabled):hover { background: rgba(99, 102, 241, 0.22); }
        .sc-error-banner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 0.75rem 1.25rem;
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.35);
          border-radius: 0.75rem;
          color: #ef4444;
          font-size: 0.875rem;
          margin-bottom: 1rem;
        }
        .sc-error-dismiss {
          background: none;
          border: none;
          color: #ef4444;
          cursor: pointer;
          font-size: 1rem;
          padding: 0;
          flex-shrink: 0;
          opacity: 0.7;
        }
        .sc-error-dismiss:hover { opacity: 1; }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 1.5rem;
          margin-bottom: 2rem;
        }
        @media (max-width: 1200px) {
          .stats-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        .card {
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 1.5rem;
          padding: 1.5rem;
        }
        .card-title {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }
        .card-title h3 {
          font-size: 1rem;
          color: var(--text-muted);
        }
        .usage-value {
          font-size: 2.5rem;
          font-weight: 700;
        }
        .usage-unit {
          font-size: 1rem;
          font-weight: 400;
          color: var(--text-muted);
          margin-left: 0.5rem;
        }
        .cost-display {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-top: 0.5rem;
          color: var(--primary);
          font-weight: 600;
        }
        .aggregate-card {
          background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(236, 72, 153, 0.1));
        }
        .chart-section {
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 1.5rem;
          padding: 1.5rem;
        }
        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        .modal-content {
          background: var(--background, #0f172a);
          border: 1px solid var(--glass-border);
          border-radius: 1.5rem;
          padding: 2rem;
          width: 100%;
          max-width: 500px;
          max-height: 80vh;
          overflow-y: auto;
        }
        .settings-label {
          display: block;
          font-size: 0.85rem;
          color: var(--text-muted);
          margin-bottom: 0.25rem;
          margin-top: 0.75rem;
        }
        .settings-input {
          width: 100%;
          padding: 0.6rem 1rem;
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 0.75rem;
          color: var(--text);
          font-size: 0.9rem;
          box-sizing: border-box;
        }
        .settings-input:focus {
          outline: none;
          border-color: var(--primary);
        }
        .btn-primary {
          padding: 0.75rem 1.5rem;
          background: var(--primary, #6366f1);
          border: none;
          border-radius: 0.75rem;
          color: white;
          font-weight: 600;
          cursor: pointer;
          transition: opacity 0.2s;
        }
        .btn-primary:hover {
          opacity: 0.9;
        }
        .doc-usage-row {
          display: flex;
          align-items: baseline;
          gap: 0.4rem;
          margin-bottom: 0.5rem;
        }
        .doc-usage-current {
          font-size: 2.5rem;
          font-weight: 700;
          line-height: 1;
        }
        .doc-usage-sep {
          font-size: 1.5rem;
          font-weight: 400;
          color: var(--text-muted);
        }
        .doc-usage-limit {
          font-size: 1.5rem;
          font-weight: 600;
          color: var(--text-muted);
        }
        .doc-quota-bar {
          height: 6px;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 3px;
          overflow: hidden;
          margin-top: 0.5rem;
        }
        .doc-quota-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--primary), var(--secondary));
          border-radius: 3px;
          transition: width 0.4s ease;
        }
        .doc-quota-fill--addon {
          background: linear-gradient(90deg, #f59e0b, #ec4899);
        }
        .period-filter {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-bottom: 1.5rem;
          flex-wrap: wrap;
        }
        .period-btn {
          padding: 0.45rem 1.1rem;
          border: 1px solid var(--glass-border);
          border-radius: 0.65rem;
          background: var(--surface);
          color: var(--text-muted);
          font-size: 0.85rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .period-btn:hover { color: var(--text); border-color: var(--primary); }
        .period-btn.active {
          background: rgba(99,102,241,0.15);
          border-color: var(--primary);
          color: var(--primary);
        }
        .custom-days-wrap {
          display: flex;
          align-items: center;
          gap: 0.4rem;
        }
        .custom-days-input {
          width: 110px;
          padding: 0.42rem 0.75rem;
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 0.65rem;
          color: var(--text);
          font-size: 0.85rem;
        }
        .custom-days-input:focus { outline: none; border-color: var(--primary); }
        .custom-days-error {
          color: #ef4444;
          font-size: 0.8rem;
          margin-left: 0.25rem;
        }
        .monthly-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.9rem;
        }
        .monthly-table th {
          text-align: left;
          padding: 0.6rem 1rem;
          color: var(--text-muted);
          font-weight: 600;
          border-bottom: 1px solid var(--glass-border);
          font-size: 0.8rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .monthly-table td {
          padding: 0.75rem 1rem;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .monthly-table tr:last-child td { border-bottom: none; }
        .current-month-row td { color: var(--primary); }
        .current-badge {
          padding: 0.2rem 0.6rem;
          background: rgba(99,102,241,0.15);
          border: 1px solid rgba(99,102,241,0.3);
          border-radius: 0.4rem;
          font-size: 0.72rem;
          font-weight: 600;
          color: var(--primary);
        }
      `}</style>
        </div>
    );
}

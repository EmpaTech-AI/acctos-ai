import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { CreditCard, Check, AlertCircle, ExternalLink, FlaskConical, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';

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

// ── Hardcoded plan definitions ────────────────────────────────────────────────
const PLANS = [
    {
        id: 'starter',
        name: 'Starter',
        priceLabel: '£249',
        stripeLink: 'https://buy.stripe.com/7sYdRa2dM25YfqydQgaZi0h',
        tier: 1,
        pagesPerMonth: 1000,
        rowsPerMonth: 1000,
        features: ['1,000 PDF pages / month', '1,000 Excel rows / month'],
    },
    {
        id: 'professional',
        name: 'Professional',
        priceLabel: '£989',
        stripeLink: 'https://buy.stripe.com/3cI4gA2dM4e60vE4fGaZi0j',
        tier: 2,
        pagesPerMonth: 5000,
        rowsPerMonth: 5000,
        highlighted: true,
        features: ['5,000 PDF pages / month', '5,000 Excel rows / month'],
    },
    {
        id: 'intermediate',
        name: 'Intermediate',
        priceLabel: '£1,650',
        stripeLink: 'https://buy.stripe.com/eVq14o3hQfWOa6e13uaZi0s',
        tier: 3,
        pagesPerMonth: 10000,
        rowsPerMonth: 10000,
        features: ['10,000 PDF pages / month', '10,000 Excel rows / month'],
    },
    {
        id: 'enterprise',
        name: 'Enterprise',
        priceLabel: '£2,249',
        stripeLink: 'https://buy.stripe.com/aFabJ22dM8umdiqcMcaZi0i',
        tier: 4,
        pagesPerMonth: 15000,
        rowsPerMonth: 15000,
        features: ['15,000 PDF pages / month', '15,000 Excel rows / month'],
    },
];

const ADD_ONS = [
    {
        id: 'custom_pages',
        name: 'Custom PDF Pages',
        description: 'Additional PDF page processing capacity',
        addonType: 'pages',
        options: [
            { qty: 1000,  label: '1,000 PDF pages',  price: '£249',   stripeLink: 'https://buy.stripe.com/8x200kg4CbGya6efYoaZi0l' },
            { qty: 2000,  label: '2,000 PDF pages',  price: '£498',   stripeLink: 'https://buy.stripe.com/5kQcN62dMaCu5PYfYoaZi0m' },
            { qty: 5000,  label: '5,000 PDF pages',  price: '£1,245', stripeLink: 'https://buy.stripe.com/00w4gA6u29yqguCbI8aZi0n' },
        ],
    },
    {
        id: 'custom_rows',
        name: 'Custom Excel Rows',
        description: 'Additional Excel row processing capacity',
        addonType: 'rows',
        options: [
            { qty: 1000,  label: '1,000 Excel rows',  price: '£50',  stripeLink: 'https://buy.stripe.com/9B65kE4lUaCu0vE9A0aZi0k' },
            { qty: 2000,  label: '2,000 Excel rows',  price: '£100', stripeLink: 'https://buy.stripe.com/fZu28s6u26mecem6nOaZi0o' },
            { qty: 5000,  label: '5,000 Excel rows',  price: '£250', stripeLink: 'https://buy.stripe.com/aFafZiaKi4e6cem9A0aZi0p' },
        ],
    },
];

// Admin-only test payment links (Stripe test mode)
const TEST_PAYMENTS = [
    {
        id: 'test_starter',
        label: 'Starter Plan — Test Subscribe',
        description: 'Simulates a Starter (£249/mo) subscription purchase',
        stripeLink: 'https://buy.stripe.com/test_28EeVd6CF4p07O7cWgcs800',
        type: 'subscription' as const,
        planId: 'starter',
    },
    {
        id: 'test_professional',
        label: 'Professional Plan — Test Subscribe',
        description: 'Simulates a Professional (£989/mo) subscription purchase',
        stripeLink: null as string | null,
        type: 'subscription' as const,
        planId: 'professional',
    },
    {
        id: 'test_enterprise',
        label: 'Enterprise Plan — Test Subscribe',
        description: 'Simulates an Enterprise (£2,249/mo) subscription purchase',
        stripeLink: null as string | null,
        type: 'subscription' as const,
        planId: 'enterprise',
    },
    {
        id: 'test_rows_1000',
        label: '1,000 Excel Rows — Test Add-on',
        description: 'Simulates a 1,000 row add-on one-time payment',
        stripeLink: 'https://buy.stripe.com/test_00wbJ19OR7Bc1pJbSccs801',
        type: 'addon' as const,
        addonType: 'rows' as const,
        addonQuantity: 1000,
    },
];

// Map Stripe Price IDs → plan tier (fill in once Stripe webhooks are live)
// e.g.  'price_xxxxx': 1,  'price_yyyyy': 2,  'price_zzzzz': 3
const PRICE_ID_TO_TIER: Record<string, number> = {};

interface UsageStatus {
    currentPages: number;
    currentRows: number;
    pagesLimit: number;
    rowsLimit: number;
    addonPagesLimit: number;
    addonRowsLimit: number;
    totalPagesLimit: number;
    totalRowsLimit: number;
    scenariosPaused: boolean;
    lastResetAt: string;
    nextResetAt: string;
    subscriptionStatus: string;
    billingResetDay: number;
}

export default function Billing() {
    const { isAdmin, isSuperAdmin, activeTenant } = useAuth();
    const { t } = useLanguage();
    const [usageStatus, setUsageStatus] = useState<UsageStatus | null>(null);
    const [rawUsage, setRawUsage] = useState<{ pages: number; rows: number } | null>(null);
    const [currentTier, setCurrentTier] = useState(2); // Default: Professional plan
    const [loading, setLoading] = useState(true);
    const [addonSelection, setAddonSelection] = useState<Record<string, number>>({ custom_pages: 0, custom_rows: 0 });

    // Admin adjust-credits state (pages)
    const [adjustPages, setAdjustPages] = useState('');
    const [adjustingPages, setAdjustingPages] = useState(false);
    const [adjustPagesMsg, setAdjustPagesMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

    // Admin adjust-credits state (rows)
    const [adjustRows, setAdjustRows] = useState('');
    const [adjustingRows, setAdjustingRows] = useState(false);
    const [adjustRowsMsg, setAdjustRowsMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

    const handleAdjustPages = async (e: React.FormEvent) => {
        e.preventDefault();
        const pages = adjustPages !== '' ? parseInt(adjustPages) : undefined;
        if (pages === undefined || isNaN(pages)) return;
        setAdjustingPages(true);
        setAdjustPagesMsg(null);
        try {
            const res = await axios.put('/v1/billing/adjust-credits', { pages });
            setAdjustPagesMsg({ type: 'success', text: `Done — PDF pages now: ${res.data.currentPages.toLocaleString()}` });
            setAdjustPages('');
            await fetchData();
        } catch (err: any) {
            setAdjustPagesMsg({ type: 'error', text: err.response?.data?.error?.message || 'Failed to adjust pages' });
        } finally {
            setAdjustingPages(false);
        }
    };

    // Admin manual pause/resume state
    const [togglingPause, setTogglingPause] = useState(false);
    const [pauseMsg, setPauseMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

    const handleToggleProcessing = async () => {
        const action = isPaused ? 'resume' : 'pause';
        if (!window.confirm(isPaused
            ? 'Resume processing? New jobs will be accepted again.'
            : 'Pause processing? No new jobs will start. Running jobs will complete normally.'))
            return;
        setTogglingPause(true);
        setPauseMsg(null);
        try {
            await axios.post(`/v1/billing/${action}-processing`);
            setPauseMsg({ type: 'success', text: isPaused ? 'Processing resumed.' : 'Processing paused.' });
            await fetchData();
        } catch (err: any) {
            setPauseMsg({ type: 'error', text: err.response?.data?.error?.message || `Failed to ${action} processing` });
        } finally {
            setTogglingPause(false);
        }
    };

    // Admin set-plan state
    const [settingPlan, setSettingPlan] = useState(false);
    const [setPlanMsg, setSetPlanMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

    // Admin billing reset day state
    const [resetDayInput, setResetDayInput] = useState('');
    const [settingResetDay, setSettingResetDay] = useState(false);
    const [resetDayMsg, setResetDayMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

    const handleSetResetDay = async (e: React.FormEvent) => {
        e.preventDefault();
        const day = parseInt(resetDayInput);
        if (!day || day < 1 || day > 28) {
            setResetDayMsg({ type: 'error', text: 'Enter a day between 1 and 28.' });
            return;
        }
        setSettingResetDay(true);
        setResetDayMsg(null);
        try {
            const res = await axios.put('/v1/billing/reset-day', { day });
            setResetDayMsg({ type: 'success', text: `Reset day set to ${day}th. Next reset: ${formatDate(res.data.nextResetAt)}` });
            setResetDayInput('');
            await fetchData();
        } catch (err: any) {
            setResetDayMsg({ type: 'error', text: err.response?.data?.error?.message || 'Failed to update reset day' });
        } finally {
            setSettingResetDay(false);
        }
    };

    const handleSetPlan = async (planId: string) => {
        const plan = PLANS.find(p => p.id === planId);
        if (!plan) return;
        if (!window.confirm(`Set this tenant to ${plan.name} plan?`)) return;
        setSettingPlan(true);
        setSetPlanMsg(null);
        try {
            await axios.put('/v1/billing/set-plan', { status: planId });
            setSetPlanMsg({ type: 'success', text: `Plan updated to ${plan.name}.` });
            await fetchData();
        } catch (err: any) {
            setSetPlanMsg({ type: 'error', text: err.response?.data?.error?.message || 'Failed to update plan' });
        } finally {
            setSettingPlan(false);
        }
    };

    // Admin simulate addon state
    const [simulatingId, setSimulatingId] = useState<string | null>(null);
    const [simulateMsgs, setSimulateMsgs] = useState<Record<string, { type: 'error' | 'success'; text: string }>>({});

    // Custom simulate state
    const [customSimulateQty, setCustomSimulateQty] = useState<{ pages: string; rows: string }>({ pages: '', rows: '' });
    const [customSimulating, setCustomSimulating] = useState<'pages' | 'rows' | null>(null);
    const [customSimulateMsg, setCustomSimulateMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

    const handleCustomSimulate = async (type: 'pages' | 'rows', action: 'add' | 'remove') => {
        const qty = parseInt(customSimulateQty[type]);
        if (!qty || qty <= 0) return;
        setCustomSimulating(type);
        setCustomSimulateMsg(null);
        try {
            if (action === 'add') {
                await axios.post('/v1/billing/simulate-addon', { addonType: type, addonQuantity: qty });
                setCustomSimulateMsg({ type: 'success', text: `+${qty.toLocaleString()} ${type} added.` });
            } else {
                await axios.post('/v1/billing/remove-addon', { addonType: type, addonQuantity: qty });
                setCustomSimulateMsg({ type: 'success', text: `-${qty.toLocaleString()} ${type} removed.` });
            }
            setCustomSimulateQty(prev => ({ ...prev, [type]: '' }));
            await fetchData();
        } catch (err: any) {
            setCustomSimulateMsg({ type: 'error', text: err.response?.data?.error?.message || 'Failed' });
        } finally {
            setCustomSimulating(null);
        }
    };

    const handleSimulateAddon = async (tp: typeof TEST_PAYMENTS[number]) => {
        if (tp.type !== 'addon') return;
        setSimulatingId(tp.id);
        setSimulateMsgs(prev => ({ ...prev, [tp.id]: undefined as any }));
        try {
            await axios.post('/v1/billing/simulate-addon', { addonType: tp.addonType, addonQuantity: tp.addonQuantity });
            setSimulateMsgs(prev => ({ ...prev, [tp.id]: { type: 'success', text: `+${tp.addonQuantity!.toLocaleString()} ${tp.addonType} credited!` } }));
            await fetchData();
        } catch (err: any) {
            setSimulateMsgs(prev => ({ ...prev, [tp.id]: { type: 'error', text: err.response?.data?.error?.message || 'Simulate failed' } }));
        } finally {
            setSimulatingId(null);
        }
    };

    const handleSimulatePlan = async (tp: typeof TEST_PAYMENTS[number]) => {
        if (tp.type !== 'subscription') return;
        setSimulatingId(tp.id);
        setSimulateMsgs(prev => ({ ...prev, [tp.id]: undefined as any }));
        try {
            await axios.post('/v1/billing/simulate-plan', { planId: (tp as any).planId });
            setSimulateMsgs(prev => ({ ...prev, [tp.id]: { type: 'success', text: `Plan set to ${(tp as any).planId}!` } }));
            await fetchData();
        } catch (err: any) {
            setSimulateMsgs(prev => ({ ...prev, [tp.id]: { type: 'error', text: err.response?.data?.error?.message || 'Simulate failed' } }));
        } finally {
            setSimulatingId(null);
        }
    };

    // Downgrade confirmation state
    const [downgradeTarget, setDowngradeTarget] = useState<(typeof PLANS)[number] | null>(null);
    const [downgradingPlan, setDowngradingPlan] = useState(false);
    const [downgradeError, setDowngradeError] = useState<string | null>(null);

    const handleConfirmDowngrade = async () => {
        if (!downgradeTarget) return;
        setDowngradingPlan(true);
        setDowngradeError(null);
        try {
            await axios.put('/v1/billing/set-plan', { status: downgradeTarget.id });
            setDowngradeTarget(null);
            await fetchData();
        } catch (err: any) {
            setDowngradeError(err.response?.data?.error?.message || 'Failed to downgrade plan');
        } finally {
            setDowngradingPlan(false);
        }
    };

    const [resettingAddon, setResettingAddon] = useState(false);
    const [resetAddonMsg, setResetAddonMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

    const handleResetAddonLimits = async () => {
        setResettingAddon(true);
        setResetAddonMsg(null);
        try {
            await axios.post('/v1/billing/reset-addon-limits');
            setResetAddonMsg({ type: 'success', text: 'Custom credits reset to 0. Only new Stripe purchases will add credits.' });
            await fetchData();
        } catch (err: any) {
            setResetAddonMsg({ type: 'error', text: err.response?.data?.error?.message || 'Failed to reset custom credits' });
        } finally {
            setResettingAddon(false);
        }
    };

    const handleAdjustRows = async (e: React.FormEvent) => {
        e.preventDefault();
        const rows = adjustRows !== '' ? parseInt(adjustRows) : undefined;
        if (rows === undefined || isNaN(rows)) return;
        setAdjustingRows(true);
        setAdjustRowsMsg(null);
        try {
            const res = await axios.put('/v1/billing/adjust-credits', { rows });
            setAdjustRowsMsg({ type: 'success', text: `Done — Excel rows now: ${res.data.currentRows.toLocaleString()}` });
            setAdjustRows('');
            await fetchData();
        } catch (err: any) {
            setAdjustRowsMsg({ type: 'error', text: err.response?.data?.error?.message || 'Failed to adjust rows' });
        } finally {
            setAdjustingRows(false);
        }
    };

    const fetchData = useCallback(async () => {
        try {
            const [statusRes, rawRes, subRes] = await Promise.allSettled([
                axios.get('/v1/billing/usage-status'),
                axios.get('/v1/billing/raw-usage'),
                axios.get('/v1/billing/subscription'),
            ]);

            if (statusRes.status === 'fulfilled') {
                setUsageStatus(statusRes.value.data);
            }

            if (rawRes.status === 'fulfilled') {
                setRawUsage(rawRes.value.data);
            }

            if (statusRes.status === 'fulfilled') {
                const planStatus = statusRes.value.data?.subscriptionStatus;
                const STATUS_TO_TIER: Record<string, number> = {
                    starter: 1, professional: 2, intermediate: 3, enterprise: 4,
                };
                if (planStatus && STATUS_TO_TIER[planStatus]) {
                    setCurrentTier(STATUS_TO_TIER[planStatus]);
                }
            }
        } catch (err) {
            console.error('Failed to load billing data:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);


    const isSubscribed = (usageStatus?.subscriptionStatus === 'active') || currentTier > 0;

    const formatDate = (iso: string) =>
        new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });


    if (loading) {
        return <div className="loading-container"><div className="spinner" /></div>;
    }

    const us = usageStatus;
    const addonPages     = us?.addonPagesLimit ?? 0;
    const addonRows      = us?.addonRowsLimit  ?? 0;
    const totalPages     = us?.totalPagesLimit ?? us?.pagesLimit ?? 5000;
    const totalRows      = us?.totalRowsLimit  ?? us?.rowsLimit  ?? 5000;
    const curPages       = us?.currentPages ?? rawUsage?.pages ?? 0;
    const curRows        = us?.currentRows  ?? rawUsage?.rows  ?? 0;
    const isPaused       = us?.scenariosPaused ?? false;

    const pagesPct = Math.min(100, totalPages > 0 ? (curPages / totalPages) * 100 : 0);
    const rowsPct  = Math.min(100, totalRows  > 0 ? (curRows  / totalRows)  * 100 : 0);

    return (
        <div>
            {/* Paused scenarios banner */}
            {isPaused && (
                <div className="pause-banner">
                    <AlertCircle size={20} />
                    <div className="pause-banner-text">
                        <strong>{t.agentPausedBilling}</strong>{t.agentPausedBillingDesc}
                        {isSubscribed
                            ? t.autoResume(us?.nextResetAt ? formatDate(us.nextResetAt) : '—')
                            : t.purchaseToResume
                        }
                    </div>
                </div>
            )}

            {/* Admin / Superadmin: manual processing gate control */}
            {(isAdmin || isSuperAdmin) && (
                <div style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
                    padding: '0.65rem 1rem',
                    marginBottom: '1rem',
                    background: isPaused ? 'rgba(239,68,68,0.07)' : 'rgba(34,197,94,0.06)',
                    border: `1px solid ${isPaused ? 'rgba(239,68,68,0.25)' : 'rgba(34,197,94,0.2)'}`,
                    borderRadius: '0.75rem',
                }}>
                    <span style={{
                        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                        background: isPaused ? '#ef4444' : '#22c55e',
                        boxShadow: isPaused ? '0 0 6px #ef4444' : '0 0 6px #22c55e',
                    }} />
                    <span style={{ fontSize: '0.83rem', fontWeight: 600, color: isPaused ? '#fca5a5' : '#86efac' }}>
                        Processing: {isPaused ? 'Paused' : 'Active'}
                    </span>
                    <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)', flex: 1 }}>
                        {isPaused
                            ? 'New jobs are blocked. Running jobs complete normally.'
                            : 'New jobs are accepted normally.'}
                    </span>
                    <button
                        onClick={handleToggleProcessing}
                        disabled={togglingPause}
                        style={{
                            padding: '0.3rem 0.85rem', fontSize: '0.78rem', fontWeight: 600,
                            border: 'none', borderRadius: '0.5rem', cursor: 'pointer',
                            background: isPaused ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.15)',
                            color: isPaused ? '#22c55e' : '#ef4444',
                            opacity: togglingPause ? 0.6 : 1,
                        }}
                    >
                        {togglingPause ? '…' : isPaused ? 'Resume' : 'Pause'}
                    </button>
                    {pauseMsg && (
                        <span style={{ fontSize: '0.75rem', color: pauseMsg.type === 'success' ? '#10b981' : '#ef4444' }}>
                            {pauseMsg.text}
                        </span>
                    )}
                </div>
            )}

            {/* Header */}
            <div className="billing-header">
                <div>
                    <h2>{t.billingTitle}</h2>
                    <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                        {t.billingSubtitle}
                    </p>
                </div>
            </div>

            {/* Current usage card */}
            <div className="current-plan-card">
                <div className="current-plan-header">
                    <div>
                        <h3>{t.currentPeriodUsage}</h3>
                        <div className="status-badge" data-status={
                            usageStatus?.subscriptionStatus === 'enterprise' ? 'enterprise' :
                            usageStatus?.subscriptionStatus === 'intermediate' ? 'intermediate' :
                            usageStatus?.subscriptionStatus === 'starter' ? 'starter' : 'active'
                        }>
                            {usageStatus?.subscriptionStatus === 'enterprise' ? t.enterprisePlan :
                             usageStatus?.subscriptionStatus === 'intermediate' ? 'Intermediate Plan' :
                             usageStatus?.subscriptionStatus === 'starter' ? 'Starter Plan' :
                             t.professionalPlan}
                        </div>
                        {isAdmin && (
                            <div style={{ marginTop: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <select
                                    disabled={settingPlan}
                                    defaultValue=""
                                    onChange={(e) => { if (e.target.value) handleSetPlan(e.target.value); e.target.value = ''; }}
                                    style={{
                                        fontSize: '0.78rem', padding: '0.28rem 0.6rem',
                                        background: '#1e293b',
                                        border: '1px solid rgba(99,102,241,0.35)',
                                        borderRadius: '0.4rem', color: '#e2e8f0', cursor: 'pointer',
                                    }}
                                >
                                    <option value="" disabled style={{ background: '#1e293b', color: '#e2e8f0' }}>Set plan…</option>
                                    {PLANS.map(p => (
                                        <option key={p.id} value={p.id} style={{ background: '#1e293b', color: '#e2e8f0' }}>{p.name}</option>
                                    ))}
                                </select>
                                {settingPlan && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Updating…</span>}
                                {setPlanMsg && (
                                    <span style={{ fontSize: '0.75rem', color: setPlanMsg.type === 'success' ? '#10b981' : '#ef4444' }}>
                                        {setPlanMsg.text}
                                    </span>
                                )}
                            </div>
                        )}
                        {us?.nextResetAt && (
                            <p className="reset-note">
                                {t.resetsOn(formatDate(us.nextResetAt))}
                                {us.billingResetDay && (
                                    <span style={{ color: 'var(--text-muted)', marginLeft: '0.4rem', fontSize: '0.8rem' }}>
                                        (day {us.billingResetDay} each month)
                                    </span>
                                )}
                            </p>
                        )}
                        {isAdmin && (
                            <form onSubmit={handleSetResetDay} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Reset day:</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={28}
                                    value={resetDayInput}
                                    onChange={e => setResetDayInput(e.target.value)}
                                    placeholder={String(us?.billingResetDay ?? 4)}
                                    style={{ width: '4rem', padding: '0.25rem 0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--glass-border)', borderRadius: '0.4rem', color: 'var(--text)', fontSize: '0.85rem', outline: 'none' }}
                                />
                                <button
                                    type="submit"
                                    disabled={settingResetDay || !resetDayInput}
                                    style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.35)', borderRadius: '0.4rem', color: '#818cf8', cursor: 'pointer' }}
                                >
                                    {settingResetDay ? 'Saving…' : 'Update'}
                                </button>
                                {resetDayMsg && (
                                    <span style={{ fontSize: '0.78rem', color: resetDayMsg.type === 'success' ? '#10b981' : '#ef4444' }}>
                                        {resetDayMsg.text}
                                    </span>
                                )}
                            </form>
                        )}
                    </div>
                    <CreditCard size={32} color="var(--primary)" />
                </div>

                <div className="quota-grid">
                    {/* PDF Pages */}
                    <div className="quota-item">
                        <div className="quota-item-header">
                            <span className="quota-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <PdfIcon size={15} />
                                <span>{t.pdfPagesUsed}</span>
                            </span>
                            <span className="quota-value">{curPages.toLocaleString()} / {totalPages.toLocaleString()}</span>
                        </div>
                        <div className="quota-bar">
                            <div className="quota-fill" style={{ width: `${pagesPct}%`, background: pagesPct >= 100 ? '#ef4444' : undefined }} />
                        </div>
                        {addonPages > 0 && (
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                                Includes +{addonPages.toLocaleString()} purchased pages
                            </p>
                        )}
                    </div>

                    {/* Excel Rows */}
                    <div className="quota-item">
                        <div className="quota-item-header">
                            <span className="quota-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <ExcelIcon size={15} />
                                <span>{t.excelRowsUsed2}</span>
                            </span>
                            <span className="quota-value">{curRows.toLocaleString()} / {totalRows.toLocaleString()}</span>
                        </div>
                        <div className="quota-bar">
                            <div className="quota-fill" style={{ width: `${rowsPct}%`, background: rowsPct >= 100 ? '#ef4444' : undefined }} />
                        </div>
                        {addonRows > 0 && (
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                                Includes +{addonRows.toLocaleString()} purchased rows
                            </p>
                        )}
                    </div>
                </div>

            </div>

            {/* Plans */}
            <h3 style={{ marginBottom: '1.5rem' }}>{t.subscriptionPlans}</h3>
            <div className="plans-grid">
                {PLANS.map((plan) => {
                    const isCurrentPlan = isSubscribed && plan.tier === currentTier;
                    const isLowerTier   = isSubscribed && plan.tier < currentTier;

                    return (
                        <div
                            key={plan.id}
                            className={`plan-card${plan.highlighted && !isSubscribed ? ' plan-card--highlighted' : ''}${isCurrentPlan ? ' plan-card--current' : ''}`}
                        >
                            {plan.highlighted && !isSubscribed && (
                                <div className="plan-badge">{t.mostPopular}</div>
                            )}
                            {isCurrentPlan && (
                                <div className="plan-badge plan-badge--current">{t.currentPlan}</div>
                            )}

                            <div className="plan-header">
                                <h4>{plan.name}</h4>
                                <div className="plan-price">
                                    <span className="price-amount">{plan.priceLabel}</span>
                                    <span className="price-period">{t.perMonth}</span>
                                </div>
                            </div>

                            <ul className="plan-features">
                                {plan.features.map((f) => (
                                    <li key={f}>
                                        <Check size={16} color="var(--success, #10b981)" />
                                        <span>{f}</span>
                                    </li>
                                ))}
                            </ul>

                            {isCurrentPlan && (
                                <button disabled className="btn-current-plan">
                                    <Check size={16} />
                                    {t.currentlyChosen}
                                </button>
                            )}
                            {!isCurrentPlan && isLowerTier && (
                                <button
                                    className="btn-secondary btn-plan"
                                    onClick={() => { setDowngradeTarget(plan); setDowngradeError(null); }}
                                >
                                    {t.downgradeTo(plan.name)}
                                </button>
                            )}
                            {!isCurrentPlan && !isLowerTier && (
                                <a
                                    href={`${plan.stripeLink}${activeTenant?.id ? `?client_reference_id=${activeTenant.id}` : ''}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn-primary btn-plan"
                                >
                                    <ExternalLink size={16} />
                                    {isSubscribed ? t.upgradeTo(plan.name) : t.subscribeTo(plan.priceLabel)}
                                </a>
                            )}
                        </div>
                    );
                })}
            </div>

            <p className="downgrade-notice">
                {t.downgradeNotice}
            </p>

            {/* Add-ons */}
            <h3 style={{ marginBottom: '1.5rem', marginTop: '2.5rem' }}>{t.addons}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1.5rem', marginTop: '-1rem' }}>
                {t.addonsDesc}
            </p>
            <div className="addons-grid">
                {ADD_ONS.map((addon) => {
                    const selIdx = addonSelection[addon.id] ?? 0;
                    const selected = addon.options[selIdx];
                    return (
                        <div key={addon.id} className="addon-card">
                            <div className="addon-card-top">
                                <h4 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    {addon.addonType === 'pages' ? <PdfIcon size={20} /> : <ExcelIcon size={20} />}
                                    {addon.name}
                                </h4>
                                <p className="addon-description">{addon.addonType === 'pages' ? t.addlPdfDesc : t.addlRowsDesc}</p>
                            </div>

                            {/* Pill selector */}
                            <div className="addon-pills">
                                {addon.options.map((opt, idx) => (
                                    <button
                                        key={opt.qty}
                                        className={`addon-pill${selIdx === idx ? ' active' : ''}`}
                                        onClick={() => setAddonSelection(prev => ({ ...prev, [addon.id]: idx }))}
                                    >
                                        <span className="pill-qty">{opt.qty.toLocaleString()}</span>
                                        <span className="pill-price">{opt.price}</span>
                                    </button>
                                ))}
                            </div>

                            {/* Summary row */}
                            <div className="addon-summary">
                                <span className="addon-summary-label">{t.oneTimePayment}</span>
                                <span className="addon-summary-price">{selected.price}</span>
                            </div>

                            {/* Purchase CTA */}
                            <a
                                href={selected.stripeLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn-primary addon-purchase-btn"
                            >
                                <ExternalLink size={16} />
                                {t.purchaseItem(selected.label)}
                            </a>
                        </div>
                    );
                })}
            </div>

            {/* Admin-only test payment section */}
            {isAdmin && (
                <div className="test-section">
                    <div className="test-section-header">
                        <FlaskConical size={18} />
                        <h3>{t.testPayments} <span className="admin-badge">{t.adminOnly}</span></h3>
                    </div>
                    <p className="test-section-desc">
                        {t.testPaymentsDesc} <code>4242 4242 4242 4242</code>{t.testPaymentsDesc2}
                    </p>
                    {activeTenant?.id && (
                        <p className="test-section-desc" style={{ marginBottom: '1rem', marginTop: '-0.5rem' }}>
                            Tenant ID: <code style={{ userSelect: 'all' }}>{activeTenant.id}</code>
                            {' — '}this must be set in the Stripe payment link metadata as <code>tenantId</code> for credits to be applied automatically.
                        </p>
                    )}
                    <div className="test-payments-grid">
                        {TEST_PAYMENTS.map((tp) => (
                            <div key={tp.id} className="test-payment-card">
                                <div className="test-payment-info">
                                    <span className={`test-type-badge test-type-badge--${tp.type}`}>
                                        {tp.type === 'subscription' ? t.subscriptionBadge : t.addonBadge}
                                    </span>
                                    <p className="test-payment-label">{tp.label}</p>
                                    <p className="test-payment-desc">{tp.description}</p>
                                    {simulateMsgs[tp.id] && (
                                        <p style={{ fontSize: '0.78rem', margin: '0.35rem 0 0', color: simulateMsgs[tp.id].type === 'error' ? '#ef4444' : '#22c55e' }}>
                                            {simulateMsgs[tp.id].text}
                                        </p>
                                    )}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-end' }}>
                                    {tp.type === 'subscription' && (
                                        <button
                                            onClick={() => handleSimulatePlan(tp)}
                                            disabled={simulatingId === tp.id}
                                            className="btn-simulate"
                                        >
                                            {simulatingId === tp.id ? '…' : `Switch to ${(tp as any).planId}`}
                                        </button>
                                    )}
                                    {tp.type === 'addon' && (
                                        <button
                                            onClick={() => handleSimulateAddon(tp)}
                                            disabled={simulatingId === tp.id}
                                            className="btn-simulate"
                                        >
                                            {simulatingId === tp.id ? '...' : `+ Credit ${tp.addonQuantity!.toLocaleString()} ${tp.addonType}`}
                                        </button>
                                    )}
                                    {tp.stripeLink && (
                                        <a
                                            href={`${tp.stripeLink}${activeTenant?.id ? `?client_reference_id=${activeTenant.id}` : ''}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="btn-test"
                                        >
                                            <ExternalLink size={14} />
                                            {t.openTestCheckout}
                                        </a>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Custom quantity simulate */}
                    <div style={{ marginTop: '1.25rem', padding: '1rem', background: 'rgba(99,102,241,0.06)', borderRadius: '0.75rem', border: '1px solid rgba(99,102,241,0.2)' }}>
                        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                            Add or remove addon quantity directly (bypasses Stripe — for testing):
                        </p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                <input
                                    type="number"
                                    min="1"
                                    placeholder="Pages qty"
                                    value={customSimulateQty.pages}
                                    onChange={e => setCustomSimulateQty(p => ({ ...p, pages: e.target.value }))}
                                    style={{ width: '120px', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--glass-border)', borderRadius: '0.5rem', color: 'var(--text)', fontSize: '0.85rem' }}
                                />
                                <button
                                    className="btn-simulate"
                                    disabled={!customSimulateQty.pages || customSimulating === 'pages'}
                                    onClick={() => handleCustomSimulate('pages', 'add')}
                                >
                                    {customSimulating === 'pages' ? '...' : '+ Add pages'}
                                </button>
                                <button
                                    className="btn-simulate"
                                    disabled={!customSimulateQty.pages || customSimulating === 'pages'}
                                    onClick={() => handleCustomSimulate('pages', 'remove')}
                                    style={{ background: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', color: '#ef4444' }}
                                >
                                    {customSimulating === 'pages' ? '...' : '− Remove pages'}
                                </button>
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                <input
                                    type="number"
                                    min="1"
                                    placeholder="Rows qty"
                                    value={customSimulateQty.rows}
                                    onChange={e => setCustomSimulateQty(p => ({ ...p, rows: e.target.value }))}
                                    style={{ width: '120px', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--glass-border)', borderRadius: '0.5rem', color: 'var(--text)', fontSize: '0.85rem' }}
                                />
                                <button
                                    className="btn-simulate"
                                    disabled={!customSimulateQty.rows || customSimulating === 'rows'}
                                    onClick={() => handleCustomSimulate('rows', 'add')}
                                >
                                    {customSimulating === 'rows' ? '...' : '+ Add rows'}
                                </button>
                                <button
                                    className="btn-simulate"
                                    disabled={!customSimulateQty.rows || customSimulating === 'rows'}
                                    onClick={() => handleCustomSimulate('rows', 'remove')}
                                    style={{ background: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', color: '#ef4444' }}
                                >
                                    {customSimulating === 'rows' ? '...' : '− Remove rows'}
                                </button>
                            </div>
                        </div>
                        {customSimulateMsg && (
                            <p style={{ fontSize: '0.82rem', marginTop: '0.5rem', color: customSimulateMsg.type === 'error' ? '#ef4444' : '#22c55e' }}>
                                {customSimulateMsg.text}
                            </p>
                        )}
                    </div>
                </div>
            )}

            {/* Admin-only adjust usage section */}
            {isAdmin && (
                <div className="adjust-section">
                    <div className="test-section-header" style={{ color: 'var(--primary)' }}>
                        <SlidersHorizontal size={18} />
                        <h3 style={{ color: 'var(--primary)' }}>
                            Adjust Usage <span className="admin-badge">Admin Only</span>
                        </h3>
                    </div>
                    <p className="test-section-desc">
                        Directly add or subtract from the current period's spent pages/rows. Use positive numbers to add usage, negative to remove. Current: <strong style={{ color: 'var(--text)' }}>{curPages.toLocaleString()} pages</strong> / <strong style={{ color: 'var(--text)' }}>{curRows.toLocaleString()} rows</strong>.
                    </p>

                    {(addonPages > 0 || addonRows > 0) && (
                        <div style={{ marginBottom: '1rem', padding: '0.75rem 1rem', background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                Stale custom credits detected: <strong style={{ color: 'var(--text)' }}>{addonPages.toLocaleString()} pages</strong> / <strong style={{ color: 'var(--text)' }}>{addonRows.toLocaleString()} rows</strong>. Reset to clear them.
                            </span>
                            {resetAddonMsg && (
                                <span style={{ fontSize: '0.82rem', color: resetAddonMsg.type === 'error' ? '#ef4444' : '#22c55e' }}>{resetAddonMsg.text}</span>
                            )}
                            <button
                                onClick={handleResetAddonLimits}
                                disabled={resettingAddon}
                                style={{ padding: '0.45rem 1rem', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: '0.6rem', color: '#f59e0b', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer', whiteSpace: 'nowrap', opacity: resettingAddon ? 0.6 : 1 }}
                            >
                                {resettingAddon ? 'Resetting...' : 'Reset Custom Credits to 0'}
                            </button>
                        </div>
                    )}
                    {resetAddonMsg && addonPages === 0 && addonRows === 0 && (
                        <div style={{ marginBottom: '1rem', fontSize: '0.82rem', color: '#22c55e' }}>{resetAddonMsg.text}</div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                        {/* Pages card */}
                        <div style={{ padding: '1.25rem', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--glass-border)', borderRadius: '1rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                <PdfIcon size={16} />
                                <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>PDF Pages</span>
                            </div>
                            {adjustPagesMsg && (
                                <div style={{ padding: '0.5rem 0.75rem', marginBottom: '0.75rem', background: adjustPagesMsg.type === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)', border: `1px solid ${adjustPagesMsg.type === 'error' ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`, borderRadius: '0.5rem', color: adjustPagesMsg.type === 'error' ? '#ef4444' : '#22c55e', fontSize: '0.82rem' }}>
                                    {adjustPagesMsg.text}
                                </div>
                            )}
                            <form onSubmit={handleAdjustPages} style={{ display: 'flex', gap: '0.5rem' }}>
                                <input
                                    type="number"
                                    value={adjustPages}
                                    onChange={(e) => setAdjustPages(e.target.value)}
                                    placeholder="e.g. 500 or -200"
                                    style={{ flex: 1, padding: '0.55rem 0.8rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--glass-border)', borderRadius: '0.6rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }}
                                />
                                <button
                                    type="submit"
                                    disabled={adjustingPages || adjustPages === ''}
                                    style={{ padding: '0.55rem 1rem', background: 'linear-gradient(135deg, var(--primary), var(--secondary))', border: 'none', borderRadius: '0.6rem', color: 'white', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', opacity: adjustingPages || adjustPages === '' ? 0.5 : 1, whiteSpace: 'nowrap' }}
                                >
                                    {adjustingPages ? '...' : 'Apply'}
                                </button>
                            </form>
                        </div>

                        {/* Rows card */}
                        <div style={{ padding: '1.25rem', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--glass-border)', borderRadius: '1rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                <ExcelIcon size={16} />
                                <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Excel Rows</span>
                            </div>
                            {adjustRowsMsg && (
                                <div style={{ padding: '0.5rem 0.75rem', marginBottom: '0.75rem', background: adjustRowsMsg.type === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)', border: `1px solid ${adjustRowsMsg.type === 'error' ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`, borderRadius: '0.5rem', color: adjustRowsMsg.type === 'error' ? '#ef4444' : '#22c55e', fontSize: '0.82rem' }}>
                                    {adjustRowsMsg.text}
                                </div>
                            )}
                            <form onSubmit={handleAdjustRows} style={{ display: 'flex', gap: '0.5rem' }}>
                                <input
                                    type="number"
                                    value={adjustRows}
                                    onChange={(e) => setAdjustRows(e.target.value)}
                                    placeholder="e.g. 1000 or -500"
                                    style={{ flex: 1, padding: '0.55rem 0.8rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--glass-border)', borderRadius: '0.6rem', color: 'var(--text)', fontSize: '0.9rem', outline: 'none' }}
                                />
                                <button
                                    type="submit"
                                    disabled={adjustingRows || adjustRows === ''}
                                    style={{ padding: '0.55rem 1rem', background: 'linear-gradient(135deg, var(--primary), var(--secondary))', border: 'none', borderRadius: '0.6rem', color: 'white', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', opacity: adjustingRows || adjustRows === '' ? 0.5 : 1, whiteSpace: 'nowrap' }}
                                >
                                    {adjustingRows ? '...' : 'Apply'}
                                </button>
                            </form>
                        </div>
                    </div>
                </div>
            )}

            {/* Downgrade confirmation modal */}
            {downgradeTarget && (
                <div className="modal-overlay" onClick={() => !downgradingPlan && setDowngradeTarget(null)}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                        <h3 style={{ marginBottom: '1rem' }}>Confirm Downgrade</h3>
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem', marginBottom: '0.75rem' }}>
                            Are you sure you want to downgrade to the <strong style={{ color: 'var(--text)' }}>{downgradeTarget.name}</strong> plan ({downgradeTarget.priceLabel}/month)?
                        </p>
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
                            Your limits will change to <strong style={{ color: 'var(--text)' }}>{downgradeTarget.pagesPerMonth.toLocaleString()} PDF pages</strong> and <strong style={{ color: 'var(--text)' }}>{downgradeTarget.rowsPerMonth.toLocaleString()} Excel rows</strong> per month, effective immediately.
                        </p>
                        {downgradeError && (
                            <p style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem', padding: '0.5rem 0.75rem', background: 'rgba(239,68,68,0.1)', borderRadius: '0.5rem', border: '1px solid rgba(239,68,68,0.3)' }}>
                                {downgradeError}
                            </p>
                        )}
                        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                            <button
                                onClick={() => setDowngradeTarget(null)}
                                disabled={downgradingPlan}
                                style={{ padding: '0.6rem 1.25rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--glass-border)', borderRadius: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', fontWeight: 600 }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmDowngrade}
                                disabled={downgradingPlan}
                                style={{ padding: '0.6rem 1.25rem', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '0.75rem', color: '#ef4444', cursor: 'pointer', fontWeight: 600, opacity: downgradingPlan ? 0.6 : 1 }}
                            >
                                {downgradingPlan ? 'Downgrading…' : `Yes, downgrade to ${downgradeTarget.name}`}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <style>{`
        .billing-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 2rem;
        }
        .pause-banner {
          display: flex;
          align-items: flex-start;
          gap: 1rem;
          padding: 1.25rem 1.5rem;
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.35);
          border-radius: 1rem;
          color: #ef4444;
          margin-bottom: 1.5rem;
        }
        .pause-banner svg { flex-shrink: 0; margin-top: 2px; }
        .pause-banner-text { flex: 1; line-height: 1.5; font-size: 0.9rem; }
        .pause-banner-text strong { font-size: 1rem; }
        .current-plan-card {
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 1.5rem;
          padding: 2rem;
          margin-bottom: 2rem;
        }
        .current-plan-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 1.5rem;
        }
        .current-plan-header h3 { margin-bottom: 0.5rem; }
        .reset-note {
          font-size: 0.8rem;
          color: var(--text-muted);
          margin-top: 0.4rem;
        }
        .status-badge {
          display: inline-block;
          padding: 0.25rem 0.75rem;
          border-radius: 1rem;
          font-size: 0.8rem;
          font-weight: 600;
        }
        .status-badge[data-status="trialing"] {
          background: rgba(245, 158, 11, 0.1);
          color: #f59e0b;
        }
        .status-badge[data-status="active"] {
          background: rgba(16, 185, 129, 0.1);
          color: #10b981;
        }
        .status-badge[data-status="enterprise"] {
          background: rgba(99, 102, 241, 0.12);
          color: #818cf8;
          border: 1px solid rgba(99, 102, 241, 0.3);
        }
        .status-badge[data-status="starter"] {
          background: rgba(245, 158, 11, 0.1);
          color: #f59e0b;
        }
        .status-badge[data-status="intermediate"] {
          background: rgba(16, 185, 129, 0.1);
          color: #10b981;
          border: 1px solid rgba(16, 185, 129, 0.3);
        }
        .quota-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1.5rem;
          margin-bottom: 0.5rem;
        }
        .quota-item { display: flex; flex-direction: column; gap: 0.5rem; }
        .quota-item-header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
        }
        .quota-label { font-size: 0.9rem; color: var(--text-muted); }
        .quota-value { font-size: 1rem; font-weight: 600; }
        .quota-bar {
          height: 8px;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 4px;
          overflow: hidden;
        }
        .quota-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--primary), var(--secondary));
          border-radius: 4px;
          transition: width 0.4s ease;
        }
        .addon-tracker {
          margin-top: 1rem;
          padding-top: 1rem;
          border-top: 1px solid var(--glass-border);
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .addon-tracker-label {
          display: flex;
          justify-content: space-between;
          font-size: 0.85rem;
          color: var(--text-muted);
        }
        .addon-fill {
          background: linear-gradient(90deg, #f59e0b, #ec4899) !important;
        }
        .plans-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 1.5rem;
          margin-bottom: 1.25rem;
        }
        @media (max-width: 1200px) {
          .plans-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 700px) {
          .plans-grid { grid-template-columns: 1fr; }
          .quota-grid { grid-template-columns: 1fr; }
          .addons-grid { grid-template-columns: 1fr; }
        }
        .plan-card {
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 1.5rem;
          padding: 2rem;
          display: flex;
          flex-direction: column;
          position: relative;
        }
        .plan-card--highlighted {
          border-color: var(--primary);
          background: linear-gradient(135deg, rgba(99,102,241,0.08), rgba(236,72,153,0.04));
        }
        .plan-card--current {
          border-color: #10b981;
          background: rgba(16, 185, 129, 0.05);
        }
        .plan-badge {
          position: absolute;
          top: -0.75rem;
          left: 50%;
          transform: translateX(-50%);
          padding: 0.2rem 0.9rem;
          background: linear-gradient(135deg, var(--primary), var(--secondary));
          border-radius: 1rem;
          font-size: 0.75rem;
          font-weight: 700;
          color: white;
          white-space: nowrap;
        }
        .plan-badge--current { background: linear-gradient(135deg, #10b981, #059669); }
        .plan-header { margin-bottom: 1.5rem; margin-top: 0.5rem; }
        .plan-header h4 { font-size: 1.25rem; margin-bottom: 0.5rem; }
        .plan-price { display: flex; align-items: baseline; gap: 0.25rem; }
        .price-amount { font-size: 2rem; font-weight: 700; color: var(--primary); }
        .price-period { color: var(--text-muted); }
        .plan-features { list-style: none; padding: 0; margin: 0 0 1.5rem 0; flex: 1; }
        .plan-features li {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.5rem 0;
          color: var(--text-muted);
        }
        .btn-primary {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 0.75rem 1.5rem;
          background: linear-gradient(135deg, var(--primary), var(--secondary));
          border: none;
          border-radius: 0.75rem;
          color: white;
          font-weight: 600;
          cursor: pointer;
          text-decoration: none;
          transition: opacity 0.2s;
        }
        .btn-primary:hover { opacity: 0.9; }
        .btn-plan { width: 100%; margin-top: auto; }
        .btn-current-plan {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 0.75rem 1.5rem;
          background: rgba(16, 185, 129, 0.1);
          border: 1px solid #10b981;
          border-radius: 0.75rem;
          color: #10b981;
          font-weight: 600;
          font-size: 0.9rem;
          margin-top: auto;
          width: 100%;
          cursor: default;
          opacity: 1;
        }
        .btn-secondary.btn-plan {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 0.75rem 1.5rem;
          background: rgba(255,255,255,0.05);
          border: 1px solid var(--glass-border);
          border-radius: 0.75rem;
          color: var(--text-muted);
          font-weight: 600;
          text-decoration: none;
          transition: opacity 0.2s;
          margin-top: auto;
        }
        .btn-secondary.btn-plan:hover { opacity: 0.8; }
        .downgrade-notice {
          text-align: center;
          color: var(--text-muted);
          font-size: 0.875rem;
          margin-bottom: 0;
        }
        .addons-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1.5rem;
          margin-bottom: 2rem;
        }
        .addon-card {
          background: rgba(255, 255, 255, 0.04);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 1.5rem;
          padding: 2rem;
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
        }
        .addon-description { color: var(--text-muted); font-size: 0.875rem; margin-top: 0.25rem; }
        .addon-card-top { margin-bottom: 1.25rem; }
        .addon-card-top h4 { font-size: 1.1rem; }
        .addon-pills {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 1.25rem;
        }
        .addon-pill {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.25rem;
          padding: 0.85rem 0.5rem;
          background: rgba(255, 255, 255, 0.04);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 0.9rem;
          cursor: pointer;
          transition: all 0.2s;
          color: var(--text-muted);
          box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        }
        .addon-pill:hover {
          border-color: var(--primary);
          color: var(--primary);
          background: rgba(99,102,241,0.1);
          box-shadow: 0 4px 16px rgba(99,102,241,0.2);
          transform: translateY(-1px);
        }
        .addon-pill.active {
          border-color: var(--primary);
          background: rgba(99, 102, 241, 0.18);
          color: var(--primary);
          box-shadow: 0 4px 20px rgba(99,102,241,0.3);
          transform: translateY(-1px);
        }
        .pill-qty { font-size: 1rem; font-weight: 700; }
        .pill-price { font-size: 0.78rem; font-weight: 500; opacity: 0.85; }
        .addon-summary {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.75rem 1rem;
          background: rgba(99, 102, 241, 0.07);
          border: 1px solid rgba(99, 102, 241, 0.18);
          border-radius: 0.75rem;
          margin-bottom: 1rem;
        }
        .addon-summary-label { font-size: 0.85rem; color: var(--text-muted); }
        .addon-summary-price { font-size: 1.4rem; font-weight: 700; color: var(--primary); }
        .addon-purchase-btn {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          text-decoration: none;
        }
        .test-section {
          margin-top: 2.5rem;
          padding: 1.75rem 2rem;
          background: rgba(245, 158, 11, 0.05);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px dashed rgba(245, 158, 11, 0.4);
          border-radius: 1.5rem;
        }
        .test-section-header {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          margin-bottom: 0.75rem;
          color: #f59e0b;
        }
        .test-section-header h3 {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          margin: 0;
          color: #f59e0b;
        }
        .admin-badge {
          font-size: 0.7rem;
          font-weight: 700;
          padding: 0.15rem 0.55rem;
          background: rgba(245, 158, 11, 0.15);
          border: 1px solid rgba(245, 158, 11, 0.4);
          border-radius: 0.5rem;
          color: #f59e0b;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .test-section-desc {
          font-size: 0.875rem;
          color: var(--text-muted);
          margin-bottom: 1.25rem;
          line-height: 1.6;
        }
        .test-section-desc code {
          background: rgba(255,255,255,0.08);
          padding: 0.1rem 0.4rem;
          border-radius: 0.35rem;
          font-size: 0.85rem;
          color: var(--text);
        }
        .test-payments-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1rem;
        }
        @media (max-width: 700px) {
          .test-payments-grid { grid-template-columns: 1fr; }
        }
        .test-payment-card {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 1.25rem 1.5rem;
          background: rgba(255, 255, 255, 0.04);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid rgba(245, 158, 11, 0.2);
          border-radius: 1rem;
        }
        .test-payment-info { flex: 1; }
        .test-type-badge {
          display: inline-block;
          font-size: 0.68rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          padding: 0.15rem 0.5rem;
          border-radius: 0.4rem;
          margin-bottom: 0.4rem;
        }
        .test-type-badge--subscription {
          background: rgba(99, 102, 241, 0.15);
          color: var(--primary);
          border: 1px solid rgba(99, 102, 241, 0.3);
        }
        .test-type-badge--addon {
          background: rgba(16, 185, 129, 0.12);
          color: #10b981;
          border: 1px solid rgba(16, 185, 129, 0.3);
        }
        .test-payment-label {
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--text);
          margin: 0 0 0.2rem 0;
        }
        .test-payment-desc {
          font-size: 0.78rem;
          color: var(--text-muted);
          margin: 0;
        }
        .btn-test {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.55rem 1rem;
          background: rgba(245, 158, 11, 0.1);
          border: 1px solid rgba(245, 158, 11, 0.4);
          border-radius: 0.75rem;
          color: #f59e0b;
          font-size: 0.82rem;
          font-weight: 600;
          text-decoration: none;
          white-space: nowrap;
          transition: all 0.2s;
        }
        .btn-test:hover {
          background: rgba(245, 158, 11, 0.18);
          box-shadow: 0 4px 14px rgba(245, 158, 11, 0.2);
        }
        .btn-simulate {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.55rem 1rem;
          background: rgba(16, 185, 129, 0.1);
          border: 1px solid rgba(16, 185, 129, 0.4);
          border-radius: 0.75rem;
          color: #10b981;
          font-size: 0.82rem;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.2s;
        }
        .btn-simulate:hover {
          background: rgba(16, 185, 129, 0.18);
          box-shadow: 0 4px 14px rgba(16, 185, 129, 0.2);
        }
        .btn-simulate:disabled { opacity: 0.5; cursor: default; }
        .adjust-section {
          margin-top: 2rem;
          padding: 1.75rem 2rem;
          background: rgba(99, 102, 241, 0.04);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px dashed rgba(99, 102, 241, 0.35);
          border-radius: 1.5rem;
        }
        .adjust-section input:focus {
          border-color: var(--primary);
          box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
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
          max-width: 480px;
        }
      `}</style>
        </div>
    );
}

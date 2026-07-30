import React, { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import {
    LayoutDashboard,
    CreditCard,
    HelpCircle,
    LogOut,
    ChevronDown,
    Building2,
    User as UserIcon,
    Users as UsersIcon,
    AlertTriangle,
    Upload,
    ShieldCheck,
} from 'lucide-react';

interface LayoutProps {
    children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
    const { user, tenants, activeTenant, logout, switchTenant, isAdmin, isSuperAdmin } = useAuth();
    const { t, language, setLanguage } = useLanguage();
    const [showTenantMenu, setShowTenantMenu] = useState(false);
    const [scenariosPaused, setScenariosPaused] = useState(false);
    const navigate = useNavigate();

    useEffect(() => {
        let cancelled = false;
        let interval: ReturnType<typeof setInterval>;

        const fetchPauseStatus = async () => {
            try {
                const res = await axios.get('/v1/billing/usage-status');
                if (!cancelled) setScenariosPaused(res.data.scenariosPaused ?? false);
            } catch (err: any) {
                // Token expired or invalid — stop polling to avoid log spam
                if (err?.response?.status === 401 || err?.response?.status === 403) {
                    clearInterval(interval);
                }
            }
        };

        fetchPauseStatus();
        interval = setInterval(fetchPauseStatus, 60_000);
        return () => { cancelled = true; clearInterval(interval); };
    }, []);

    const handleLogout = () => {
        logout();
        navigate('/');
    };

    const handleTenantSwitch = async (tenantId: string) => {
        await switchTenant(tenantId);
        setShowTenantMenu(false);
        window.location.reload();
    };

    return (
        <div className="app-container">
            {/* Header */}
            <header className="header">
                <div className="brand">
                    <img src={`${import.meta.env.BASE_URL}acctos-ai-logo.svg`} alt="Acctos AI" className="brand-logo" />
                    <div>
                        <h1>Acctos AI</h1>
                        <p>{t.poweredBy}</p>
                    </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    {/* Language Switcher */}
                    <div className="lang-switcher">
                        <button
                            className={`lang-btn ${language === 'en' ? 'active' : ''}`}
                            onClick={() => setLanguage('en')}
                        >
                            {t.langEn}
                        </button>
                        <span className="lang-divider">|</span>
                        <button
                            className={`lang-btn ${language === 'bg' ? 'active' : ''}`}
                            onClick={() => setLanguage('bg')}
                        >
                            {t.langBg}
                        </button>
                    </div>

                    {/* Tenant Switcher */}
                    {tenants.length > 1 && (
                        <div className="tenant-switcher">
                            <button
                                className="tenant-btn"
                                onClick={() => setShowTenantMenu(!showTenantMenu)}
                            >
                                <Building2 size={16} />
                                <span>{activeTenant?.name || t.selectTenant}</span>
                                <ChevronDown size={14} />
                            </button>
                            {showTenantMenu && (
                                <div className="tenant-menu">
                                    {tenants.map((tenant) => (
                                        <button
                                            key={tenant.id}
                                            className={`tenant-option ${tenant.id === activeTenant?.id ? 'active' : ''}`}
                                            onClick={() => handleTenantSwitch(tenant.id)}
                                        >
                                            <Building2 size={14} />
                                            <span>{tenant.name}</span>
                                            <span className="role-badge">{tenant.role}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* User Badge */}
                    <div className="user-badge">
                        <UserIcon size={14} />
                        <span>{user?.name || user?.email}</span>
                    </div>

                    {/* Logout */}
                    <button className="card btn-icon logout-btn" onClick={handleLogout} title={t.logout}>
                        <LogOut size={18} />
                    </button>
                </div>
            </header>

            {/* Usage limit notification banner */}
            {scenariosPaused && (
                <div className="usage-limit-banner">
                    <AlertTriangle size={22} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div className="usage-limit-banner-body">
                        <strong>{t.bannerTitle}</strong>
                        <p>{t.bannerBody}</p>
                        <ul>
                            <li>{t.bannerOption1}</li>
                            <li>{t.bannerOption2}</li>
                        </ul>
                        <p>{t.bannerFooter}</p>
                    </div>
                </div>
            )}

            {/* Main Layout */}
            <div className="main-layout">
                {/* Sidebar Navigation */}
                <nav className="sidebar">
                    <NavLink to="/home" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                        <LayoutDashboard size={20} />
                        <span>{t.navUsage}</span>
                    </NavLink>
                    <NavLink to="/billing" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                        <CreditCard size={20} />
                        <span>{t.navBilling}</span>
                    </NavLink>
                    <NavLink to="/tickets" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                        <HelpCircle size={20} />
                        <span>{t.navSupport}</span>
                    </NavLink>
                    {isAdmin && (
                        <NavLink to="/users" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                            <UsersIcon size={20} />
                            <span>{t.navUsers}</span>
                        </NavLink>
                    )}
                    <NavLink to="/import" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                        <Upload size={20} />
                        <span>{t.navImport}</span>
                    </NavLink>
                    {isSuperAdmin && (
                        <NavLink to="/superadmin" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} style={{ marginTop: 'auto' }}>
                            <ShieldCheck size={20} />
                            <span>Super Admin</span>
                        </NavLink>
                    )}
                </nav>

                {/* Content */}
                <main className="main-content">
                    {children}
                </main>
            </div>

            <style>{`
        .brand { display: flex; align-items: flex-start; gap: 0.75rem; }
        .brand-logo { height: 2rem; width: auto; object-fit: contain; display: block; margin-top: 4px; filter: drop-shadow(0 0 12px rgba(99, 102, 241, 0.5)) drop-shadow(0 0 4px rgba(236, 72, 153, 0.3)); }

        .lang-switcher {
          display: flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.3rem 0.6rem;
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 0.65rem;
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.05em;
        }
        .lang-btn {
          background: none;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          padding: 0.1rem 0.3rem;
          border-radius: 0.35rem;
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.05em;
          transition: all 0.15s;
        }
        .lang-btn:hover { color: var(--text); }
        .lang-btn.active {
          color: var(--primary);
          background: rgba(99,102,241,0.12);
        }
        .lang-divider {
          color: var(--glass-border);
          font-size: 0.7rem;
          user-select: none;
        }

        .usage-limit-banner {
          display: flex;
          align-items: flex-start;
          gap: 1rem;
          padding: 1.1rem 1.75rem;
          background: rgba(245, 158, 11, 0.1);
          border-bottom: 1px solid rgba(245, 158, 11, 0.35);
          color: #f59e0b;
          font-size: 0.9rem;
          line-height: 1.5;
        }
        .usage-limit-banner-body strong {
          display: block;
          font-size: 0.95rem;
          margin-bottom: 0.35rem;
        }
        .usage-limit-banner-body p {
          margin: 0.25rem 0;
        }
        .usage-limit-banner-body ul {
          margin: 0.2rem 0 0.25rem 1.25rem;
          padding: 0;
        }
        .usage-limit-banner-body ul li {
          margin-bottom: 0.15rem;
        }
        .main-layout {
          display: flex;
          flex: 1;
          overflow: hidden;
        }
        .sidebar {
          width: 200px;
          background: var(--surface);
          border-right: 1px solid var(--glass-border);
          padding: 1.5rem 1rem;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .nav-item {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.75rem 1rem;
          border-radius: 0.75rem;
          color: var(--text-muted);
          text-decoration: none;
          transition: all 0.2s;
        }
        .nav-item:hover {
          background: rgba(255, 255, 255, 0.05);
          color: var(--text);
        }
        .nav-item.active {
          background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(236, 72, 153, 0.1));
          color: var(--primary);
        }
        .main-content {
          flex: 1;
          padding: 2rem;
          overflow-y: auto;
        }
        .tenant-switcher {
          position: relative;
        }
        .tenant-btn {
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
        .tenant-btn:hover {
          border-color: var(--primary);
        }
        .tenant-menu {
          position: absolute;
          top: 100%;
          right: 0;
          margin-top: 0.5rem;
          min-width: 200px;
          background: var(--surface);
          border: 1px solid var(--glass-border);
          border-radius: 0.75rem;
          padding: 0.5rem;
          z-index: 100;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
        }
        .tenant-option {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          width: 100%;
          padding: 0.75rem;
          background: none;
          border: none;
          border-radius: 0.5rem;
          color: var(--text-muted);
          cursor: pointer;
          text-align: left;
        }
        .tenant-option:hover {
          background: rgba(255, 255, 255, 0.05);
          color: var(--text);
        }
        .tenant-option.active {
          background: rgba(99, 102, 241, 0.1);
          color: var(--primary);
        }
        .role-badge {
          margin-left: auto;
          font-size: 0.7rem;
          padding: 0.2rem 0.5rem;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 0.25rem;
          text-transform: uppercase;
        }
        .user-badge {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.3rem 0.8rem;
          background: rgba(99, 102, 241, 0.1);
          border: 1px solid var(--primary);
          border-radius: 1rem;
          font-size: 0.8rem;
          color: var(--primary);
          font-weight: 600;
        }
        .btn-icon {
          padding: 0.8rem;
          margin-bottom: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          border-radius: 1rem;
        }
        .logout-btn {
          color: var(--danger);
        }
      `}</style>
        </div>
    );
}

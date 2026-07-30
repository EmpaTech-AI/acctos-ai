import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import LandingPage from './pages/LandingPage';
import Dashboard from './pages/Dashboard';
import Billing from './pages/Billing';
import Tickets from './pages/Tickets';
import Users from './pages/Users';
import ImportFile from './pages/ImportFile';
import SuperAdmin from './pages/SuperAdmin';
import Layout from './components/Layout';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
    const { token, isLoading } = useAuth();

    if (isLoading) {
        return (
            <div className="loading-container">
                <div className="spinner"></div>
                <p style={{ marginTop: '1rem', color: 'var(--text-muted)' }}>Loading...</p>
            </div>
        );
    }

    if (!token) {
        return <Navigate to="/" replace />;
    }

    return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
    const { isAdmin, isLoading } = useAuth();

    if (isLoading) {
        return (
            <div className="loading-container">
                <div className="spinner"></div>
                <p style={{ marginTop: '1rem', color: 'var(--text-muted)' }}>Loading...</p>
            </div>
        );
    }

    if (!isAdmin) {
        return <Navigate to="/home" replace />;
    }

    return <>{children}</>;
}

function SuperAdminRoute({ children }: { children: React.ReactNode }) {
    const { isSuperAdmin, isLoading } = useAuth();

    if (isLoading) {
        return (
            <div className="loading-container">
                <div className="spinner"></div>
            </div>
        );
    }

    if (!isSuperAdmin) {
        return <Navigate to="/home" replace />;
    }

    return <>{children}</>;
}

function AppRoutes() {
    const { token, isLoading } = useAuth();

    if (isLoading) {
        return (
            <div className="loading-container">
                <div className="spinner"></div>
            </div>
        );
    }

    return (
        <Routes>
            <Route
                path="/"
                element={token ? <Navigate to="/home" replace /> : <LandingPage />}
            />
            <Route
                path="/home"
                element={
                    <ProtectedRoute>
                        <Layout>
                            <Dashboard />
                        </Layout>
                    </ProtectedRoute>
                }
            />
            <Route
                path="/billing"
                element={
                    <ProtectedRoute>
                        <Layout>
                            <Billing />
                        </Layout>
                    </ProtectedRoute>
                }
            />
            <Route
                path="/tickets"
                element={
                    <ProtectedRoute>
                        <Layout>
                            <Tickets />
                        </Layout>
                    </ProtectedRoute>
                }
            />
            <Route
                path="/tickets/:id"
                element={
                    <ProtectedRoute>
                        <Layout>
                            <Tickets />
                        </Layout>
                    </ProtectedRoute>
                }
            />
            <Route
                path="/users"
                element={
                    <ProtectedRoute>
                        <AdminRoute>
                            <Layout>
                                <Users />
                            </Layout>
                        </AdminRoute>
                    </ProtectedRoute>
                }
            />
            <Route
                path="/import"
                element={
                    <ProtectedRoute>
                        <Layout>
                            <ImportFile />
                        </Layout>
                    </ProtectedRoute>
                }
            />
            <Route
                path="/superadmin"
                element={
                    <ProtectedRoute>
                        <SuperAdminRoute>
                            <Layout>
                                <SuperAdmin />
                            </Layout>
                        </SuperAdminRoute>
                    </ProtectedRoute>
                }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}

import { ErrorBoundary } from './components/ErrorBoundary';
import { LanguageProvider } from './context/LanguageContext';

function App() {
    return (
        <ErrorBoundary>
            <LanguageProvider>
                <BrowserRouter basename="/dashboard">
                    <AuthProvider>
                        <AppRoutes />
                    </AuthProvider>
                </BrowserRouter>
            </LanguageProvider>
        </ErrorBoundary>
    );
}

export default App;

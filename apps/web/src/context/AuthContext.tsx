import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';

// Types
interface User {
    id: string;
    email: string;
    name?: string;
}

interface Tenant {
    id: string;
    name: string;
    slug: string;
    role: string;
}

interface AuthContextType {
    user: User | null;
    tenants: Tenant[];
    activeTenant: Tenant | null;
    token: string | null;
    isLoading: boolean;
    currentRole: string | null;
    isAdmin: boolean;
    isUser: boolean;
    isSuperAdmin: boolean;
    login: (email: string, password: string) => Promise<void>;
    register: (email: string, password: string, name: string, tenantName: string) => Promise<void>;
    logout: () => void;
    switchTenant: (tenantId: string) => Promise<void>;
}

const ADMIN_ROLES = ['ORG_OWNER', 'ADMIN'];

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within AuthProvider');
    }
    return context;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [tenants, setTenants] = useState<Tenant[]>([]);
    const [activeTenant, setActiveTenant] = useState<Tenant | null>(null);
    const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
    const [isLoading, setIsLoading] = useState(true);
    const [currentRole, setCurrentRole] = useState<string | null>(null);

    const isAdmin = currentRole !== null && ADMIN_ROLES.includes(currentRole);
    const isUser = currentRole === 'MEMBER';
    const isSuperAdmin = user?.email === (import.meta.env.VITE_SUPERADMIN_EMAIL ?? '');

    // Configure axios defaults
    useEffect(() => {
        if (token) {
            axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
            localStorage.setItem('token', token);
        } else {
            delete axios.defaults.headers.common['Authorization'];
            localStorage.removeItem('token');
        }
    }, [token]);

    // Global interceptor: if any API call returns 403 FORBIDDEN (invalid/expired token),
    // clear the session and leave a message so the login page can display it.
    useEffect(() => {
        const id = axios.interceptors.response.use(
            res => res,
            err => {
                const code = err?.response?.data?.code;
                const status = err?.response?.status;
                if (status === 403 && (code === 'FORBIDDEN' || code === 'UNAUTHORIZED')) {
                    sessionStorage.setItem('auth_notice', 'Session expired — please log in again.');
                    setToken(null);
                    setUser(null);
                    setTenants([]);
                    setActiveTenant(null);
                    setCurrentRole(null);
                    delete axios.defaults.headers.common['Authorization'];
                }
                return Promise.reject(err);
            }
        );
        return () => axios.interceptors.response.eject(id);
    }, []);

    // Load user on mount
    const loadUser = useCallback(async () => {
        if (!token) {
            setIsLoading(false);
            return;
        }

        try {
            const response = await axios.get('/api/auth/me');
            setUser({
                id: response.data.id,
                email: response.data.email,
                name: response.data.name,
            });
            setTenants(response.data.tenants);
            setCurrentRole(response.data.currentRole);

            // Set active tenant
            const activeTenantId = response.data.activeTenant;
            const active = response.data.tenants.find((t: Tenant) => t.id === activeTenantId);
            setActiveTenant(active || response.data.tenants[0] || null);
        } catch (error) {
            console.error('Failed to load user:', error);
            setToken(null);
        } finally {
            setIsLoading(false);
        }
    }, [token]);

    useEffect(() => {
        loadUser();
    }, [loadUser]);

    const login = async (email: string, password: string) => {
        const response = await axios.post('/api/auth/login', { email, password });
        axios.defaults.headers.common['Authorization'] = `Bearer ${response.data.token}`;
        setToken(response.data.token);
        setUser({
            id: response.data.user.id,
            email: response.data.user.email,
            name: response.data.user.name,
        });
        setTenants(response.data.tenants);
        const active = response.data.tenants.find((t: Tenant) => t.id === response.data.activeTenant);
        setActiveTenant(active || response.data.tenants[0] || null);
        // Set role from the active tenant's membership
        if (active) {
            setCurrentRole(active.role);
        }
    };

    const register = async (email: string, password: string, name: string, tenantName: string) => {
        await axios.post('/api/auth/register', { email, password, name, tenantName });
    };

    const logout = () => {
        delete axios.defaults.headers.common['Authorization'];
        setToken(null);
        setUser(null);
        setTenants([]);
        setActiveTenant(null);
        setCurrentRole(null);
    };

    const switchTenant = async (tenantId: string) => {
        const response = await axios.post('/api/auth/switch-tenant', { tenantId });
        axios.defaults.headers.common['Authorization'] = `Bearer ${response.data.token}`;
        setToken(response.data.token);
        setActiveTenant(response.data.tenant);
        setCurrentRole(response.data.tenant.role);
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                tenants,
                activeTenant,
                token,
                isLoading,
                currentRole,
                isAdmin,
                isUser,
                isSuperAdmin,
                login,
                register,
                logout,
                switchTenant,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

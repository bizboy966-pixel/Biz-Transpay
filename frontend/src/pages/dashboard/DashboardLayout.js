import { useState } from 'react';
import { NavLink, Outlet, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Home, Receipt, Link2, Code2, IdCard, Settings as SettingsIcon, Headphones, Menu, ChevronDown, LogOut, X } from 'lucide-react';
import { Logo } from '@/components/Logo';
import NotificationBell from '@/components/NotificationBell';
import { useAuth } from '@/context/AuthContext';

export default function DashboardLayout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const loc = useLocation();

  const initials = (user?.full_name || 'U').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();

  const nav = [
    { to: '/dashboard', end: true, i: Home, l: t('dashboard.title') },
    { to: '/dashboard/transactions', i: Receipt, l: t('dashboard.transactions'), sub: t('dashboard.history') },
    { to: '/dashboard/links', i: Link2, l: t('dashboard.payment_link') },
    { to: '/dashboard/kyc', i: IdCard, l: t('dashboard.kyc') },
  ];
  const nav2 = [
    { to: '/dashboard/settings', i: SettingsIcon, l: t('dashboard.settings') },
    { to: '/dashboard/support', i: Headphones, l: t('dashboard.support') },
  ];

  return (
    <div className="min-h-screen bg-slate-50" data-testid="dashboard-layout">
      {/* Sidebar */}
      <aside className={`fixed top-0 left-0 z-40 h-screen bg-white border-r border-slate-200 transition-transform duration-300 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} w-64`} data-testid="sidebar">
        <div className="h-16 flex items-center gap-2 px-4 border-b border-slate-100">
          <Logo />
          <button onClick={() => setSidebarOpen(false)} className="ml-auto lg:hidden w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center" data-testid="sidebar-close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="p-3 space-y-0.5">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} data-testid={`sidenav-${n.to.replace(/\//g, '-')}`}
              className={({ isActive }) => `flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                isActive ? 'bg-blue-50 text-[#2563EB]' : 'text-slate-700 hover:bg-slate-50'
              }`}>
              <n.i className="w-4 h-4" strokeWidth={1.75} />
              <div>
                <div>{n.l}</div>
                {n.sub && <div className="text-[10px] text-slate-400 font-normal">{n.sub}</div>}
              </div>
            </NavLink>
          ))}
          <div className="my-3 border-t border-slate-100" />
          {nav2.map((n) => (
            <NavLink key={n.to} to={n.to} data-testid={`sidenav-${n.to.replace(/\//g, '-')}`}
              className={({ isActive }) => `flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                isActive ? 'bg-blue-50 text-[#2563EB]' : 'text-slate-700 hover:bg-slate-50'
              }`}>
              <n.i className="w-4 h-4" strokeWidth={1.75} />
              {n.l}
            </NavLink>
          ))}
        </nav>

        <div className="absolute bottom-0 left-0 right-0 p-4">
          <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-xl">
            <div className="w-10 h-10 rounded-xl bg-white shadow-sm flex items-center justify-center">
              <span className="text-[#2563EB] font-cabinet font-extrabold text-lg">B</span>
            </div>
            <div>
              <div className="font-cabinet font-bold text-sm text-slate-900">Biz-transPay</div>
              <div className="text-[10px] text-slate-500 font-semibold">Sécurisé. Rapide. Fiable.</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Overlay for mobile */}
      {sidebarOpen && (
        <div onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" />
      )}

      {/* Topbar */}
      <div className={`transition-[padding] duration-300 ${sidebarOpen ? 'lg:pl-64' : 'lg:pl-0'}`}>
        <header className="sticky top-0 z-30 bg-white/85 backdrop-blur-md border-b border-slate-200 h-16 flex items-center px-5 gap-3" data-testid="dashboard-topbar">
          <button onClick={() => setSidebarOpen((v) => !v)} data-testid="btn-toggle-sidebar" className="w-10 h-10 rounded-lg border border-slate-200 flex items-center justify-center hover:bg-slate-50 transition-colors">
            <Menu className="w-4 h-4" />
          </button>

          <div className="hidden md:block">
            <div className="font-cabinet font-extrabold text-slate-900 text-sm">
              {nav.concat(nav2).find((n) => (n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to)))?.l || 'Biz-trans'}
            </div>
            <div className="text-[10px] text-slate-500 font-medium">Passerelle de paiement</div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <NotificationBell />
            <div className="relative">
              <button onClick={() => setProfileOpen((v) => !v)} data-testid="btn-profile" className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full hover:bg-slate-100 transition-colors">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white flex items-center justify-center font-bold text-xs">{initials}</div>
                <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
              </button>
              {profileOpen && (
                <div className="absolute right-0 mt-2 min-w-[200px] bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
                  <div className="p-3 border-b border-slate-100">
                    <div className="font-semibold text-slate-900 text-sm">{user?.full_name}</div>
                    <div className="text-xs text-slate-500">@{user?.username}</div>
                  </div>
                  {(user?.role === 'admin' || user?.role === 'super_admin') && (
                    <Link to="/admin" className="block px-4 py-2 text-sm font-semibold text-[#2563EB] hover:bg-blue-50" data-testid="menu-admin">🛡️ Admin Panel</Link>
                  )}
                  <Link to="/dashboard/settings" className="block px-4 py-2 text-sm hover:bg-slate-50" data-testid="menu-settings">{t('dashboard.settings')}</Link>
                  <button onClick={logout} data-testid="btn-logout" className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2">
                    <LogOut className="w-3.5 h-3.5" /> {t('common.logout')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="p-5 sm:p-6 max-w-6xl mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

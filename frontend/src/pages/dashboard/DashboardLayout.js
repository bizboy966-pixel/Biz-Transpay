import { useEffect, useState } from 'react';
import { NavLink, Outlet, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Home, Receipt, ScanLine, LayoutGrid, UserRound, IdCard, WalletCards, Menu, ChevronDown, LogOut, X } from 'lucide-react';
import { Logo } from '@/components/Logo';
import NotificationBell from '@/components/NotificationBell';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import FloatingSupportButtons from '@/components/FloatingSupportButtons';
import SocialChannelsBanner from '@/components/SocialChannelsBanner';
import { useAuth } from '@/context/AuthContext';

export default function DashboardLayout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  // Sidebar closed by default on mobile so the dashboard content is visible
  // immediately after login. Open on desktop for productivity.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.innerWidth >= 1024;
  });
  const [profileOpen, setProfileOpen] = useState(false);
  const loc = useLocation();

  // Auto-close the sidebar on route change on mobile so a nav click doesn't
  // leave the drawer covering the destination page.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setSidebarOpen(false);
    }
  }, [loc.pathname]);

  const initials = (user?.full_name || 'U').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();

  const nav = [
    { to: '/dashboard', end: true, i: Home, l: t('dashboard.title') },
    { to: '/dashboard/kyc', i: IdCard, l: t('dashboard.kyc') },
    { to: '/dashboard/fees', i: WalletCards, l: t('dashboard.fees') },
  ];
  const bottomNav = [
    { to: '/dashboard', end: true, i: Home, l: t('dashboard.bottom_home') },
    { to: '/dashboard/transactions', i: Receipt, l: t('dashboard.transactions') },
    { to: '/dashboard/deposit', i: ScanLine, l: t('dashboard.deposit'), prominent: true },
    { to: '/dashboard/services', i: LayoutGrid, l: t('dashboard.services') },
    { to: '/dashboard/profile', i: UserRound, l: t('dashboard.profile') },
  ];

  return (
    <div className="bt-shell" data-testid="dashboard-layout">
      {/* Sidebar */}
      <aside className={`bt-sidebar bt-dashboard-sidebar fixed top-0 left-0 z-40 lg:h-[100dvh] border-r transition-transform duration-300 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} w-64`} data-testid="sidebar">
        <div className="h-16 flex items-center gap-2 px-4 border-b border-slate-100">
          <Logo />
          <button onClick={() => setSidebarOpen(false)} className="ml-auto lg:hidden w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center" data-testid="sidebar-close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="p-3 space-y-0.5">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}
              onClick={() => {
                if (typeof window !== 'undefined' && window.innerWidth < 1024) setSidebarOpen(false);
              }}
              data-testid={`sidenav-${n.to.replace(/\//g, '-')}`}
              className={({ isActive }) => `bt-sidebar-link flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                isActive ? 'active' : ''
              }`}>
              <n.i className="w-4 h-4" strokeWidth={1.75} />
              <div>
                <div>{n.l}</div>
                {n.sub && <div className="text-[10px] text-slate-400 font-normal">{n.sub}</div>}
              </div>
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Overlay for mobile */}
      {sidebarOpen && (
        <div onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" />
      )}

      {/* Topbar */}
      <div className={`transition-[padding] duration-300 ${sidebarOpen ? 'lg:pl-64' : 'lg:pl-0'}`}>
        <header className="bt-topbar sticky top-0 z-30 border-b min-h-[72px] flex flex-wrap items-center px-3 sm:px-5 gap-2 sm:gap-3" data-testid="dashboard-topbar">
          <button onClick={() => setSidebarOpen((v) => !v)} data-testid="btn-toggle-sidebar" className="h-9 w-9 sm:h-10 sm:w-10 shrink-0 rounded-lg border border-slate-200 flex items-center justify-center hover:bg-slate-50 transition-colors">
            <Menu className="w-4 h-4" />
          </button>

          <div className="hidden md:block">
            <div className="font-cabinet font-extrabold text-slate-900 text-sm">
              {bottomNav.concat(nav).find((n) => (n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to)))?.l || 'Biz-trans'}
            </div>
            <div className="text-[10px] text-slate-500 font-medium">Passerelle de paiement</div>
          </div>

          <div className="order-last basis-full min-w-0 flex flex-1 justify-center border-t border-blue-100 pt-2 sm:order-none sm:basis-auto sm:border-t-0 sm:pt-0 px-0 sm:px-2">
            <SocialChannelsBanner />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <NotificationBell compact />
            <LanguageSwitcher compact className="bt-topbar-language" />
            <div className="relative">
              <button onClick={() => setProfileOpen((v) => !v)} data-testid="btn-profile" className="flex items-center gap-1 pl-0.5 pr-1.5 py-1 sm:gap-1.5 sm:pl-1 sm:pr-2.5 rounded-full hover:bg-slate-100 transition-colors">
                {user?.avatar_url ? (
                  <img src={user.avatar_url} alt={`Photo de ${user?.full_name || 'profil'}`} className="h-7 w-7 sm:h-8 sm:w-8 rounded-full object-cover border border-white shadow-sm" />
                ) : (
                  <div className="h-7 w-7 sm:h-8 sm:w-8 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white flex items-center justify-center font-bold text-xs">{initials}</div>
                )}
                <ChevronDown className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-slate-500" />
              </button>
              {profileOpen && (
                <div className="absolute right-0 mt-2 min-w-[200px] bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
                  <div className="p-3 border-b border-slate-100">
                    <div className="font-semibold text-slate-900 text-sm">{user?.full_name}</div>
                    <div className="text-xs text-slate-500">@{user?.username}</div>
                  </div>
                  {(user?.role === 'admin' || user?.role === 'super_admin') && (
                   <Link to="/admin" className="block px-4 py-2 text-sm font-semibold text-[#2563EB] hover:bg-blue-50" data-testid="menu-admin">Admin Panel</Link>
                  )}
                  <button onClick={logout} data-testid="btn-logout" className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2">
                    <LogOut className="w-3.5 h-3.5" /> {t('common.logout')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

            <main className="bt-content p-5 sm:p-7 pb-24 lg:pb-7">
          <Outlet />
        </main>
      </div>
      <nav className="bt-bottom-nav lg:hidden" aria-label="Navigation principale">
        {bottomNav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            data-testid={`bottomnav-${n.l.toLowerCase()}`}
            className={({ isActive }) => `bt-bottom-nav__item ${n.prominent ? 'bt-bottom-nav__item--prominent' : ''} ${isActive ? 'active' : ''}`}
          >
            <span className="bt-bottom-nav__icon">
              <n.i strokeWidth={n.prominent ? 2 : 1.8} />
            </span>
            <span>{n.l}</span>
          </NavLink>
        ))}
      </nav>
      <FloatingSupportButtons />
    </div>
  );
}

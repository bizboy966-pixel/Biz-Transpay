import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Home, Receipt, ScanLine, LayoutGrid, UserRound, IdCard, WalletCards, Menu, ChevronDown, LogOut, X } from 'lucide-react';
import { toast } from 'sonner';
import { Logo } from '@/components/Logo';
import { SafeImage } from '@/components/SafeImage';
import NotificationBell from '@/components/NotificationBell';
import PwaInstallPrompt from '@/components/PwaInstallPrompt';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import FloatingSupportButtons from '@/components/FloatingSupportButtons';
import SocialChannelsBanner from '@/components/SocialChannelsBanner';
import { useAuth } from '@/context/AuthContext';
import { prefetchPageForRoute } from '@/pageLoaders';

export default function DashboardLayout() {
  const { t } = useTranslation();
  const { user, logout, unlockAdminPanel } = useAuth();
  const navigate = useNavigate();
  // Sidebar closed by default on mobile so the dashboard content is visible
  // immediately after login. Open on desktop for productivity.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.innerWidth >= 1024;
  });
  const [profileOpen, setProfileOpen] = useState(false);
  const [adminUnlockOpen, setAdminUnlockOpen] = useState(false);
  const [adminOtp, setAdminOtp] = useState('');
  const [adminUnlocking, setAdminUnlocking] = useState(false);
  const usernameClickState = useRef({ count: 0, startedAt: 0 });
  const loc = useLocation();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  const handleUsernameClick = () => {
    if (!isAdmin) return;
    const now = Date.now();
    if (!usernameClickState.current.startedAt || now - usernameClickState.current.startedAt > 10_000) {
      usernameClickState.current = { count: 0, startedAt: now };
    }
    usernameClickState.current.count += 1;
    if (usernameClickState.current.count >= 4) {
      usernameClickState.current = { count: 0, startedAt: 0 };
      setProfileOpen(false);
      setAdminOtp('');
      setAdminUnlockOpen(true);
    }
  };

  const verifyAdminPanel = async (event) => {
    event.preventDefault();
    setAdminUnlocking(true);
    try {
      await unlockAdminPanel(adminOtp);
      setAdminUnlockOpen(false);
      setAdminOtp('');
      navigate('/admin');
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : detail?.message || 'Code de vérification invalide.');
      setAdminOtp('');
    } finally {
      setAdminUnlocking(false);
    }
  };

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
    { to: '/dashboard', end: true, i: Home, image: '/images/home-dashboard-icon.webp', l: t('dashboard.bottom_home') },
    { to: '/dashboard/transactions', i: Receipt, image: '/images/transactions-dashboard-icon.webp', l: t('dashboard.transactions') },
    { to: '/dashboard/deposit', i: ScanLine, image: '/images/deposit-dashboard-icon.webp', l: t('dashboard.deposit'), prominent: true },
    {
      to: '/dashboard/services',
      i: LayoutGrid,
      image: '/images/services-dashboard-icon.webp',
      l: t('dashboard.services'),
      activePaths: ['/dashboard/links'],
    },
    { to: '/dashboard/profile', i: UserRound, image: '/images/profile-dashboard-icon.webp', l: t('dashboard.profile') },
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
              onMouseEnter={() => prefetchPageForRoute(n.to)}
              onFocus={() => prefetchPageForRoute(n.to)}
              onTouchStart={() => prefetchPageForRoute(n.to)}
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
              {bottomNav.concat(nav).find((n) => (
                n.end
                  ? loc.pathname === n.to
                  : loc.pathname.startsWith(n.to) || n.activePaths?.some((path) => loc.pathname.startsWith(path))
              ))?.l || 'Biz-trans'}
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
                <SafeImage
                  src={user?.avatar_url}
                  alt={`Photo de ${user?.full_name || 'profil'}`}
                  className="h-7 w-7 rounded-full border border-white object-cover shadow-sm sm:h-8 sm:w-8"
                  fallback={<div className="h-7 w-7 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-xs font-bold text-white sm:h-8 sm:w-8">{initials}</div>}
                />
                <ChevronDown className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-slate-500" />
              </button>
              {profileOpen && (
                <div className="absolute right-0 mt-2 min-w-[200px] bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
                  <div className="p-3 border-b border-slate-100">
                    <div className="font-semibold text-slate-900 text-sm">{user?.full_name}</div>
                    <button
                      type="button"
                      onClick={handleUsernameClick}
                      data-testid="profile-username"
                      className="block text-left text-xs text-slate-500"
                    >
                      @{user?.username}
                    </button>
                  </div>
                  <button onClick={logout} data-testid="btn-logout" className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2">
                    <LogOut className="w-3.5 h-3.5" /> {t('common.logout')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

            <main className="bt-content p-5 sm:p-7 pb-32">
          <PwaInstallPrompt />
          <Outlet />
        </main>
      </div>
      <nav
        className={`bt-bottom-nav ${sidebarOpen ? 'bt-bottom-nav--sidebar-open' : ''}`}
        aria-label="Navigation principale"
      >
        {bottomNav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            onMouseEnter={() => prefetchPageForRoute(n.to)}
            onFocus={() => prefetchPageForRoute(n.to)}
            onTouchStart={() => prefetchPageForRoute(n.to)}
            data-testid={`bottomnav-${n.l.toLowerCase()}`}
            className={({ isActive }) => `bt-bottom-nav__item ${n.prominent ? 'bt-bottom-nav__item--prominent' : ''} ${
              isActive || n.activePaths?.some((path) => loc.pathname.startsWith(path)) ? 'active' : ''
            }`}
          >
            <span className="bt-bottom-nav__icon">
              {n.image ? (
                <img src={n.image} alt="" aria-hidden="true" className="h-full w-full rounded-full object-cover" decoding="async" />
              ) : (
                <n.i strokeWidth={n.prominent ? 2 : 1.8} />
              )}
            </span>
            <span>{n.l}</span>
          </NavLink>
        ))}
      </nav>
      <FloatingSupportButtons />
      {adminUnlockOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 p-4">
          <form
            onSubmit={verifyAdminPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-panel-mfa-title"
            data-testid="admin-panel-mfa-dialog"
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
          >
            <h2 id="admin-panel-mfa-title" className="font-cabinet text-xl font-bold text-slate-900">
              Vérification à deux facteurs
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Saisissez le code actuel de votre application d’authentification pour continuer.
            </p>
            <label htmlFor="admin-panel-otp" className="mt-5 block text-sm font-semibold text-slate-700">
              Code d’authentification
            </label>
            <input
              id="admin-panel-otp"
              data-testid="admin-panel-otp"
              value={adminOtp}
              onChange={(event) => setAdminOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              className="bt-field mt-2 text-center tracking-[0.4em]"
              placeholder="••••••"
            />
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setAdminUnlockOpen(false)}
                className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-600"
                data-testid="admin-panel-mfa-cancel"
              >
                Annuler
              </button>
              <button
                type="submit"
                disabled={adminOtp.length !== 6 || adminUnlocking}
                className="bt-button-primary flex-1"
                data-testid="admin-panel-mfa-submit"
              >
                {adminUnlocking ? 'Vérification…' : 'Continuer'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users, ArrowLeftRight, ArrowDownToLine, ArrowUpFromLine, IdCard, Link2, Code2, CreditCard, MessageCircle, Settings as SettingsIcon, ShieldCheck, ScrollText, Search, Bell, ChevronDown, LogOut, Menu, X, UserPlus, MinusCircle, Send, Send as SendIcon2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { Link } from 'react-router-dom';

const NAV = [
  { to: '/admin', end: true, i: LayoutDashboard, l: 'Tableau de bord' },
  { to: '/admin/users', i: Users, l: 'Utilisateurs' },
  { to: '/admin/transactions', i: ArrowLeftRight, l: 'Transactions' },
  { to: '/admin/deposits', i: ArrowDownToLine, l: 'Dépôts' },
  { to: '/admin/withdrawals', i: ArrowUpFromLine, l: 'Retraits' },
  { to: '/admin/kyc', i: IdCard, l: 'Vérifications KYC' },
  { to: '/admin/transfer-config', i: SendIcon2, l: 'Config. transferts' },
  { to: '/admin/links', i: Link2, l: 'Liens de paiement' },
  { to: '/admin/api', i: Code2, l: 'API & Intégrations' },
  { to: '/admin/support', i: MessageCircle, l: 'Support & Chat' },
  { to: '/admin/settings', i: SettingsIcon, l: 'Paramètres' },
  { to: '/admin/admins', i: ShieldCheck, l: 'Administrateurs' },
  { to: '/admin/logs', i: ScrollText, l: 'Journal d\'activités' },
];

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [profileOpen, setProfileOpen] = useState(false);
  const loc = useLocation();

  const initials = (user?.full_name || 'A').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  const roleLabel = user?.role === 'super_admin' ? 'Super Administrateur' : 'Administrateur';
  const current = NAV.find((n) => (n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to)))?.l || 'Admin';

  return (
    <div className="min-h-screen bg-slate-50 flex" data-testid="admin-layout">
      {/* Sidebar */}
      <aside className={`fixed top-0 left-0 z-40 h-screen transition-transform duration-300 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} w-64 bg-[#0F172A] text-slate-300`} data-testid="admin-sidebar">
        <div className="h-16 flex items-center gap-2.5 px-5 border-b border-white/10">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] flex items-center justify-center">
            <span className="text-white font-cabinet font-extrabold text-lg">B</span>
          </div>
          <div>
            <div className="font-cabinet font-extrabold text-white text-sm">Biz-trans</div>
            <div className="text-[10px] font-semibold text-blue-400 tracking-wider">ADMIN PANEL</div>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="ml-auto lg:hidden w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>

        <nav className="p-3 space-y-0.5 overflow-y-auto h-[calc(100vh-200px)]">
          {NAV.map((n) => (
            <NavLink
              key={n.to} to={n.to} end={n.end}
              data-testid={`admin-nav-${n.to.replace(/\//g, '-')}`}
              className={({ isActive }) => `flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold transition-colors ${
                isActive ? 'bg-[#2563EB] text-white shadow-lg shadow-blue-600/20' : 'text-slate-300 hover:bg-white/5 hover:text-white'
              }`}
            >
              <n.i className="w-4 h-4" strokeWidth={1.75} />
              {n.l}
            </NavLink>
          ))}
        </nav>

        {/* Quick shortcuts */}
        <div className="absolute bottom-0 left-0 right-0 p-3 border-t border-white/10">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2 px-1">Raccourcis rapides</div>
          <div className="space-y-1">
            <Link to="/admin/users" className="flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold text-slate-300 hover:bg-white/5 rounded-lg" data-testid="qs-credit">
              <UserPlus className="w-3.5 h-3.5 text-emerald-400" /> Créditer un compte
            </Link>
            <Link to="/admin/users" className="flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold text-slate-300 hover:bg-white/5 rounded-lg" data-testid="qs-debit">
              <MinusCircle className="w-3.5 h-3.5 text-red-400" /> Débiter un compte
            </Link>
            <Link to="/admin/notifications" className="flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold text-slate-300 hover:bg-white/5 rounded-lg" data-testid="qs-notify">
              <Send className="w-3.5 h-3.5 text-blue-400" /> Envoyer une notification
            </Link>
          </div>
          <div className="mt-3 pt-3 border-t border-white/10 flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-xs font-bold text-white">{initials}</div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-white truncate">{user?.full_name || 'Admin'}</div>
              <div className="text-[10px] text-emerald-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> En ligne
              </div>
            </div>
            <button onClick={logout} className="w-8 h-8 rounded-lg hover:bg-red-500/20 hover:text-red-400 flex items-center justify-center text-slate-400" data-testid="admin-logout">
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {sidebarOpen && <div onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" />}

      <div className={`flex-1 transition-[padding] duration-300 ${sidebarOpen ? 'lg:pl-64' : 'lg:pl-0'}`}>
        {/* Topbar */}
        <header className="sticky top-0 z-30 bg-white border-b border-slate-200 h-16 flex items-center px-5 gap-3" data-testid="admin-topbar">
          <button onClick={() => setSidebarOpen((v) => !v)} data-testid="admin-toggle-sidebar" className="w-10 h-10 rounded-lg border border-slate-200 flex items-center justify-center hover:bg-slate-50">
            <Menu className="w-4 h-4" />
          </button>
          <div>
            <div className="font-cabinet font-extrabold text-slate-900 text-base">{current}</div>
            <div className="text-[11px] text-slate-500 font-medium">Bienvenue, {user?.full_name?.split(' ')[0] || 'Admin'} 👋</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button className="w-10 h-10 rounded-lg hover:bg-slate-100 flex items-center justify-center" data-testid="admin-search"><Search className="w-4 h-4 text-slate-600" /></button>
            <button className="relative w-10 h-10 rounded-lg hover:bg-slate-100 flex items-center justify-center" data-testid="admin-notif">
              <Bell className="w-4 h-4 text-slate-600" />
              <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">5</span>
            </button>
            <div className="relative">
              <button onClick={() => setProfileOpen((v) => !v)} data-testid="admin-profile" className="flex items-center gap-2 pl-1 pr-3 py-1 rounded-full hover:bg-slate-100">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white flex items-center justify-center font-bold text-xs">{initials}</div>
                <div className="hidden sm:block text-left">
                  <div className="text-xs font-bold text-slate-900 leading-tight">{user?.full_name?.split(' ')[0] || 'Admin'}</div>
                  <div className="text-[10px] text-slate-500">{roleLabel}</div>
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
              </button>
              {profileOpen && (
                <div className="absolute right-0 mt-2 min-w-[200px] bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
                  <Link to="/dashboard" onClick={() => setProfileOpen(false)} className="block px-4 py-2 text-sm hover:bg-slate-50">Vue utilisateur</Link>
                  <button onClick={logout} className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"><LogOut className="w-3.5 h-3.5" /> Déconnexion</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="p-5 sm:p-6 max-w-7xl mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

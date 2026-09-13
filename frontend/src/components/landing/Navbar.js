import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LogIn, Menu, X } from 'lucide-react';
import { Logo } from '../Logo';
import LanguageSwitcher from '@/components/LanguageSwitcher';

export default function Navbar() {
  const { t } = useTranslation();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const items = [
    { to: '/', key: 'home' },
    { to: '/#services', key: 'services' },
    { to: '/#audience', key: 'pricing' },
    { to: '/#steps', key: 'api' },
    { to: '/#about', key: 'about' },
    { to: '/#contact', key: 'contact' },
  ];

  return (
    <header
      data-testid="navbar"
      className={`fixed top-0 inset-x-0 z-50 transition-[background,box-shadow] duration-300 ${
        scrolled ? 'bt-glass border-b border-slate-200/60 shadow-[0_2px_20px_rgba(15,23,42,0.04)]' : 'bg-transparent'
      }`}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <Logo />

        <nav className="hidden lg:flex items-center gap-1">
          {items.map((it, i) => (
            <NavLink
              key={it.key}
              to={it.to}
              data-testid={`nav-${it.key}`}
              className={({ isActive }) =>
                `relative px-4 py-2 text-sm font-semibold rounded-full transition-colors ${
                  isActive && i === 0 ? 'text-[#2563EB]' : 'text-slate-700 hover:text-[#2563EB]'
                }`
              }
              end={i === 0}
            >
              {t(`nav.${it.key}`)}
              {i === 0 && (
                <span className="absolute left-1/2 -translate-x-1/2 bottom-0 w-6 h-[3px] bg-[#2563EB] rounded-full" />
              )}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <LanguageSwitcher compact />

          <Link
            to="/login"
            data-testid="nav-login-btn"
            className="hidden sm:inline-flex items-center gap-1.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-semibold px-4 py-2 rounded-full shadow-[0_4px_12px_0_rgba(37,99,235,0.35)] hover:-translate-y-0.5 transition-transform"
          >
            <LogIn className="w-3.5 h-3.5" />
            {t('nav.login')}
          </Link>

          <button
            data-testid="nav-mobile-toggle"
            onClick={() => setOpen((v) => !v)}
            className="lg:hidden w-10 h-10 rounded-xl border border-slate-200 flex items-center justify-center"
          >
            {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="lg:hidden bt-glass border-t border-slate-200/60 px-6 py-4 space-y-1">
          {items.map((it) => (
            <a key={it.key} href={it.to} className="block px-3 py-2.5 font-semibold text-slate-700 hover:bg-slate-50 rounded-lg" data-testid={`nav-mobile-${it.key}`}>
              {t(`nav.${it.key}`)}
            </a>
          ))}
          <Link to="/login" data-testid="nav-mobile-login-btn" className="block mt-3 text-center bg-[#2563EB] text-white font-semibold px-5 py-3 rounded-full">
            {t('nav.login')}
          </Link>
        </div>
      )}
    </header>
  );
}

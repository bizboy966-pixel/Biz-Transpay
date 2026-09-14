import { useEffect, useState } from 'react';
import { ChevronDown, Languages } from 'lucide-react';
import api from '@/api';
import i18n from '@/i18n';

const LANGS = [
  { code: 'fr', label: 'FR', name: 'Français' },
  { code: 'en', label: 'EN', name: 'English' },
];

export default function LanguageSwitcher({ compact = false, className = '' }) {
  const [lang, setLang] = useState((i18n.language || 'fr').split('-')[0]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onLanguageChanged = (next) => setLang((next || 'fr').split('-')[0]);
    i18n.on('languageChanged', onLanguageChanged);
    return () => i18n.off('languageChanged', onLanguageChanged);
  }, []);

  const changeLanguage = async (next) => {
    i18n.changeLanguage(next);
    localStorage.setItem('btp_lang', next);
    setLang(next);
    setOpen(false);

    try {
      await api.patch('/settings/profile', { language: next });
    } catch {
      // The public login/register screens can change language locally.
    }
  };

  const current = LANGS.find((item) => item.code === lang) || LANGS[0];

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        data-testid="language-switcher"
        aria-label="Choisir la langue"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex items-center gap-1.5 border border-slate-200 rounded-full font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-colors ${
          compact ? 'px-2.5 py-2 text-xs' : 'px-3 py-2 text-sm'
        }`}
      >
        <Languages className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
        <span>{current.label}</span>
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 z-50 min-w-[132px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          {LANGS.map((item) => (
            <button
              type="button"
              key={item.code}
              data-testid={`language-option-${item.code}`}
              onClick={() => changeLanguage(item.code)}
              className={`flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-semibold hover:bg-slate-50 ${
                item.code === current.code ? 'text-[#2563EB] bg-blue-50/60' : 'text-slate-700'
              }`}
            >
              <span>{item.name}</span>
              <span className="text-[11px]">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
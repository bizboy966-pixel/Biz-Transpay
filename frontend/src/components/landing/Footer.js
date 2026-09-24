import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Logo } from '../Logo';
import { Facebook, Twitter, Linkedin, Youtube, Instagram, Send } from 'lucide-react';

export default function Footer() {
  const { t } = useTranslation();
  return (
    <footer id="contact" className="bg-slate-900 text-slate-300">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 pb-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
          <div className="col-span-2">
            <Logo dark />
            <p className="mt-3 text-slate-400 text-xs leading-relaxed max-w-sm">{t('footer.tagline')}</p>
            <div className="mt-4 flex gap-2">
              {[Facebook, Twitter, Linkedin, Youtube, Instagram].map((I, i) => (
                <a key={i} href="#" data-testid={`social-${i}`} className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center hover:bg-[#2563EB] hover:border-[#2563EB] transition-colors">
                  <I className="w-3.5 h-3.5" />
                </a>
              ))}
            </div>
          </div>

          <div>
            <h4 className="font-cabinet font-bold text-white text-xs uppercase tracking-wider mb-3">{t('footer.products')}</h4>
            <ul className="space-y-1.5 text-xs">
              <li><a href="#services" className="hover:text-white transition-colors">{t('footer.services')}</a></li>
              <li><a href="#products" className="hover:text-white transition-colors">{t('footer.links')}</a></li>
              <li><a href="#steps" className="hover:text-white transition-colors">{t('footer.api')}</a></li>
              <li><a href="#audience" className="hover:text-white transition-colors">{t('footer.pricing')}</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-cabinet font-bold text-white text-xs uppercase tracking-wider mb-3">{t('footer.company')}</h4>
            <ul className="space-y-1.5 text-xs">
              <li><a href="#about" className="hover:text-white transition-colors">{t('footer.about')}</a></li>
              <li><a href="#about" className="hover:text-white transition-colors">{t('footer.security')}</a></li>
              <li><a href="#contact" className="hover:text-white transition-colors">{t('nav.contact')}</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-cabinet font-bold text-white text-xs uppercase tracking-wider mb-3">{t('footer.resources')}</h4>
            <ul className="space-y-1.5 text-xs">
              <li><a href="/docs" className="hover:text-white transition-colors">{t('footer.docs')}</a></li>
              <li><a href="#" className="hover:text-white transition-colors">{t('footer.help')}</a></li>
              <li><a href="#" className="hover:text-white transition-colors">{t('footer.faq')}</a></li>
              <li><a href="#" className="hover:text-white transition-colors">{t('footer.terms')}</a></li>
              <li><a href="#" className="hover:text-white transition-colors">{t('footer.privacy')}</a></li>
            </ul>
          </div>
        </div>

        <div className="mt-10 pt-5 border-t border-white/10 flex flex-col md:flex-row items-center justify-between gap-3">
          <p className="text-xs text-slate-500">© 2026 Biz-transPay. {t('footer.rights')}</p>
          <div className="flex gap-2">
            <Link to="/register" className="text-xs font-semibold text-white hover:text-blue-400">{t('nav.register')} <Send className="inline w-3 h-3" /></Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

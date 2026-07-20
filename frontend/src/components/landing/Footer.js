import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Logo } from '../Logo';
import { Facebook, Twitter, Linkedin, Youtube, Instagram, Send } from 'lucide-react';

export default function Footer() {
  const { t } = useTranslation();
  return (
    <footer id="contact" className="bg-slate-900 text-slate-300">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 pb-8">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8">
          <div className="col-span-2">
            <Logo dark />
            <p className="mt-4 text-slate-400 text-sm leading-relaxed max-w-sm">{t('footer.tagline')}</p>
            <div className="mt-6 flex gap-3">
              {[Facebook, Twitter, Linkedin, Youtube, Instagram].map((I, i) => (
                <a key={i} href="#" data-testid={`social-${i}`} className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center hover:bg-[#2563EB] hover:border-[#2563EB] transition-colors">
                  <I className="w-4 h-4" />
                </a>
              ))}
            </div>
          </div>

          <div>
            <h4 className="font-cabinet font-bold text-white text-sm uppercase tracking-wider mb-4">{t('footer.products')}</h4>
            <ul className="space-y-2 text-sm">
              <li><a href="#services" className="hover:text-white transition-colors">{t('footer.services')}</a></li>
              <li><a href="#services" className="hover:text-white transition-colors">{t('footer.links')}</a></li>
              <li><a href="#services" className="hover:text-white transition-colors">{t('footer.api')}</a></li>
              <li><a href="#pricing" className="hover:text-white transition-colors">{t('footer.pricing')}</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-cabinet font-bold text-white text-sm uppercase tracking-wider mb-4">{t('footer.company')}</h4>
            <ul className="space-y-2 text-sm">
              <li><a href="#about" className="hover:text-white transition-colors">{t('footer.about')}</a></li>
              <li><a href="#about" className="hover:text-white transition-colors">{t('footer.security')}</a></li>
              <li><a href="#contact" className="hover:text-white transition-colors">{t('nav.contact')}</a></li>
            </ul>
          </div>
          <div>
            <h4 className="font-cabinet font-bold text-white text-sm uppercase tracking-wider mb-4">{t('footer.resources')}</h4>
            <ul className="space-y-2 text-sm">
              <li><a href="#" className="hover:text-white transition-colors">{t('footer.docs')}</a></li>
              <li><a href="#" className="hover:text-white transition-colors">{t('footer.help')}</a></li>
              <li><a href="#" className="hover:text-white transition-colors">{t('footer.faq')}</a></li>
              <li><a href="#" className="hover:text-white transition-colors">{t('footer.terms')}</a></li>
              <li><a href="#" className="hover:text-white transition-colors">{t('footer.privacy')}</a></li>
            </ul>
          </div>
        </div>

        <div className="mt-14 pt-6 border-t border-white/10 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-sm text-slate-500">© 2026 Biz-transPay. {t('footer.rights')}</p>
          <div className="flex gap-2">
            <Link to="/register" className="text-sm font-semibold text-white hover:text-blue-400">{t('nav.register')} <Send className="inline w-3 h-3" /></Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

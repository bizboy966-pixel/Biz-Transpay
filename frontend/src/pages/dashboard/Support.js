import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, MessageCircle, HelpCircle, Phone, Mail } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

const FAQ = [
  { q: 'Comment vérifier mon compte ?', a: 'Rendez-vous sur la page Vérification KYC et téléversez vos documents.' },
  { q: 'Quels sont les frais ?', a: 'Les frais varient selon le type de transaction : 1% pour Mobile Money, 1.5% pour les virements bancaires, 0.5% pour les échanges XOF/XAF.' },
  { q: 'Quand puis-je utiliser l\'API ?', a: 'L\'API est disponible immédiatement après la création d\'un compte marchand et la vérification KYC.' },
  { q: 'Quel est le montant minimum de dépôt ?', a: 'Le montant minimum de dépôt est de 300 XOF ou XAF.' },
];

export default function Support() {
  const { t } = useTranslation();
  const [tickets, setTickets] = useState([]);
  const [form, setForm] = useState({ subject: '', message: '', category: 'general' });

  const load = () => api.get('/support/tickets').then(({ data }) => setTickets(data)).catch(() => {});
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    await api.post('/support/tickets', form);
    toast.success('Ticket créé');
    setForm({ subject: '', message: '', category: 'general' });
    load();
  };

  return (
    <div className="space-y-6" data-testid="page-support">
      <div>
        <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">{t('support.title')}</h1>
        <p className="text-slate-500 text-sm mt-1">{t('support.subtitle')}</p>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {[
          { I: Phone, l: '+228 90 90 90 90', s: 'Ligne directe' },
          { I: Mail, l: 'support@biz-transpay.com', s: '24/7' },
          { I: MessageCircle, l: 'Chat en direct', s: 'Lun-Ven 8h-18h' },
        ].map((c, i) => (
          <div key={i} className="bg-white border border-slate-100 rounded-[20px] p-6 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-50 text-[#2563EB] flex items-center justify-center"><c.I className="w-5 h-5" /></div>
            <div><div className="font-semibold text-slate-900">{c.l}</div><div className="text-xs text-slate-500">{c.s}</div></div>
          </div>
        ))}
      </div>

      <form onSubmit={submit} className="bg-white border border-slate-100 rounded-[24px] p-6 sm:p-8 space-y-4" data-testid="ticket-form">
        <h2 className="font-cabinet font-bold text-lg">{t('support.new_ticket')}</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('support.subject')}</label>
            <input data-testid="ticket-subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required className="w-full px-4 py-3.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB]" />
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('support.category')}</label>
            <select data-testid="ticket-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full px-4 py-3.5 border border-slate-200 rounded-xl font-semibold">
              <option value="general">Général</option><option value="technical">Technique</option><option value="billing">Facturation</option><option value="kyc">KYC</option>
            </select>
          </div>
        </div>
        <div>
          <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('support.message')}</label>
          <textarea data-testid="ticket-msg" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} required rows={4} className="w-full px-4 py-3.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB]" />
        </div>
        <button type="submit" data-testid="btn-submit-ticket" className="inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-6 py-3 rounded-full"><Send className="w-4 h-4" /> {t('support.submit')}</button>
      </form>

      {tickets.length > 0 && (
        <div className="bg-white border border-slate-100 rounded-[24px] p-6">
          <h2 className="font-cabinet font-bold mb-4">Vos tickets</h2>
          <div className="space-y-3">
            {tickets.map((t) => (
              <div key={t.id} className="p-4 border border-slate-100 rounded-xl">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-slate-900">{t.subject}</div>
                  <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-full text-[10px] font-bold uppercase">{t.status}</span>
                </div>
                <div className="text-sm text-slate-500 mt-1">{t.message}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-100 rounded-[24px] p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-4">
          <HelpCircle className="w-5 h-5 text-[#2563EB]" />
          <h2 className="font-cabinet font-bold text-lg">{t('support.faq_title')}</h2>
        </div>
        <div className="space-y-3">
          {FAQ.map((f, i) => (
            <details key={i} className="group border border-slate-100 rounded-xl p-4 open:bg-slate-50">
              <summary className="cursor-pointer font-semibold text-slate-900 list-none flex items-center justify-between">
                {f.q}<span className="text-[#2563EB] group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <p className="mt-2 text-sm text-slate-600">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}

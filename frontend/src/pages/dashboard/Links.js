import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Copy, Trash2, Power, Link2, X, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

export default function Links() {
  const { t } = useTranslation();
  const [links, setLinks] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', amount: '', currency: 'XOF', description: '', expires_at: '', single_use: false });

  const load = () => api.get('/links').then(({ data }) => setLinks(data)).catch(() => {});
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/links', { ...form, amount: parseFloat(form.amount), expires_at: form.expires_at || null });
      toast.success('Lien créé');
      setShowForm(false); setForm({ title: '', amount: '', currency: 'XOF', description: '', expires_at: '', single_use: false });
      load();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  const copy = (slug) => {
    const url = `${window.location.origin}/pay/${slug}`;
    navigator.clipboard.writeText(url);
    toast.success(t('links.copied'));
  };

  const toggle = async (l) => {
    await api.patch(`/links/${l.id}`, { active: !l.active });
    load();
  };
  const remove = async (id) => {
    if (!window.confirm('Supprimer ce lien ?')) return;
    await api.delete(`/links/${id}`);
    load();
  };

  return (
    <div className="space-y-6" data-testid="page-links">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">{t('links.title')}</h1>
          <p className="text-slate-500 text-sm mt-1">{t('links.subtitle')}</p>
        </div>
        <button onClick={() => setShowForm(true)} data-testid="btn-open-new-link" className="inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-5 py-3 rounded-full shadow-[0_10px_30px_-8px_rgba(37,99,235,0.6)]">
          <Plus className="w-4 h-4" /> {t('links.create')}
        </button>
      </div>

      {links.length === 0 && (
        <div className="bg-white border border-dashed border-slate-200 rounded-[24px] p-16 text-center">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-blue-50 flex items-center justify-center"><Link2 className="w-7 h-7 text-[#2563EB]" /></div>
          <p className="mt-4 text-slate-500">{t('links.no_links')}</p>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {links.map((l) => (
          <div key={l.id} data-testid={`link-card-${l.id}`} className="bg-white border border-slate-100 rounded-[20px] p-6 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-cabinet font-bold text-slate-900 text-lg">{l.title}</div>
                <div className="mt-1 font-cabinet font-extrabold text-2xl text-[#2563EB]">{l.amount.toLocaleString()} <span className="text-sm text-slate-500">{l.currency}</span></div>
              </div>
              <span className={`text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full ${l.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                {l.active ? t('links.active') : t('links.inactive')}
              </span>
            </div>
            {l.description && <p className="mt-3 text-sm text-slate-500">{l.description}</p>}
            <div className="mt-4 flex items-center gap-2 p-3 bg-slate-50 rounded-xl">
              <div className="text-xs text-slate-500 truncate flex-1 font-mono">{window.location.origin}/pay/{l.slug}</div>
              <button onClick={() => copy(l.slug)} data-testid={`btn-copy-link-${l.id}`} className="w-8 h-8 rounded-lg bg-white hover:bg-blue-50 flex items-center justify-center text-slate-600 hover:text-[#2563EB]">
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button data-testid={`btn-share-link-${l.id}`} className="w-8 h-8 rounded-lg bg-white hover:bg-blue-50 flex items-center justify-center text-slate-600 hover:text-[#2563EB]"><Share2 className="w-3.5 h-3.5" /></button>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <div className="text-xs text-slate-500">{l.payments_received} {t('links.payments')} · {l.total_received?.toLocaleString() || 0} {l.currency}</div>
              <div className="flex gap-2">
                <button onClick={() => toggle(l)} data-testid={`btn-toggle-${l.id}`} className="text-xs font-semibold text-slate-700 hover:text-[#2563EB] inline-flex items-center gap-1"><Power className="w-3.5 h-3.5" /> {l.active ? 'Désactiver' : 'Activer'}</button>
                <button onClick={() => remove(l.id)} data-testid={`btn-delete-${l.id}`} className="text-xs font-semibold text-red-600 hover:text-red-700 inline-flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> Supprimer</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" data-testid="link-form-modal">
          <form onSubmit={submit} className="bg-white rounded-[24px] p-8 max-w-md w-full shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-cabinet text-2xl font-extrabold">{t('links.new_title')}</h2>
              <button type="button" onClick={() => setShowForm(false)} data-testid="btn-close-form" className="w-9 h-9 rounded-lg hover:bg-slate-100 flex items-center justify-center"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-4">
              <Input label={t('links.link_title')} value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder={t('links.link_title_ph')} required tid="link-title" />
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <Input label={t('links.amount')} type="number" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} required tid="link-amount" />
                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('links.currency')}</label>
                  <select data-testid="link-currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className="px-4 py-3.5 border border-slate-200 rounded-xl font-semibold">
                    <option value="XOF">XOF</option><option value="XAF">XAF</option>
                  </select>
                </div>
              </div>
              <Input label={t('links.description')} value={form.description} onChange={(v) => setForm({ ...form, description: v })} tid="link-desc" />
              <Input label={t('links.expires')} type="datetime-local" value={form.expires_at} onChange={(v) => setForm({ ...form, expires_at: v })} tid="link-expires" />
              <label className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl cursor-pointer">
                <input type="checkbox" data-testid="link-single-use" checked={form.single_use} onChange={(e) => setForm({ ...form, single_use: e.target.checked })} className="w-4 h-4 accent-[#2563EB]" />
                <span className="text-sm font-semibold">{t('links.single_use')}</span>
              </label>
              <button type="submit" data-testid="btn-generate-link" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-3.5 rounded-xl">{t('links.generate')}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function Input({ label, value, onChange, placeholder, type = 'text', required, tid }) {
  return (
    <div>
      <label className="text-sm font-semibold text-slate-700 mb-2 block">{label}</label>
      <input data-testid={tid} type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required={required} className="w-full px-4 py-3.5 border border-slate-200 rounded-xl focus:border-[#2563EB] focus:ring-2 focus:ring-blue-100 outline-none" />
    </div>
  );
}

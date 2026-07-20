import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IdCard, Upload, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

export default function Kyc() {
  const { t } = useTranslation();
  const { user, refresh } = useAuth();
  const [status, setStatus] = useState('not_started');
  const [form, setForm] = useState({ document_type: 'id_card', document_number: '', address: '', city: '' });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/kyc').then(({ data }) => setStatus(data.status)).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/kyc/submit', form);
      toast.success(t('kyc.success'));
      setStatus('verified');
      refresh();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Erreur');
    } finally { setLoading(false); }
  };

  const badges = {
    not_started: { c: 'bg-slate-100 text-slate-600', I: IdCard, l: t('kyc.not_started') },
    pending: { c: 'bg-amber-50 text-amber-700', I: Clock, l: t('kyc.pending') },
    verified: { c: 'bg-emerald-50 text-emerald-700', I: CheckCircle2, l: t('kyc.verified') },
    rejected: { c: 'bg-red-50 text-red-700', I: XCircle, l: t('kyc.rejected') },
  };
  const badge = badges[status] || badges.not_started;

  return (
    <div className="space-y-6" data-testid="page-kyc">
      <div>
        <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">{t('kyc.title')}</h1>
        <p className="text-slate-500 text-sm mt-1">{t('kyc.subtitle')}</p>
      </div>

      <div className="bg-white border border-slate-100 rounded-[24px] p-6 flex items-center gap-4">
        <div className={`w-14 h-14 rounded-2xl ${badge.c} flex items-center justify-center`}>
          <badge.I className="w-6 h-6" />
        </div>
        <div>
          <div className="text-xs uppercase tracking-widest text-slate-500 font-bold">{t('kyc.status')}</div>
          <div className="font-cabinet font-extrabold text-2xl text-slate-900" data-testid="kyc-status">{badge.l}</div>
        </div>
      </div>

      {status !== 'verified' && (
        <form onSubmit={submit} className="bg-white border border-slate-100 rounded-[24px] p-6 sm:p-8 space-y-5">
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('kyc.doc_type')}</label>
            <select data-testid="kyc-doc-type" value={form.document_type} onChange={(e) => setForm({ ...form, document_type: e.target.value })} className="w-full px-4 py-3.5 border border-slate-200 rounded-xl">
              <option value="id_card">{t('kyc.id_card')}</option>
              <option value="passport">{t('kyc.passport')}</option>
              <option value="driver_license">{t('kyc.driver')}</option>
            </select>
          </div>
          <Input label={t('kyc.doc_number')} value={form.document_number} onChange={(v) => setForm({ ...form, document_number: v })} required tid="kyc-doc-number" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('kyc.doc_front')}</label>
              <div className="border-2 border-dashed border-slate-200 rounded-xl p-6 text-center text-slate-400 text-sm hover:border-blue-300 cursor-pointer"><Upload className="w-6 h-6 mx-auto mb-1" /> Cliquer pour uploader</div>
            </div>
            <div>
              <label className="text-sm font-semibold text-slate-700 mb-2 block">{t('kyc.selfie')}</label>
              <div className="border-2 border-dashed border-slate-200 rounded-xl p-6 text-center text-slate-400 text-sm hover:border-blue-300 cursor-pointer"><Upload className="w-6 h-6 mx-auto mb-1" /> Cliquer pour uploader</div>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Input label={t('kyc.address')} value={form.address} onChange={(v) => setForm({ ...form, address: v })} required tid="kyc-address" />
            <Input label={t('kyc.city')} value={form.city} onChange={(v) => setForm({ ...form, city: v })} required tid="kyc-city" />
          </div>
          <button type="submit" disabled={loading} data-testid="btn-submit-kyc" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-4 rounded-xl disabled:opacity-70">
            {loading ? '…' : t('kyc.submit')}
          </button>
        </form>
      )}
    </div>
  );
}

function Input({ label, value, onChange, required, tid, type = 'text' }) {
  return (
    <div>
      <label className="text-sm font-semibold text-slate-700 mb-2 block">{label}</label>
      <input data-testid={tid} type={type} value={value} onChange={(e) => onChange(e.target.value)} required={required} className="w-full px-4 py-3.5 border border-slate-200 rounded-xl focus:border-[#2563EB] focus:ring-2 focus:ring-blue-100 outline-none" />
    </div>
  );
}

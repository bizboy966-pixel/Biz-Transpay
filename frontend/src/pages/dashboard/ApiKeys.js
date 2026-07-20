import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, RefreshCw, Save, Code2, Book, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

export default function ApiKeys() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [keys, setKeys] = useState(null);
  const [webhook, setWebhook] = useState('');
  const [showSecret, setShowSecret] = useState(false);

  const load = () => api.get('/api-keys').then(({ data }) => { setKeys(data); setWebhook(data.webhook_url || ''); }).catch(() => {});
  useEffect(() => { if (user?.account_type === 'merchant') load(); }, [user]);

  const copy = (v) => { navigator.clipboard.writeText(v); toast.success(t('api.copied')); };

  const regen = async () => {
    if (!window.confirm('Régénérer les clés ? Les anciennes seront invalidées.')) return;
    const { data } = await api.post('/api-keys/regenerate');
    setKeys(data);
    toast.success('Clés régénérées');
  };

  const saveWebhook = async () => {
    await api.patch('/api-keys/webhook', { webhook_url: webhook });
    toast.success('Webhook enregistré');
  };

  if (user?.account_type !== 'merchant') {
    return (
      <div className="bg-white border border-slate-100 rounded-[24px] p-10 text-center">
        <Code2 className="w-10 h-10 text-slate-300 mx-auto" />
        <p className="mt-4 text-slate-600">{t('api.merchant_only')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="page-api">
      <div>
        <h1 className="font-cabinet text-3xl font-extrabold tracking-tighter text-slate-900">{t('api.title')}</h1>
        <p className="text-slate-500 text-sm mt-1">{t('api.subtitle')}</p>
      </div>

      {keys && (
        <div className="bg-white border border-slate-100 rounded-[24px] p-6 sm:p-8 space-y-5">
          <div>
            <label className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2 block">{t('api.public')}</label>
            <div className="flex items-center gap-2 bg-slate-50 rounded-xl p-3">
              <code data-testid="public-key" className="flex-1 font-mono text-sm text-slate-800 break-all">{keys.public_key}</code>
              <button onClick={() => copy(keys.public_key)} data-testid="btn-copy-public" className="w-9 h-9 rounded-lg bg-white hover:bg-blue-50 flex items-center justify-center"><Copy className="w-4 h-4 text-slate-600" /></button>
            </div>
          </div>
          <div>
            <label className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2 block">{t('api.secret')}</label>
            <div className="flex items-center gap-2 bg-slate-50 rounded-xl p-3">
              <code data-testid="secret-key" className="flex-1 font-mono text-sm text-slate-800 break-all">{showSecret ? keys.secret_key : keys.secret_key.replace(/./g, '•').slice(0, 32)}</code>
              <button onClick={() => setShowSecret((v) => !v)} data-testid="btn-toggle-secret" className="w-9 h-9 rounded-lg bg-white hover:bg-blue-50 flex items-center justify-center">
                {showSecret ? <EyeOff className="w-4 h-4 text-slate-600" /> : <Eye className="w-4 h-4 text-slate-600" />}
              </button>
              <button onClick={() => copy(keys.secret_key)} data-testid="btn-copy-secret" className="w-9 h-9 rounded-lg bg-white hover:bg-blue-50 flex items-center justify-center"><Copy className="w-4 h-4 text-slate-600" /></button>
            </div>
          </div>
          <div>
            <label className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2 block">{t('api.webhook')}</label>
            <div className="flex gap-2">
              <input data-testid="input-webhook" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder={t('api.webhook_ph')} className="flex-1 px-4 py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB]" />
              <button onClick={saveWebhook} data-testid="btn-save-webhook" className="bg-slate-900 hover:bg-slate-800 text-white font-bold px-5 rounded-xl inline-flex items-center gap-2"><Save className="w-4 h-4" /> {t('api.save_webhook')}</button>
            </div>
          </div>
          <div className="flex items-center gap-3 pt-2">
            <button onClick={regen} data-testid="btn-regen-keys" className="inline-flex items-center gap-2 bg-red-50 text-red-600 hover:bg-red-100 px-4 py-2.5 rounded-xl text-sm font-bold"><RefreshCw className="w-4 h-4" /> {t('api.regenerate')}</button>
            <a href="#" className="inline-flex items-center gap-2 bg-blue-50 text-[#2563EB] hover:bg-blue-100 px-4 py-2.5 rounded-xl text-sm font-bold"><Book className="w-4 h-4" /> {t('api.docs')}</a>
          </div>
        </div>
      )}
    </div>
  );
}

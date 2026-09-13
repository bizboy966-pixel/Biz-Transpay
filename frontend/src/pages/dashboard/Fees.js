import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight, Bitcoin, Loader2, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api from '@/api';

export default function Fees() {
  const { t } = useTranslation();
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/fees/config')
      .then(({ data }) => setConfig(data))
      .catch(() => setError(t('fees.no_data')));
  }, [t]);

  if (error) return <div className="text-sm text-slate-500" data-testid="fees-error">{error}</div>;
  if (!config) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500" data-testid="fees-loading">
        <Loader2 className="w-4 h-4 animate-spin" /> Chargement…
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="page-fees">
      <div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-700 text-white flex items-center justify-center">
            <ArrowLeftRight className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-cabinet text-2xl font-extrabold tracking-tighter text-slate-900">{t('fees.title')}</h1>
            <p className="text-slate-500 text-xs mt-1">{t('fees.subtitle')}</p>
          </div>
        </div>
      </div>

      <FeeGroup title={t('fees.deposit')} icon={ArrowDownToLine} color="emerald">
        <MobileMoneyTable data={config.deposit?.mobile_money} t={t} />
        <CryptoTable data={config.deposit?.crypto} t={t} />
      </FeeGroup>

      <FeeGroup title={t('fees.withdrawal')} icon={ArrowUpFromLine} color="red">
        <MobileMoneyTable data={config.withdrawal?.mobile_money} t={t} />
        <CryptoTable data={config.withdrawal?.crypto} t={t} />
      </FeeGroup>

      <FeeGroup title={t('fees.conversion')} icon={ArrowLeftRight} color="blue">
        <ConversionFee data={config.conversion} t={t} />
      </FeeGroup>
    </div>
  );
}

function FeeGroup({ title, icon: Icon, color, children }) {
  const colors = {
    emerald: 'bg-emerald-50 text-emerald-600',
    red: 'bg-red-50 text-red-600',
    blue: 'bg-blue-50 text-blue-600',
  };
  return (
    <section className="bg-white border border-slate-100 rounded-2xl p-5 space-y-5">
      <div className="flex items-center gap-2.5">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${colors[color]}`}><Icon className="w-4 h-4" /></div>
        <h2 className="font-cabinet font-bold text-slate-900">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function MobileMoneyTable({ data, t }) {
  if (!data?.enabled && !(data?.operators || []).length) return null;
  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-sm font-bold text-slate-800">
        <Smartphone className="w-4 h-4 text-[#2563EB]" /> {t('fees.mobile_money')}
      </div>
      {(data?.operators || []).length ? (
        <div className="overflow-x-auto rounded-xl border border-slate-100">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">{t('fees.operator')}</th>
                <th className="text-left px-3 py-2">Pays</th>
                <th className="text-right px-3 py-2">{t('fees.fee')}</th>
                <th className="text-right px-3 py-2">{t('fees.limits')}</th>
              </tr>
            </thead>
            <tbody>
              {data.operators.map((item) => (
                <tr key={`${item.country}-${item.name}`} className="border-t border-slate-50">
                  <td className="px-3 py-2.5 font-semibold text-slate-900">{item.name}</td>
                  <td className="px-3 py-2.5 text-slate-500">{item.country_label || item.country}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-slate-900">{formatFee(item, item.currency)}</td>
                  <td className="px-3 py-2.5 text-right text-slate-500">{formatLimits(item)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty t={t} />}
    </div>
  );
}

function CryptoTable({ data, t }) {
  if (!data?.enabled && !(data?.assets || []).length) return null;
  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-sm font-bold text-slate-800">
        <Bitcoin className="w-4 h-4 text-orange-500" /> {t('fees.crypto')}
      </div>
      {(data?.assets || []).length ? (
        <div className="overflow-x-auto rounded-xl border border-slate-100">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">{t('fees.asset')}</th>
                <th className="text-right px-3 py-2">{t('fees.fee')}</th>
              </tr>
            </thead>
            <tbody>
              {data.assets.map((item) => (
                <tr key={item.code} className="border-t border-slate-50">
                  <td className="px-3 py-2.5 font-mono font-semibold text-slate-900">{item.code}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-slate-900">{formatFee(item, item.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty t={t} />}
    </div>
  );
}

function ConversionFee({ data, t }) {
  if (!data?.enabled) return <Empty t={t} />;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-blue-50 border border-blue-100 p-4">
      <div className="text-sm font-bold text-slate-900">{t('fees.fee')}</div>
      <div className="text-lg font-extrabold text-[#2563EB]">
        {data.type === 'fixed' ? `${data.value} (${t('fees.fixed')})` : `${data.value}%`}
      </div>
      {(data.min_fee !== null && data.min_fee !== undefined) && <div className="text-xs text-slate-600">{t('fees.from')} {data.min_fee}</div>}
      {(data.max_fee !== null && data.max_fee !== undefined) && <div className="text-xs text-slate-600">{t('fees.to')} {data.max_fee}</div>}
    </div>
  );
}

function Empty({ t }) {
  return <p className="text-xs text-slate-400">{t('fees.no_data')}</p>;
}

function formatFee(item, currency) {
  const pct = Number(item?.fee_pct || 0);
  const fixed = Number(item?.fee_fixed || 0);
  const suffix = currency ? ` ${currency}` : '';
  if (fixed > 0) return `${pct}% + ${fixed}${suffix}`;
  return `${pct}%`;
}

function formatLimits(item) {
  if (!item?.min && !item?.max) return '—';
  const min = item.min ? Number(item.min).toLocaleString() : '—';
  const max = item.max ? Number(item.max).toLocaleString() : '—';
  return `${min} – ${max} ${item.currency || ''}`.trim();
}
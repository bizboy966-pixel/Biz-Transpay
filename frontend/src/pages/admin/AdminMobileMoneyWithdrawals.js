import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, Globe2, Loader2, RotateCcw, Save, Smartphone, Trash2,
  ToggleLeft, ToggleRight,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

const EMPTY_MOBILE_MONEY = { enabled: true, operators: [] };

function normalizeOperators(operators, provider) {
  return Array.isArray(operators)
    ? operators.map((operator, index) => {
      const gatewayPct = operator.gateway_fee_pct == null
        ? number(operator.fee_pct)
        : number(operator.gateway_fee_pct);
      return ({
      country: '',
      country_label: '',
      code: '',
      name: '',
      currency: 'XOF',
      active: true,
      archived: false,
      hidden: false,
      gateway_fee_pct: gatewayPct,
      gateway_fee_fixed: 0,
      platform_fee_pct: 0,
      platform_fee_fixed: 0,
      fee_pct: 0,
      min: 0,
      max: '',
      ...operator,
       provider: operator.provider || provider,
      // The admin response does not require an id. A stable local key keeps
      // editing safe without inventing a field for the API.
       _key: `${operator.provider || provider}-${operator.id || `${operator.country || 'country'}-${operator.code || index}-${index}`}`,
      });
    })
    : [];
}

function normalizeConfig(data, mbiyoData, afribapayData) {
  const paydunyaOperators = normalizeOperators(data?.mobile_money?.operators, 'paydunya');
  const mbiyoOperators = normalizeOperators(
    mbiyoData?.catalog || data?.mbiyo?.operators,
    'mbiyo',
  );
  const afribapayOperators = normalizeOperators(afribapayData?.catalog, 'afribapay');
  return {
    enabled: data?.mobile_money?.enabled !== false,
    operators: [...paydunyaOperators, ...mbiyoOperators, ...afribapayOperators],
    mbiyo: {
      enabled: mbiyoData?.enabled !== false,
      mode: mbiyoData?.mode || 'test',
    },
    afribapay: {
      enabled: afribapayData?.enabled !== false,
      mode: afribapayData?.mode || 'sandbox',
    },
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function AdminMobileMoneyWithdrawals() {
  const [config, setConfig] = useState(null);
  const [countryFilter, setCountryFilter] = useState('all');
  const [providerFilter, setProviderFilter] = useState('all');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [{ data }, { data: mbiyoData }, { data: afribapayData }] = await Promise.all([
        api.get('/admin/transfer/config'),
        api.get('/admin/payment-providers/mbiyo'),
        api.get('/admin/payment-providers/afribapay'),
      ]);
      setConfig(normalizeConfig(data, mbiyoData, afribapayData));
      setDirty(false);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Impossible de charger le catalogue Mobile Money');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const countries = useMemo(() => Array.from(new Set(
    (config?.operators || []).map((operator) => operator.country).filter(Boolean),
  )).sort((a, b) => {
    const labelA = config.operators.find((operator) => operator.country === a)?.country_label || a;
    const labelB = config.operators.find((operator) => operator.country === b)?.country_label || b;
    return labelA.localeCompare(labelB);
  }), [config]);

  const visibleOperators = useMemo(() => (config?.operators || [])
    .filter((operator) => countryFilter === 'all' || operator.country === countryFilter)
    .filter((operator) => providerFilter === 'all' || operator.provider === providerFilter)
    .sort((a, b) => (a.country_label || a.country).localeCompare(b.country_label || b.country)),
  [config, countryFilter, providerFilter]);

  const update = (key, value) => {
    setConfig((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  const updateOperator = (key, field, value) => {
    setConfig((current) => ({
      ...current,
      operators: current.operators.map((operator) => (
        operator._key === key
          ? {
            ...operator,
            [field]: value,
            ...(field === 'gateway_fee_pct' || field === 'platform_fee_pct'
              ? { fee_pct: number(field === 'gateway_fee_pct' ? value : operator.gateway_fee_pct) + number(field === 'platform_fee_pct' ? value : operator.platform_fee_pct) }
              : {}),
          }
          : operator
      )),
    }));
    setDirty(true);
  };

  const toggleArchive = (key) => {
    setConfig((current) => ({
      ...current,
      operators: current.operators.map((operator) => operator._key === key
        ? { ...operator, archived: !operator.archived, active: operator.archived }
        : operator),
    }));
    setDirty(true);
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      // _key is only a client-side editing key and must never be sent back.
      const cleanOperators = config.operators.map(({ _key, ...operator }) => ({
        ...operator,
        max: operator.max === '' ? null : operator.max,
      }));
      const paydunyaOperators = cleanOperators
        .filter((operator) => operator.provider === 'paydunya')
        .map(({ provider, ...operator }) => operator);
      const mbiyoOperators = cleanOperators.filter((operator) => operator.provider === 'mbiyo');
      const afribapayOperators = cleanOperators.filter((operator) => operator.provider === 'afribapay');
      const [{ data }, { data: mbiyoData }] = await Promise.all([
        api.patch('/admin/transfer/config', {
          mobile_money: { enabled: config.enabled, operators: paydunyaOperators },
        }),
        api.put('/admin/payment-providers/mbiyo', {
          enabled: config.mbiyo.enabled,
          mode: config.mbiyo.mode,
          catalog: mbiyoOperators,
        }),
        api.put('/admin/payment-providers/afribapay', {
          enabled: config.afribapay.enabled,
          mode: config.afribapay.mode,
          catalog: afribapayOperators,
        }),
      ]);
      const { data: afribapayData } = await api.get('/admin/payment-providers/afribapay');
      setConfig(normalizeConfig(data, mbiyoData, afribapayData));
      setDirty(false);
      toast.success('Catalogue Mobile Money enregistré');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Impossible d’enregistrer le catalogue Mobile Money');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Chargement du catalogue Mobile Money…</div>;
  }
  if (!config) {
    return <div className="rounded-2xl bg-white border border-slate-100 p-6 text-sm text-slate-500">Catalogue Mobile Money indisponible.</div>;
  }

  return (
    <section className="space-y-4" data-testid="admin-mobile-money-withdrawals">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0"><Globe2 className="w-5 h-5" /></div>
            <div>
              <h1 className="font-cabinet font-extrabold text-slate-900 text-lg sm:text-xl">Retraits Mobile Money</h1>
              <p className="text-xs text-slate-500 mt-0.5">Catalogue des opérateurs, frais et limites proposés aux clients.</p>
            </div>
          </div>
        </div>
        <button type="button" onClick={save} disabled={saving || !dirty} data-testid="btn-save-mobile-money-withdrawals" className="inline-flex items-center justify-center gap-2 bg-[#2563EB] text-white font-bold px-4 py-2.5 rounded-full text-xs disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Enregistrer
        </button>
      </div>

      <section className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-5" data-testid="mobile-money-withdrawal-settings">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${config.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}><Smartphone className="w-5 h-5" /></div>
          <div className="flex-1">
            <h2 className="font-cabinet font-bold text-slate-900">Mobile Money</h2>
            <p className="text-[11px] text-slate-500">Le catalogue actif est disponible dans le parcours de retrait.</p>
          </div>
          <button type="button" onClick={() => update('enabled', !config.enabled)} data-testid="mobile-money-withdrawal-enabled" className={`inline-flex items-center gap-1.5 self-start sm:self-center px-3 py-1.5 rounded-full text-[10px] font-bold ${config.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
            {config.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
            {config.enabled ? 'Activé' : 'Désactivé'}
          </button>
        </div>
      </section>

      <section className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-5" data-testid="mobile-money-withdrawal-catalog">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl bg-blue-50 text-[#2563EB] flex items-center justify-center"><Globe2 className="w-4 h-4" /></div>
          <div>
            <h2 className="font-cabinet font-bold text-slate-900">Catalogue des opérateurs</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">Configurez les frais de retrait PayDunya et Mbiyo, les limites et le statut.</p>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-1">
          {[
            ['all', 'Tous les prestataires'],
            ['paydunya', 'PayDunya'],
            ['mbiyo', 'Mbiyo'],
            ['afribapay', 'AfribaPAY'],
          ].map(([value, label]) => {
            const count = config.operators.filter((operator) => value === 'all' || operator.provider === value).length;
            return <button type="button" key={value} onClick={() => setProviderFilter(value)} className={`px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap ${providerFilter === value ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700'}`}>{label} ({count})</button>;
          })}
        </div>

        <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-1">
          <button type="button" onClick={() => setCountryFilter('all')} className={`px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap ${countryFilter === 'all' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}>Tous les pays</button>
          {countries.map((country) => {
            const count = config.operators.filter((operator) => operator.country === country).length;
            const label = config.operators.find((operator) => operator.country === country)?.country_label || country;
            return <button type="button" key={country} onClick={() => setCountryFilter(country)} className={`px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap ${countryFilter === country ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{label} ({count})</button>;
          })}
        </div>

        {visibleOperators.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-200 rounded-xl">Aucun opérateur dans ce catalogue.</div>
        ) : (
          <div className="space-y-3">
            {visibleOperators.map((operator) => (
              <WithdrawalOperator
                key={operator._key}
                operator={operator}
                onChange={(field, value) => updateOperator(operator._key, field, value)}
                onArchive={() => toggleArchive(operator._key)}
              />
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function WithdrawalOperator({ operator, onChange, onArchive }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`rounded-xl border ${operator.archived ? 'border-slate-200 bg-slate-50' : 'border-slate-200 bg-white'}`} data-testid={`mobile-money-operator-${operator.code}`}>
      <div className="p-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5 flex-1 min-w-0">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${operator.archived ? 'bg-slate-200 text-slate-500' : 'bg-emerald-50 text-emerald-600'}`}><Smartphone className="w-4 h-4" /></div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-bold text-sm text-slate-900">{operator.name || 'Sans nom'}</span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${operator.provider === 'mbiyo' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>{operator.provider === 'mbiyo' ? 'MBIYO' : 'PAYDUNYA'}</span>
              {operator.archived && <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-[9px] font-bold">ARCHIVÉ</span>}
            </div>
            <div className="text-[10px] text-slate-500">{operator.country_label || operator.country} · {operator.code} · {operator.currency}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[10px] font-bold text-slate-600">
            <input type="checkbox" checked={operator.active === true} disabled={operator.archived} onChange={(e) => onChange('active', e.target.checked)} className="accent-emerald-500" />
            {operator.active ? 'Actif' : 'Inactif'}
          </label>
          <button type="button" onClick={() => setExpanded((value) => !value)} className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 text-[10px] font-bold text-slate-700"><ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} /> Modifier</button>
          <button type="button" onClick={onArchive} className={`inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-bold ${operator.archived ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
            {operator.archived ? <RotateCcw className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />} {operator.archived ? 'Réactiver' : 'Archiver'}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-slate-100 p-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <FeeInput label="Frais passerelle (%)" value={operator.gateway_fee_pct} onChange={(value) => onChange('gateway_fee_pct', value)} disabled={operator.archived} />
            <FeeInput label="Frais passerelle (fixe)" value={operator.gateway_fee_fixed} onChange={(value) => onChange('gateway_fee_fixed', value)} disabled={operator.archived} />
            <FeeInput label="Frais Biz-transPay (%)" value={operator.platform_fee_pct} onChange={(value) => onChange('platform_fee_pct', value)} disabled={operator.archived} />
            <FeeInput label="Frais Biz-transPay (fixe)" value={operator.platform_fee_fixed} onChange={(value) => onChange('platform_fee_fixed', value)} disabled={operator.archived} />
            <FeeInput label="Minimum" value={operator.min} onChange={(value) => onChange('min', value)} disabled={operator.archived} />
            <FeeInput label="Maximum (vide = illimité)" value={operator.max} onChange={(value) => onChange('max', value)} disabled={operator.archived} />
          </div>
        </div>
      )}
    </div>
  );
}

function FeeInput({ label, value, onChange, disabled }) {
  return (
    <div>
      <label className="text-[11px] font-semibold text-slate-700 mb-1 block">{label}</label>
      <input type="number" min="0" step="0.01" value={value ?? ''} disabled={disabled} onChange={(event) => onChange(event.target.value === '' ? '' : number(event.target.value))} className="w-full px-3 py-2 border border-slate-200 rounded-lg outline-none focus:border-[#2563EB] text-xs disabled:bg-slate-100" />
    </div>
  );
}
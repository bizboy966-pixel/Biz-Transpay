import { useEffect, useState } from 'react';
import { Save, Plus, Trash2, ToggleLeft, ToggleRight, Smartphone, Landmark, Bitcoin, Network } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { COUNTRIES } from '@/constants/countries';

export default function AdminTransferConfig() {
  const [cfg, setCfg] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [savingSection, setSavingSection] = useState(null);

  const load = () => api.get('/admin/transfer/config').then(({ data }) => setCfg(data)).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      await api.patch('/admin/transfer/config', {
        mobile_money: cfg.mobile_money, bank: cfg.bank, crypto: cfg.crypto,
      });
      toast.success('Configuration enregistrée');
      setDirty(false);
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  // Auto-save immediately when toggling enable/disable of a section
  const patchSection = async (section, patch) => {
    setSavingSection(section);
    try {
      const merged = { ...(cfg[section] || {}), ...patch };
      const { data } = await api.patch('/admin/transfer/config', { [section]: merged });
      setCfg(data);
      toast.success(patch.enabled ? 'Activé' : 'Désactivé');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Erreur');
    } finally {
      setSavingSection(null);
    }
  };

  if (!cfg) return <div className="text-slate-500 text-sm">Chargement…</div>;

  const mm = cfg.mobile_money || { enabled: false, operators: [] };
  const bank = cfg.bank || { enabled: false, banks: [] };
  const crypto = cfg.crypto || { enabled: false, cryptos: [], networks: [] };

  const setSection = (section, val) => { setCfg({ ...cfg, [section]: val }); setDirty(true); };
  const setEnabled = (section, enabled) => patchSection(section, { enabled });

  const updateOp = (idx, key, val) => {
    const ops = [...mm.operators];
    ops[idx] = { ...ops[idx], [key]: val };
    setSection('mobile_money', { ...mm, operators: ops });
  };
  const addOp = () => setSection('mobile_money', { ...mm, operators: [...mm.operators, { country: 'TG', code: '', name: '', fee_pct: 1.5, min: 100, max: 500000, active: true }] });
  const removeOp = (idx) => setSection('mobile_money', { ...mm, operators: mm.operators.filter((_, i) => i !== idx) });

  const updateBank = (idx, key, val) => {
    const banks = [...bank.banks];
    banks[idx] = { ...banks[idx], [key]: val };
    setSection('bank', { ...bank, banks });
  };
  const addBank = () => setSection('bank', { ...bank, banks: [...bank.banks, { country: 'TG', code: '', name: '', fee_pct: 2.0, min: 1000, max: 5000000, active: true }] });
  const removeBank = (idx) => setSection('bank', { ...bank, banks: bank.banks.filter((_, i) => i !== idx) });

  // CRYPTO handlers
  const updCrypto = (patch) => setSection('crypto', { ...crypto, ...patch });
  const updCryptoRow = (idx, key, val) => {
    const arr = [...(crypto.cryptos || [])];
    arr[idx] = { ...arr[idx], [key]: val };
    updCrypto({ cryptos: arr });
  };
  const addCryptoRow = () => updCrypto({ cryptos: [...(crypto.cryptos || []), { code: '', name: '', active: true, networks: [], fee_pct: 1.0, fee_fixed: 0, min: 1, max: 100000 }] });
  const removeCryptoRow = (idx) => updCrypto({ cryptos: (crypto.cryptos || []).filter((_, i) => i !== idx) });

  const updNetworkRow = (idx, key, val) => {
    const arr = [...(crypto.networks || [])];
    arr[idx] = { ...arr[idx], [key]: val };
    updCrypto({ networks: arr });
  };
  const addNetworkRow = () => updCrypto({ networks: [...(crypto.networks || []), { code: '', name: '', active: true, address_regex: '' }] });
  const removeNetworkRow = (idx) => updCrypto({ networks: (crypto.networks || []).filter((_, i) => i !== idx) });

  return (
    <div className="space-y-4 sm:space-y-6" data-testid="admin-transfer-config">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-cabinet font-bold text-slate-900 text-base sm:text-lg">Configuration des transferts</h1>
          <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">Paramétrez les pays, opérateurs, banques et crypto.</p>
        </div>
        <button onClick={save} disabled={!dirty} data-testid="btn-save-transfer-config" className="inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-3 sm:px-4 py-2 rounded-full text-[11px] sm:text-xs disabled:opacity-50">
          <Save className="w-3.5 h-3.5" /> Enregistrer
        </button>
      </div>

      {/* Mobile Money */}
      <Section title="Biz-trans → Mobile Money" subtitle={`${mm.operators.length} opérateurs configurés`} Icon={Smartphone} iconBg="bg-emerald-50 text-emerald-600" enabled={mm.enabled} saving={savingSection === 'mobile_money'} onEnabledChange={(v) => setEnabled('mobile_money', v)} testId="mm">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] sm:text-xs">
            <thead className="bg-slate-50 text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr><th className="text-left px-2 sm:px-3 py-2">Pays</th><th className="text-left px-2 sm:px-3 py-2">Code</th><th className="text-left px-2 sm:px-3 py-2">Nom</th><th className="text-right px-2 sm:px-3 py-2">Frais %</th><th className="text-right px-2 sm:px-3 py-2">Min</th><th className="text-right px-2 sm:px-3 py-2">Max</th><th className="text-center px-2 sm:px-3 py-2">Actif</th><th className="text-center px-2 sm:px-3 py-2"></th></tr>
            </thead>
            <tbody>
              {mm.operators.map((o, idx) => (
                <tr key={idx} data-testid={`op-row-${idx}`} className="border-t border-slate-50">
                  <td className="px-2 sm:px-3 py-2"><select value={o.country} onChange={(e) => updateOp(idx, 'country', e.target.value)} className="px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs">{COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}</select></td>
                  <td className="px-2 sm:px-3 py-2"><input value={o.code} onChange={(e) => updateOp(idx, 'code', e.target.value.toLowerCase())} className="w-20 sm:w-24 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs font-mono" /></td>
                  <td className="px-2 sm:px-3 py-2"><input value={o.name} onChange={(e) => updateOp(idx, 'name', e.target.value)} className="w-32 sm:w-40 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs" /></td>
                  <td className="px-2 sm:px-3 py-2"><input type="number" step="0.1" value={o.fee_pct} onChange={(e) => updateOp(idx, 'fee_pct', parseFloat(e.target.value) || 0)} className="w-14 sm:w-16 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                  <td className="px-2 sm:px-3 py-2"><input type="number" value={o.min} onChange={(e) => updateOp(idx, 'min', parseInt(e.target.value) || 0)} className="w-16 sm:w-20 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                  <td className="px-2 sm:px-3 py-2"><input type="number" value={o.max} onChange={(e) => updateOp(idx, 'max', parseInt(e.target.value) || 0)} className="w-20 sm:w-24 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                  <td className="px-2 sm:px-3 py-2 text-center"><input type="checkbox" checked={o.active} onChange={(e) => updateOp(idx, 'active', e.target.checked)} className="w-4 h-4 accent-[#2563EB]" /></td>
                  <td className="px-2 sm:px-3 py-2 text-center"><button onClick={() => removeOp(idx)} data-testid={`btn-remove-op-${idx}`} className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center mx-auto"><Trash2 className="w-3.5 h-3.5" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button onClick={addOp} data-testid="btn-add-op" className="mt-3 inline-flex items-center gap-1.5 text-[11px] sm:text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8]"><Plus className="w-3.5 h-3.5" /> Ajouter un opérateur</button>
      </Section>

      {/* Banks */}
      <Section title="Biz-trans → Banque" subtitle={`${bank.banks.length} banques configurées`} Icon={Landmark} iconBg="bg-violet-50 text-violet-600" enabled={bank.enabled} saving={savingSection === 'bank'} onEnabledChange={(v) => setEnabled('bank', v)} testId="bank">
        {bank.banks.length === 0 && <div className="text-center py-4 sm:py-6 text-[11px] sm:text-xs text-slate-500">Aucune banque configurée. Ajoutez-en une pour activer les transferts bancaires.</div>}
        {bank.banks.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] sm:text-xs">
              <thead className="bg-slate-50 text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <tr><th className="text-left px-2 sm:px-3 py-2">Pays</th><th className="text-left px-2 sm:px-3 py-2">Code</th><th className="text-left px-2 sm:px-3 py-2">Nom</th><th className="text-right px-2 sm:px-3 py-2">Frais %</th><th className="text-right px-2 sm:px-3 py-2">Min</th><th className="text-right px-2 sm:px-3 py-2">Max</th><th className="text-center px-2 sm:px-3 py-2">Actif</th><th className="text-center px-2 sm:px-3 py-2"></th></tr>
              </thead>
              <tbody>
                {bank.banks.map((b, idx) => (
                  <tr key={idx} className="border-t border-slate-50">
                    <td className="px-2 sm:px-3 py-2"><select value={b.country} onChange={(e) => updateBank(idx, 'country', e.target.value)} className="px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs">{COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}</select></td>
                    <td className="px-2 sm:px-3 py-2"><input value={b.code} onChange={(e) => updateBank(idx, 'code', e.target.value)} className="w-20 sm:w-24 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs" /></td>
                    <td className="px-2 sm:px-3 py-2"><input value={b.name} onChange={(e) => updateBank(idx, 'name', e.target.value)} className="w-40 sm:w-52 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs" /></td>
                    <td className="px-2 sm:px-3 py-2"><input type="number" step="0.1" value={b.fee_pct} onChange={(e) => updateBank(idx, 'fee_pct', parseFloat(e.target.value) || 0)} className="w-14 sm:w-16 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                    <td className="px-2 sm:px-3 py-2"><input type="number" value={b.min} onChange={(e) => updateBank(idx, 'min', parseInt(e.target.value) || 0)} className="w-16 sm:w-20 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                    <td className="px-2 sm:px-3 py-2"><input type="number" value={b.max} onChange={(e) => updateBank(idx, 'max', parseInt(e.target.value) || 0)} className="w-20 sm:w-24 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                    <td className="px-2 sm:px-3 py-2 text-center"><input type="checkbox" checked={b.active} onChange={(e) => updateBank(idx, 'active', e.target.checked)} className="w-4 h-4 accent-[#2563EB]" /></td>
                    <td className="px-2 sm:px-3 py-2 text-center"><button onClick={() => removeBank(idx)} className="text-red-500"><Trash2 className="w-3.5 h-3.5" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button onClick={addBank} data-testid="btn-add-bank" className="mt-3 inline-flex items-center gap-1.5 text-[11px] sm:text-xs font-semibold text-[#2563EB]"><Plus className="w-3.5 h-3.5" /> Ajouter une banque</button>
      </Section>

      {/* Crypto */}
      <Section title="Biz-trans → Crypto" subtitle="Cryptomonnaies, réseaux et frais" Icon={Bitcoin} iconBg="bg-orange-50 text-orange-600" enabled={crypto.enabled} saving={savingSection === 'crypto'} onEnabledChange={(v) => setEnabled('crypto', v)} testId="crypto">
        {/* Frais Crypto - one row per coin from IzichangePay API */}
        <CryptoFeesTable crypto={crypto} updCrypto={updCrypto} onSaveAll={save} dirty={dirty} savingAll={savingSection === 'save-all'} />
      </Section>
    </div>
  );
}

function CryptoFeesTable({ crypto, updCrypto, onSaveAll, dirty, savingAll }) {
  const [coins, setCoins] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get('/admin/crypto/coins').then(({ data }) => setCoins(data)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const setFee = (coin, val) => {
    const fees = { ...(crypto.fees || {}) };
    fees[coin] = parseFloat(val);
    if (isNaN(fees[coin])) fees[coin] = 4.0;
    updCrypto({ fees });
    // Also reflect in the local coins list for immediate UI feedback
    setCoins((cs) => cs.map((c) => c.coin === coin ? { ...c, fee_pct: fees[coin] } : c));
  };

  const filtered = coins.filter((c) => !filter || c.coin.includes(filter.toUpperCase()) || (c.name || '').toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="mt-1">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <div className="font-cabinet font-bold text-[12px] sm:text-sm text-slate-900 flex items-center gap-1.5"><Bitcoin className="w-3.5 h-3.5" /> Frais de retrait par cryptomonnaie</div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 mt-0.5">Défaut : 4 %. Les cryptos sont chargées automatiquement depuis IzichangePay.</div>
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Rechercher (BTC, USDT…)" className="px-3 py-1.5 border border-slate-200 rounded-lg text-[11px] sm:text-xs w-40 sm:w-48" data-testid="crypto-fee-filter" />
      </div>
      {loading && <div className="text-center py-4 text-[11px] sm:text-xs text-slate-500">Chargement des cryptos…</div>}
      {!loading && filtered.length === 0 && (
        <div className="text-center py-4 text-[11px] sm:text-xs text-slate-500">Aucune cryptomonnaie disponible.</div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] sm:text-xs">
          <thead className="bg-slate-50 text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-2 sm:px-3 py-2">Code</th>
              <th className="text-left px-2 sm:px-3 py-2">Cryptomonnaie</th>
              <th className="text-right px-2 sm:px-3 py-2">Frais (%)</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.coin} className="border-t border-slate-50" data-testid={`crypto-fee-row-${c.coin}`}>
                <td className="px-2 sm:px-3 py-2 font-mono font-bold text-slate-900">{c.coin}</td>
                <td className="px-2 sm:px-3 py-2 text-slate-600">{c.name}</td>
                <td className="px-2 sm:px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <input type="number" step="0.1" min="0" max="100" value={c.fee_pct ?? 4} onChange={(e) => setFee(c.coin, e.target.value)} data-testid={`crypto-fee-${c.coin}`} className="w-16 sm:w-20 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right font-mono" />
                    <span className="text-slate-400 text-[10px]">%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap p-3 bg-orange-50/50 border border-orange-100 rounded-xl">
        <div className="text-[10px] sm:text-[11px] text-slate-600 flex items-start gap-2 flex-1 min-w-0">
          <Bitcoin className="w-3 h-3 text-orange-500 mt-0.5 shrink-0" />
          <span>Les frais sont appliqués <b>automatiquement</b> à toutes les transactions crypto (dépôts, liens, API, retraits). Une modification prend effet immédiatement après l&apos;enregistrement.</span>
        </div>
        <button
          onClick={onSaveAll}
          disabled={!dirty || savingAll}
          data-testid="btn-save-crypto-fees"
          className="inline-flex items-center gap-1.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-4 py-2 rounded-full text-[11px] sm:text-xs disabled:opacity-40 disabled:cursor-not-allowed shrink-0 shadow-sm"
        >
          <Save className="w-3.5 h-3.5" /> {savingAll ? 'Enregistrement…' : dirty ? 'Enregistrer les frais' : 'Enregistré'}
        </button>
      </div>
    </div>
  );
}

function Section({ title, subtitle, Icon, iconBg, enabled, saving, onEnabledChange, testId, children }) {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3 sm:mb-4 gap-3">
        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
          <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl ${iconBg} flex items-center justify-center shrink-0`}><Icon className="w-4 h-4 sm:w-5 sm:h-5" /></div>
          <div className="min-w-0">
            <h2 className="font-cabinet font-bold text-slate-900 text-sm sm:text-base truncate">{title}</h2>
            <p className="text-[10px] sm:text-[11px] text-slate-500 truncate">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span data-testid={`state-${testId}`} className={`hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold text-[10px] ${enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} /> {enabled ? 'Activé' : 'Désactivé'}
          </span>
          {enabled ? (
            <button onClick={() => onEnabledChange(false)} disabled={saving} data-testid={`toggle-${testId}-off`} className="inline-flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 rounded-full font-bold text-[10px] sm:text-xs bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50">
              <ToggleRight className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> {saving ? '…' : 'Désactiver'}
            </button>
          ) : (
            <button onClick={() => onEnabledChange(true)} disabled={saving} data-testid={`toggle-${testId}-on`} className="inline-flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 rounded-full font-bold text-[10px] sm:text-xs bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
              <ToggleLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> {saving ? '…' : 'Activer'}
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function NumberField({ label, value, onChange, step, testId }) {
  return (
    <div>
      <label className="text-[11px] sm:text-xs font-semibold text-slate-700 mb-1 block">{label}</label>
      <input type="number" step={step || '1'} value={value} onChange={(e) => onChange(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[11px] sm:text-xs" data-testid={testId} />
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Save, Plus, Trash2, ToggleLeft, ToggleRight, Smartphone, Landmark, Wallet, Bitcoin, Network } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { COUNTRIES } from '@/constants/countries';

export default function AdminTransferConfig() {
  const [cfg, setCfg] = useState(null);
  const [dirty, setDirty] = useState(false);

  const load = () => api.get('/admin/transfer/config').then(({ data }) => setCfg(data)).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      await api.patch('/admin/transfer/config', {
        mobile_money: cfg.mobile_money, bank: cfg.bank,
        binance: cfg.binance, crypto: cfg.crypto,
      });
      toast.success('Configuration enregistrée');
      setDirty(false);
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  if (!cfg) return <div className="text-slate-500 text-sm">Chargement…</div>;

  const mm = cfg.mobile_money || { enabled: false, operators: [] };
  const bank = cfg.bank || { enabled: false, banks: [] };
  const binance = cfg.binance || { enabled: false, fee_pct: 0.5, min: 1, max: 100000 };
  const crypto = cfg.crypto || { enabled: false, cryptos: [], networks: [] };

  const setSection = (section, val) => { setCfg({ ...cfg, [section]: val }); setDirty(true); };
  const toggle = (section) => setSection(section, { ...cfg[section], enabled: !cfg[section].enabled });

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
          <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">Paramétrez les pays, opérateurs, banques, Binance et crypto.</p>
        </div>
        <button onClick={save} disabled={!dirty} data-testid="btn-save-transfer-config" className="inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-3 sm:px-4 py-2 rounded-full text-[11px] sm:text-xs disabled:opacity-50">
          <Save className="w-3.5 h-3.5" /> Enregistrer
        </button>
      </div>

      {/* Mobile Money */}
      <Section title="Biz-trans → Mobile Money" subtitle={`${mm.operators.length} opérateurs configurés`} Icon={Smartphone} iconBg="bg-emerald-50 text-emerald-600" enabled={mm.enabled} onToggle={() => toggle('mobile_money')} testId="mm">
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
      <Section title="Biz-trans → Banque" subtitle={`${bank.banks.length} banques configurées`} Icon={Landmark} iconBg="bg-violet-50 text-violet-600" enabled={bank.enabled} onToggle={() => toggle('bank')} testId="bank">
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

      {/* Binance */}
      <Section title="Biz-trans → Binance" subtitle="Transferts Binance Pay (Pay ID / Email)" Icon={Wallet} iconBg="bg-amber-50 text-amber-600" enabled={binance.enabled} onToggle={() => toggle('binance')} testId="binance">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <NumberField label="Frais %" value={binance.fee_pct} step="0.1" onChange={(v) => setSection('binance', { ...binance, fee_pct: parseFloat(v) || 0 })} testId="bin-fee-pct" />
          <NumberField label="Min" value={binance.min} onChange={(v) => setSection('binance', { ...binance, min: parseFloat(v) || 0 })} testId="bin-min" />
          <NumberField label="Max" value={binance.max} onChange={(v) => setSection('binance', { ...binance, max: parseFloat(v) || 0 })} testId="bin-max" />
        </div>
        <div className="mt-3">
          <label className="text-[11px] sm:text-xs font-semibold text-slate-700 mb-1 block">Note (affichée si désactivé)</label>
          <input value={binance.note || ''} onChange={(e) => setSection('binance', { ...binance, note: e.target.value })} placeholder="Bientôt disponible…" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[11px] sm:text-xs" data-testid="bin-note" />
        </div>
      </Section>

      {/* Crypto */}
      <Section title="Biz-trans → Crypto" subtitle="Cryptomonnaies, réseaux et frais" Icon={Bitcoin} iconBg="bg-orange-50 text-orange-600" enabled={crypto.enabled} onToggle={() => toggle('crypto')} testId="crypto">
        {/* Cryptos */}
        <div className="mt-1 mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="font-cabinet font-bold text-[11px] sm:text-xs text-slate-900 flex items-center gap-1.5"><Bitcoin className="w-3.5 h-3.5" /> Cryptomonnaies</div>
            <button onClick={addCryptoRow} data-testid="btn-add-crypto" className="text-[11px] sm:text-xs font-semibold text-[#2563EB] inline-flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> Ajouter</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] sm:text-xs">
              <thead className="bg-slate-50 text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <tr><th className="text-left px-2 py-2">Code</th><th className="text-left px-2 py-2">Nom</th><th className="text-left px-2 py-2">Réseaux</th><th className="text-right px-2 py-2">Frais %</th><th className="text-right px-2 py-2">Frais fixes</th><th className="text-right px-2 py-2">Min</th><th className="text-right px-2 py-2">Max</th><th className="text-center px-2 py-2">Actif</th><th className="text-center px-2 py-2"></th></tr>
              </thead>
              <tbody>
                {(crypto.cryptos || []).map((c, idx) => (
                  <tr key={idx} className="border-t border-slate-50" data-testid={`crypto-row-${idx}`}>
                    <td className="px-2 py-2"><input value={c.code} onChange={(e) => updCryptoRow(idx, 'code', e.target.value.toUpperCase())} className="w-16 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs font-mono" /></td>
                    <td className="px-2 py-2"><input value={c.name} onChange={(e) => updCryptoRow(idx, 'name', e.target.value)} className="w-28 sm:w-36 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs" /></td>
                    <td className="px-2 py-2"><input value={(c.networks || []).join(',')} onChange={(e) => updCryptoRow(idx, 'networks', e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))} placeholder="TRC20,BEP20,ERC20" className="w-40 sm:w-52 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs font-mono" /></td>
                    <td className="px-2 py-2"><input type="number" step="0.1" value={c.fee_pct} onChange={(e) => updCryptoRow(idx, 'fee_pct', parseFloat(e.target.value) || 0)} className="w-14 sm:w-16 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                    <td className="px-2 py-2"><input type="number" step="0.0001" value={c.fee_fixed || 0} onChange={(e) => updCryptoRow(idx, 'fee_fixed', parseFloat(e.target.value) || 0)} className="w-16 sm:w-20 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                    <td className="px-2 py-2"><input type="number" step="0.0001" value={c.min} onChange={(e) => updCryptoRow(idx, 'min', parseFloat(e.target.value) || 0)} className="w-16 sm:w-20 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                    <td className="px-2 py-2"><input type="number" step="0.0001" value={c.max} onChange={(e) => updCryptoRow(idx, 'max', parseFloat(e.target.value) || 0)} className="w-20 sm:w-24 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                    <td className="px-2 py-2 text-center"><input type="checkbox" checked={c.active} onChange={(e) => updCryptoRow(idx, 'active', e.target.checked)} className="w-4 h-4 accent-[#2563EB]" /></td>
                    <td className="px-2 py-2 text-center"><button onClick={() => removeCryptoRow(idx)} className="text-red-500"><Trash2 className="w-3.5 h-3.5" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Networks */}
        <div className="mt-3 pt-4 border-t border-slate-100">
          <div className="flex items-center justify-between mb-2">
            <div className="font-cabinet font-bold text-[11px] sm:text-xs text-slate-900 flex items-center gap-1.5"><Network className="w-3.5 h-3.5" /> Réseaux blockchain</div>
            <button onClick={addNetworkRow} data-testid="btn-add-network" className="text-[11px] sm:text-xs font-semibold text-[#2563EB] inline-flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> Ajouter</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] sm:text-xs">
              <thead className="bg-slate-50 text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <tr><th className="text-left px-2 py-2">Code</th><th className="text-left px-2 py-2">Nom</th><th className="text-left px-2 py-2">Regex adresse</th><th className="text-center px-2 py-2">Actif</th><th className="text-center px-2 py-2"></th></tr>
              </thead>
              <tbody>
                {(crypto.networks || []).map((n, idx) => (
                  <tr key={idx} className="border-t border-slate-50" data-testid={`network-row-${idx}`}>
                    <td className="px-2 py-2"><input value={n.code} onChange={(e) => updNetworkRow(idx, 'code', e.target.value.toUpperCase())} className="w-20 sm:w-24 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs font-mono" /></td>
                    <td className="px-2 py-2"><input value={n.name} onChange={(e) => updNetworkRow(idx, 'name', e.target.value)} className="w-40 sm:w-52 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs" /></td>
                    <td className="px-2 py-2"><input value={n.address_regex || ''} onChange={(e) => updNetworkRow(idx, 'address_regex', e.target.value)} placeholder="^T[A-Za-z1-9]{33}$" className="w-56 sm:w-72 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs font-mono" /></td>
                    <td className="px-2 py-2 text-center"><input type="checkbox" checked={n.active} onChange={(e) => updNetworkRow(idx, 'active', e.target.checked)} className="w-4 h-4 accent-[#2563EB]" /></td>
                    <td className="px-2 py-2 text-center"><button onClick={() => removeNetworkRow(idx)} className="text-red-500"><Trash2 className="w-3.5 h-3.5" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* USDT networks quick selector */}
        <div className="mt-3 pt-4 border-t border-slate-100">
          <div className="font-cabinet font-bold text-[11px] sm:text-xs text-slate-900 mb-2">Réseaux USDT activés (portefeuille utilisateur)</div>
          <div className="flex flex-wrap gap-2">
            {(crypto.networks || []).filter((n) => n.active).map((n) => {
              const active = (crypto.usdt_networks || []).includes(n.code);
              return (
                <button key={n.code} onClick={() => {
                  const cur = new Set(crypto.usdt_networks || []);
                  if (active) cur.delete(n.code); else cur.add(n.code);
                  updCrypto({ usdt_networks: Array.from(cur) });
                }} data-testid={`usdt-net-${n.code}`} className={`px-3 py-1.5 rounded-full border text-[11px] font-semibold ${active ? 'border-[#2563EB] bg-blue-50 text-[#2563EB]' : 'border-slate-200 text-slate-500'}`}>
                  {active ? '✓' : '+'} {n.code}
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 text-[10px] text-slate-500">Choisissez les réseaux proposés aux utilisateurs lors des opérations USDT.</div>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, subtitle, Icon, iconBg, enabled, onToggle, testId, children }) {
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
        <button onClick={onToggle} data-testid={`toggle-${testId}`} className={`flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-full font-bold text-[10px] sm:text-xs shrink-0 ${enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
          {enabled ? <ToggleRight className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <ToggleLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
          {enabled ? 'Activé' : 'Désactivé'}
        </button>
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

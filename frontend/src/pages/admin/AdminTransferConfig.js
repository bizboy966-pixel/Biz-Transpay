import { useEffect, useState } from 'react';
import { Save, Plus, Trash2, ToggleLeft, ToggleRight, Smartphone, Bitcoin, Network } from 'lucide-react';
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
        mobile_money: cfg.mobile_money, crypto: cfg.crypto,
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
  const crypto = cfg.crypto || { enabled: false, cryptos: [], networks: [] };

  const setSection = (section, val) => { setCfg({ ...cfg, [section]: val }); setDirty(true); };
  const setEnabled = (section, enabled) => patchSection(section, { enabled });

  const updateOp = (idx, key, val) => {
    const ops = [...mm.operators];
    ops[idx] = { ...ops[idx], [key]: val };
    setSection('mobile_money', { ...mm, operators: ops });
  };
  const addOp = () => setSection('mobile_money', { ...mm, operators: [...mm.operators, { country: 'TG', code: '', name: '', gateway_fee_pct: 1.5, platform_fee_pct: 0, fee_pct: 1.5, min: 100, max: 500000, active: true }] });
  const removeOp = (idx) => setSection('mobile_money', { ...mm, operators: mm.operators.filter((_, i) => i !== idx) });

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
              <tr>
                <th className="text-left px-2 sm:px-3 py-2">Pays</th>
                <th className="text-left px-2 sm:px-3 py-2">Code</th>
                <th className="text-left px-2 sm:px-3 py-2">Nom</th>
                <th className="text-right px-2 sm:px-3 py-2">Frais passerelle %</th>
                <th className="text-right px-2 sm:px-3 py-2">Frais plateforme %</th>
                <th className="text-right px-2 sm:px-3 py-2">Total %</th>
                <th className="text-right px-2 sm:px-3 py-2">Min</th>
                <th className="text-right px-2 sm:px-3 py-2">Max</th>
                <th className="text-center px-2 sm:px-3 py-2">Actif</th>
                <th className="text-center px-2 sm:px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {mm.operators.map((o, idx) => {
                const gateway = o.gateway_fee_pct ?? o.fee_pct ?? 0;
                const platform = o.platform_fee_pct ?? 0;
                const total = +(gateway + platform).toFixed(4);
                return (
                <tr key={idx} data-testid={`op-row-${idx}`} className="border-t border-slate-50">
                  <td className="px-2 sm:px-3 py-2"><select value={o.country} onChange={(e) => updateOp(idx, 'country', e.target.value)} className="px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs">{COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}</select></td>
                  <td className="px-2 sm:px-3 py-2"><input value={o.code} onChange={(e) => updateOp(idx, 'code', e.target.value.toLowerCase())} className="w-20 sm:w-24 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs font-mono" /></td>
                  <td className="px-2 sm:px-3 py-2"><input value={o.name} onChange={(e) => updateOp(idx, 'name', e.target.value)} className="w-32 sm:w-40 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs" /></td>
                  <td className="px-2 sm:px-3 py-2">
                    <input type="number" step="0.1" min="0"
                      value={gateway}
                      onChange={(e) => {
                        const g = parseFloat(e.target.value) || 0;
                        const p = parseFloat(o.platform_fee_pct) || 0;
                        const ops = [...mm.operators];
                        ops[idx] = { ...ops[idx], gateway_fee_pct: g, fee_pct: +(g + p).toFixed(4) };
                        setSection('mobile_money', { ...mm, operators: ops });
                      }}
                      data-testid={`op-gateway-fee-${idx}`}
                      className="w-14 sm:w-16 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" />
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <input type="number" step="0.1" min="0"
                      value={platform}
                      onChange={(e) => {
                        const p = parseFloat(e.target.value) || 0;
                        const g = parseFloat(o.gateway_fee_pct ?? o.fee_pct) || 0;
                        const ops = [...mm.operators];
                        ops[idx] = { ...ops[idx], platform_fee_pct: p, fee_pct: +(g + p).toFixed(4) };
                        setSection('mobile_money', { ...mm, operators: ops });
                      }}
                      data-testid={`op-platform-fee-${idx}`}
                      className="w-14 sm:w-16 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" />
                  </td>
                  <td className="px-2 sm:px-3 py-2 text-right">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold" data-testid={`op-total-fee-${idx}`}>
                      {total.toFixed(2)} %
                    </span>
                  </td>
                  <td className="px-2 sm:px-3 py-2"><input type="number" value={o.min} onChange={(e) => updateOp(idx, 'min', parseInt(e.target.value) || 0)} className="w-16 sm:w-20 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                  <td className="px-2 sm:px-3 py-2"><input type="number" value={o.max} onChange={(e) => updateOp(idx, 'max', parseInt(e.target.value) || 0)} className="w-20 sm:w-24 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" /></td>
                  <td className="px-2 sm:px-3 py-2 text-center"><input type="checkbox" checked={o.active} onChange={(e) => updateOp(idx, 'active', e.target.checked)} className="w-4 h-4 accent-[#2563EB]" /></td>
                  <td className="px-2 sm:px-3 py-2 text-center"><button onClick={() => removeOp(idx)} data-testid={`btn-remove-op-${idx}`} className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center mx-auto"><Trash2 className="w-3.5 h-3.5" /></button></td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
        <button onClick={addOp} data-testid="btn-add-op" className="mt-3 inline-flex items-center gap-1.5 text-[11px] sm:text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8]"><Plus className="w-3.5 h-3.5" /> Ajouter un opérateur</button>
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
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get('/admin/crypto/coins', { params: { direction: 'withdrawal' } })
      .then(({ data }) => setCoins(data)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const hidden = new Set(crypto.hidden_coins || []);

  // Reads (gateway, platform) split for a given coin. Falls back to the legacy
  // single `fees[coin]` value stored as the gateway share for retro-compatibility.
  const getSplit = (coin, legacyTotal) => {
    const feesG = crypto.fees_gateway || {};
    const feesP = crypto.fees_platform || {};
    const feesGFixed = crypto.fees_gateway_fixed || {};
    const gateway = feesG[coin] !== undefined ? feesG[coin] : (legacyTotal ?? 4);
    const platform = feesP[coin] !== undefined ? feesP[coin] : 0;
    const gatewayFixed = feesGFixed[coin] !== undefined ? feesGFixed[coin] : 0;
    return { gateway: +gateway, platform: +platform, gatewayFixed: +gatewayFixed };
  };

  const setPart = (coin, part, val) => {
    const num = parseFloat(val);
    const safe = isNaN(num) ? 0 : num;
    const feesG = { ...(crypto.fees_gateway || {}) };
    const feesP = { ...(crypto.fees_platform || {}) };
    const feesGFixed = { ...(crypto.fees_gateway_fixed || {}) };
    const fees = { ...(crypto.fees || {}) };
    // Seed both maps from legacy if missing
    if (feesG[coin] === undefined) feesG[coin] = fees[coin] !== undefined ? fees[coin] : 4;
    if (feesP[coin] === undefined) feesP[coin] = 0;
    if (feesGFixed[coin] === undefined) feesGFixed[coin] = 0;
    if (part === 'gateway') feesG[coin] = safe;
    else if (part === 'platform') feesP[coin] = safe;
    else if (part === 'gateway_fixed') feesGFixed[coin] = safe;
    const total = +((feesG[coin] || 0) + (feesP[coin] || 0)).toFixed(4);
    fees[coin] = total;
    updCrypto({ fees, fees_gateway: feesG, fees_platform: feesP, fees_gateway_fixed: feesGFixed });
    setCoins((cs) => cs.map((c) => c.coin === coin ? { ...c, fee_pct: total } : c));
  };

  const hideCoin = (coin) => {
    const set = new Set(crypto.hidden_coins || []);
    set.add(coin);
    updCrypto({ hidden_coins: Array.from(set) });
    toast.success(`${coin} supprimé de la liste des retraits`);
  };
  const restoreCoin = (coin) => {
    const arr = (crypto.hidden_coins || []).filter((c) => c !== coin);
    updCrypto({ hidden_coins: arr });
    toast.success(`${coin} restauré`);
  };

  const visible = coins.filter((c) => showHidden ? true : !hidden.has(c.coin));
  const filtered = visible.filter((c) => !filter || c.coin.includes(filter.toUpperCase()) || (c.name || '').toLowerCase().includes(filter.toLowerCase()));
  const hiddenCount = coins.filter((c) => hidden.has(c.coin)).length;

  return (
    <div className="mt-1">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <div className="font-cabinet font-bold text-[12px] sm:text-sm text-slate-900 flex items-center gap-1.5"><Bitcoin className="w-3.5 h-3.5" /> Frais de retrait par cryptomonnaie</div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 mt-0.5">Défaut : 4 %. Passerelle + Plateforme = frais total appliqué. Les cryptos sont chargées automatiquement depuis IzichangePay.</div>
        </div>
        <div className="flex items-center gap-2">
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setShowHidden((v) => !v)} data-testid="btn-toggle-hidden-withdraw"
              className="text-[10px] sm:text-[11px] font-semibold text-[#2563EB] hover:text-[#1D4ED8] underline underline-offset-2">
              {showHidden ? 'Masquer les actifs supprimés' : `Afficher les actifs supprimés (${hiddenCount})`}
            </button>
          )}
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Rechercher (BTC, USDT…)" className="px-3 py-1.5 border border-slate-200 rounded-lg text-[11px] sm:text-xs w-40 sm:w-48" data-testid="crypto-fee-filter" />
        </div>
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
              <th className="text-right px-2 sm:px-3 py-2">Frais passerelle %</th>
              <th className="text-right px-2 sm:px-3 py-2">Frais passerelle fixe</th>
              <th className="text-right px-2 sm:px-3 py-2">Frais plateforme %</th>
              <th className="text-right px-2 sm:px-3 py-2">Total</th>
              <th className="text-center px-2 sm:px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const { gateway, platform, gatewayFixed } = getSplit(c.coin, c.fee_pct);
              const totalPct = +(gateway + platform).toFixed(4);
              const isHidden = hidden.has(c.coin);
              return (
              <tr key={c.coin} className={`border-t border-slate-50 ${isHidden ? 'opacity-50 bg-slate-50/50' : ''}`} data-testid={`crypto-fee-row-${c.coin}`}>
                <td className="px-2 sm:px-3 py-2 font-mono font-bold text-slate-900">{c.coin}</td>
                <td className="px-2 sm:px-3 py-2 text-slate-600">
                  {c.name}
                  {isHidden && <span className="ml-1 text-[9px] font-bold text-red-500 uppercase">Supprimé</span>}
                </td>
                <td className="px-2 sm:px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <input type="number" step="0.1" min="0" max="100" value={gateway} disabled={isHidden}
                      onChange={(e) => setPart(c.coin, 'gateway', e.target.value)}
                      data-testid={`crypto-fee-gateway-${c.coin}`}
                      className="w-16 sm:w-20 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right font-mono disabled:bg-slate-100" />
                    <span className="text-slate-400 text-[10px]">%</span>
                  </div>
                </td>
                <td className="px-2 sm:px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <input type="number" step="0.0001" min="0" value={gatewayFixed} disabled={isHidden}
                      onChange={(e) => setPart(c.coin, 'gateway_fixed', e.target.value)}
                      data-testid={`crypto-fee-gateway-fixed-${c.coin}`}
                      className="w-20 sm:w-24 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right font-mono disabled:bg-slate-100" />
                    <span className="text-slate-400 text-[10px]">{c.coin}</span>
                  </div>
                </td>
                <td className="px-2 sm:px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <input type="number" step="0.1" min="0" max="100" value={platform} disabled={isHidden}
                      onChange={(e) => setPart(c.coin, 'platform', e.target.value)}
                      data-testid={`crypto-fee-platform-${c.coin}`}
                      className="w-16 sm:w-20 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right font-mono disabled:bg-slate-100" />
                    <span className="text-slate-400 text-[10px]">%</span>
                  </div>
                </td>
                <td className="px-2 sm:px-3 py-2 text-right">
                  <div className="inline-flex flex-col items-end gap-0.5">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold" data-testid={`crypto-fee-total-${c.coin}`}>
                      {totalPct.toFixed(2)} %
                    </span>
                    {gatewayFixed > 0 && (
                      <span className="text-[9px] font-mono font-bold text-orange-600" data-testid={`crypto-fee-total-fixed-${c.coin}`}>
                        + {gatewayFixed} {c.coin}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-2 sm:px-3 py-2 text-center">
                  {isHidden ? (
                    <button onClick={() => restoreCoin(c.coin)} data-testid={`btn-restore-${c.coin}`}
                      className="text-[10px] font-bold text-emerald-600 hover:text-emerald-700 px-2 py-1 rounded-lg hover:bg-emerald-50">
                      Restaurer
                    </button>
                  ) : (
                    <button onClick={() => hideCoin(c.coin)} data-testid={`btn-hide-${c.coin}`}
                      className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center mx-auto" title="Supprimer cet actif">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            );})}
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

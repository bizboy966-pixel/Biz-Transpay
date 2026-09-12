import { useEffect, useState } from 'react';
import { Save, Trash2, ToggleLeft, ToggleRight, RefreshCw, Smartphone, ArrowDownToLine, Bitcoin } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

export default function AdminDepositConfig() {
  const [cfg, setCfg] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [savingSection, setSavingSection] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = () => api.get('/admin/deposit/config').then(({ data }) => setCfg(data)).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      await api.patch('/admin/deposit/config', {
        mobile_money: cfg.mobile_money,
        crypto: cfg.crypto,
      });
      toast.success('Configuration enregistrée');
      setDirty(false);
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  const patchSection = async (section, patch) => {
    setSavingSection(section);
    try {
      const merged = { ...(cfg[section] || {}), ...patch };
      const { data } = await api.patch('/admin/deposit/config', { [section]: merged });
      setCfg(data);
      toast.success(patch.enabled ? 'Activé' : 'Désactivé');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Erreur');
    } finally { setSavingSection(null); }
  };

  if (!cfg) return <div className="text-slate-500 text-sm">Chargement…</div>;
  const mm = cfg.mobile_money || { enabled: true, operators: [] };
  const crypto = cfg.crypto || { enabled: true, fees: {}, fees_gateway: {}, fees_platform: {}, hidden_coins: [] };
  const setMM = (v) => { setCfg({ ...cfg, mobile_money: v }); setDirty(true); };
  const setCrypto = (v) => { setCfg({ ...cfg, crypto: v }); setDirty(true); };
  const updCrypto = (patch) => setCrypto({ ...crypto, ...patch });
  const setEnabled = (enabled) => patchSection('mobile_money', { enabled });
  const setCryptoEnabled = (enabled) => patchSection('crypto', { enabled });

  const updateOp = (idx, key, val) => {
    const ops = [...mm.operators];
    ops[idx] = { ...ops[idx], [key]: val };
    setMM({ ...mm, operators: ops });
  };
  // Countries currently used in the ops list — displayed with a summary badge
  const countryCounts = mm.operators.reduce((acc, o) => {
    acc[o.country] = (acc[o.country] || 0) + 1;
    return acc;
  }, {});
  const visibleOperators = mm.operators.filter((o) => showHidden || !o.hidden);
  const hiddenCount = mm.operators.filter((o) => o.hidden).length;

  const syncCatalog = async () => {
    setSyncing(true);
    try {
      const { data } = await api.post('/admin/deposit/catalog/sync');
      setCfg(data);
      setDirty(false);
      toast.success('Catalogue FedaPay synchronisé');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Synchronisation impossible');
    } finally { setSyncing(false); }
  };

  return (
    <div className="space-y-4 sm:space-y-6" data-testid="admin-deposit-config">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-cabinet font-bold text-slate-900 text-base sm:text-lg">Configuration des dépôts</h1>
          <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
            Catalogue fourni par FedaPay. Vous pouvez régler les frais plateforme,
            les limites et l&apos;état local, sans créer d&apos;opérateur.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={syncCatalog} disabled={syncing} data-testid="btn-sync-deposit-catalog"
            className="inline-flex items-center gap-2 border border-slate-200 text-slate-700 hover:bg-slate-50 font-bold px-3 py-2 rounded-full text-[11px] sm:text-xs disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> {syncing ? 'Synchronisation…' : 'Synchroniser'}
          </button>
          <button onClick={save} disabled={!dirty} data-testid="btn-save-deposit-config"
            className="inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-3 sm:px-4 py-2 rounded-full text-[11px] sm:text-xs disabled:opacity-50">
            <Save className="w-3.5 h-3.5" /> Enregistrer
          </button>
        </div>
      </div>

      <Section
        title="Dépôts → Mobile Money"
        subtitle={`${mm.operators.length} capacités FedaPay — ${Object.keys(countryCounts).length} pays`}
        Icon={ArrowDownToLine}
        iconBg="bg-blue-50 text-[#2563EB]"
        enabled={mm.enabled}
        saving={savingSection === 'mobile_money'}
        onEnabledChange={setEnabled}
        testId="mm-deposit"
      >
        {/* Country summary chips */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {Object.entries(countryCounts).map(([code, count]) => (
            <span key={code} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700">
              {code} · {count}
            </span>
          ))}
          {hiddenCount > 0 && <button type="button" onClick={() => setShowHidden((v) => !v)} className="text-[10px] font-semibold text-[#2563EB] underline underline-offset-2">{showHidden ? 'Masquer les capacités masquées' : `Afficher les capacités masquées (${hiddenCount})`}</button>}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[11px] sm:text-xs">
            <thead className="bg-slate-50 text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-2 sm:px-3 py-2">Pays</th>
                <th className="text-left px-2 sm:px-3 py-2">Code</th>
                <th className="text-left px-2 sm:px-3 py-2">Nom affiché</th>
                <th className="text-left px-2 sm:px-3 py-2">Devise</th>
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
              {visibleOperators.map((o, idx) => (
                <tr key={`${o.country}-${o.code}`} data-testid={`dep-op-row-${idx}`} className={`border-t border-slate-50 ${o.hidden ? 'opacity-55 bg-slate-50' : ''}`}>
                  <td className="px-2 sm:px-3 py-2">
                    <span className="font-mono font-bold text-slate-900">{o.country}</span>
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <span className="font-mono text-slate-600">{o.code}</span>
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <span className="text-slate-700">{o.name}</span>
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <span className="font-mono text-slate-600">{o.currency || 'XOF'}</span>
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <input type="number" step="0.1" min="0"
                      value={o.gateway_fee_pct ?? o.fee_pct ?? 0}
                      onChange={(e) => {
                        const g = parseFloat(e.target.value) || 0;
                        const p = parseFloat(o.platform_fee_pct) || 0;
                        const rowIndex = mm.operators.indexOf(o);
                        const ops = [...mm.operators];
                        ops[rowIndex] = { ...ops[rowIndex], gateway_fee_pct: g, fee_pct: +(g + p).toFixed(4) };
                        setMM({ ...mm, operators: ops });
                      }}
                      data-testid={`dep-op-gateway-fee-${idx}`}
                      className="w-14 sm:w-16 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" />
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <input type="number" step="0.1" min="0"
                      value={o.platform_fee_pct ?? 0}
                      onChange={(e) => {
                        const p = parseFloat(e.target.value) || 0;
                        const g = parseFloat(o.gateway_fee_pct ?? o.fee_pct) || 0;
                        const rowIndex = mm.operators.indexOf(o);
                        const ops = [...mm.operators];
                        ops[rowIndex] = { ...ops[rowIndex], platform_fee_pct: p, fee_pct: +(g + p).toFixed(4) };
                        setMM({ ...mm, operators: ops });
                      }}
                      data-testid={`dep-op-platform-fee-${idx}`}
                      className="w-14 sm:w-16 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" />
                  </td>
                  <td className="px-2 sm:px-3 py-2 text-right">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold" data-testid={`dep-op-total-fee-${idx}`}>
                      {((o.gateway_fee_pct ?? o.fee_pct ?? 0) + (o.platform_fee_pct ?? 0)).toFixed(2)} %
                    </span>
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <input type="number" value={o.min} min="0" onChange={(e) => updateOp(mm.operators.indexOf(o), 'min', parseInt(e.target.value) || 0)} data-testid={`dep-op-min-${idx}`}
                      className="w-20 sm:w-24 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" />
                  </td>
                  <td className="px-2 sm:px-3 py-2">
                    <input type="number" value={o.max} min="0" onChange={(e) => updateOp(mm.operators.indexOf(o), 'max', parseInt(e.target.value) || 0)} data-testid={`dep-op-max-${idx}`}
                      className="w-24 sm:w-28 px-1.5 sm:px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right" />
                  </td>
                  <td className="px-2 sm:px-3 py-2 text-center">
                    <input type="checkbox" checked={!!o.active} onChange={(e) => updateOp(mm.operators.indexOf(o), 'active', e.target.checked)} data-testid={`dep-op-active-${idx}`}
                      className="w-4 h-4 accent-[#2563EB]" />
                  </td>
                  <td className="px-2 sm:px-3 py-2 text-center">
                    {o.hidden ? (
                      <button onClick={() => updateOp(mm.operators.indexOf(o), 'hidden', false)} className="text-[10px] font-bold text-emerald-600">Restaurer</button>
                    ) : (
                      <button onClick={() => updateOp(mm.operators.indexOf(o), 'hidden', true)} data-testid={`dep-op-hide-${idx}`}
                        className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center mx-auto" title="Masquer cette capacité">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {visibleOperators.length === 0 && (
                <tr><td colSpan={11} className="text-center py-6 text-[11px] text-slate-400">Aucune capacité fournie par FedaPay.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50/60 p-3 text-[11px] text-slate-600 leading-relaxed">
          <div className="flex items-center gap-1.5 font-bold text-slate-700 mb-1"><Smartphone className="w-3 h-3" /> Application des frais</div>
          Les frais et limites configurés ici sont appliqués <b>automatiquement</b> à tous les dépôts Mobile Money :
          <ul className="list-disc list-inside mt-1 space-y-0.5">
            <li>Dépôts directs depuis le tableau de bord</li>
            <li>Paiements via lien de paiement</li>
            <li>Paiements initiés via l'API marchand</li>
          </ul>
          Toute modification est prise en compte <b>immédiatement</b>, sans redémarrage.
        </div>
      </Section>

      {/* Crypto deposit fees */}
      <Section
        title="Dépôts → Crypto"
        subtitle="Cryptomonnaies, frais Passerelle + Plateforme"
        Icon={Bitcoin}
        iconBg="bg-orange-50 text-orange-600"
        enabled={crypto.enabled !== false}
        saving={savingSection === 'crypto'}
        onEnabledChange={setCryptoEnabled}
        testId="crypto-deposit"
      >
        <CryptoDepositFeesTable crypto={crypto} updCrypto={updCrypto} onSaveAll={save} dirty={dirty} savingAll={savingSection === 'save-all'} />
      </Section>
    </div>
  );
}


function CryptoDepositFeesTable({ crypto, updCrypto, onSaveAll, dirty, savingAll }) {
  const [coins, setCoins] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get('/admin/crypto/coins', { params: { direction: 'deposit' } })
      .then(({ data }) => setCoins(data)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const hidden = new Set(crypto.hidden_coins || []);

  const getSplit = (coin, legacyTotal) => {
    const feesG = crypto.fees_gateway || {};
    const feesP = crypto.fees_platform || {};
    const gateway = feesG[coin] !== undefined ? feesG[coin] : (legacyTotal ?? 4);
    const platform = feesP[coin] !== undefined ? feesP[coin] : 0;
    return { gateway: +gateway, platform: +platform };
  };

  const setPart = (coin, part, val) => {
    const num = parseFloat(val);
    const safe = isNaN(num) ? 0 : num;
    const feesG = { ...(crypto.fees_gateway || {}) };
    const feesP = { ...(crypto.fees_platform || {}) };
    const fees = { ...(crypto.fees || {}) };
    if (feesG[coin] === undefined) feesG[coin] = fees[coin] !== undefined ? fees[coin] : 4;
    if (feesP[coin] === undefined) feesP[coin] = 0;
    if (part === 'gateway') feesG[coin] = safe;
    else feesP[coin] = safe;
    const total = +((feesG[coin] || 0) + (feesP[coin] || 0)).toFixed(4);
    fees[coin] = total;
    updCrypto({ fees, fees_gateway: feesG, fees_platform: feesP });
    setCoins((cs) => cs.map((c) => c.coin === coin ? { ...c, fee_pct: total } : c));
  };

  const hideCoin = (coin) => {
    const set = new Set(crypto.hidden_coins || []);
    set.add(coin);
    updCrypto({ hidden_coins: Array.from(set) });
    toast.success(`${coin} supprimé de la liste des dépôts`);
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
          <div className="font-cabinet font-bold text-[12px] sm:text-sm text-slate-900 flex items-center gap-1.5"><Bitcoin className="w-3.5 h-3.5" /> Frais de dépôt par cryptomonnaie</div>
          <div className="text-[10px] sm:text-[11px] text-slate-500 mt-0.5">Défaut : 4 %. Passerelle + Plateforme = frais total appliqué. Les cryptos sont chargées automatiquement depuis IzichangePay.</div>
        </div>
        <div className="flex items-center gap-2">
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setShowHidden((v) => !v)} data-testid="btn-toggle-hidden-deposit"
              className="text-[10px] sm:text-[11px] font-semibold text-[#2563EB] hover:text-[#1D4ED8] underline underline-offset-2">
              {showHidden ? 'Masquer les actifs supprimés' : `Afficher les actifs supprimés (${hiddenCount})`}
            </button>
          )}
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Rechercher (BTC, USDT…)" className="px-3 py-1.5 border border-slate-200 rounded-lg text-[11px] sm:text-xs w-40 sm:w-48" data-testid="crypto-dep-fee-filter" />
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
              <th className="text-right px-2 sm:px-3 py-2">Frais plateforme %</th>
              <th className="text-right px-2 sm:px-3 py-2">Total %</th>
              <th className="text-center px-2 sm:px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const { gateway, platform } = getSplit(c.coin, c.fee_pct);
              const total = +(gateway + platform).toFixed(4);
              const isHidden = hidden.has(c.coin);
              return (
              <tr key={c.coin} className={`border-t border-slate-50 ${isHidden ? 'opacity-50 bg-slate-50/50' : ''}`} data-testid={`crypto-dep-fee-row-${c.coin}`}>
                <td className="px-2 sm:px-3 py-2 font-mono font-bold text-slate-900">{c.coin}</td>
                <td className="px-2 sm:px-3 py-2 text-slate-600">
                  {c.name}
                  {isHidden && <span className="ml-1 text-[9px] font-bold text-red-500 uppercase">Supprimé</span>}
                </td>
                <td className="px-2 sm:px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <input type="number" step="0.1" min="0" max="100" value={gateway} disabled={isHidden}
                      onChange={(e) => setPart(c.coin, 'gateway', e.target.value)}
                      data-testid={`crypto-dep-fee-gateway-${c.coin}`}
                      className="w-16 sm:w-20 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right font-mono disabled:bg-slate-100" />
                    <span className="text-slate-400 text-[10px]">%</span>
                  </div>
                </td>
                <td className="px-2 sm:px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <input type="number" step="0.1" min="0" max="100" value={platform} disabled={isHidden}
                      onChange={(e) => setPart(c.coin, 'platform', e.target.value)}
                      data-testid={`crypto-dep-fee-platform-${c.coin}`}
                      className="w-16 sm:w-20 px-2 py-1 border border-slate-200 rounded-lg text-[10px] sm:text-xs text-right font-mono disabled:bg-slate-100" />
                    <span className="text-slate-400 text-[10px]">%</span>
                  </div>
                </td>
                <td className="px-2 sm:px-3 py-2 text-right">
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold" data-testid={`crypto-dep-fee-total-${c.coin}`}>
                    {total.toFixed(2)} %
                  </span>
                </td>
                <td className="px-2 sm:px-3 py-2 text-center">
                  {isHidden ? (
                    <button onClick={() => restoreCoin(c.coin)} data-testid={`btn-dep-restore-${c.coin}`}
                      className="text-[10px] font-bold text-emerald-600 hover:text-emerald-700 px-2 py-1 rounded-lg hover:bg-emerald-50">
                      Restaurer
                    </button>
                  ) : (
                    <button onClick={() => hideCoin(c.coin)} data-testid={`btn-dep-hide-${c.coin}`}
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
          <span>Ces frais s&apos;appliquent à <b>tous les dépôts crypto</b> : dépôts directs, liens de paiement, API marchand. Une modification prend effet immédiatement après l&apos;enregistrement.</span>
        </div>
        <button
          onClick={onSaveAll}
          disabled={!dirty || savingAll}
          data-testid="btn-save-crypto-dep-fees"
          className="inline-flex items-center gap-1.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-4 py-2 rounded-full text-[11px] sm:text-xs disabled:opacity-40 disabled:cursor-not-allowed shrink-0 shadow-sm"
        >
          <Save className="w-3.5 h-3.5" /> {savingAll ? 'Enregistrement…' : dirty ? 'Enregistrer les frais' : 'Enregistré'}
        </button>
      </div>
    </div>
  );
}


function Section({ title, subtitle, Icon, iconBg, enabled, saving, onEnabledChange, children, testId }) {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-3 sm:p-5" data-testid={`section-${testId}`}>
      <div className="flex items-start sm:items-center justify-between mb-3 sm:mb-4 flex-wrap gap-2 sm:gap-3">
        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1">
          <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 ${iconBg}`}>
            <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="font-cabinet font-bold text-slate-900 text-[13px] sm:text-sm truncate">{title}</h2>
            <p className="text-[10px] sm:text-[11px] text-slate-500 truncate">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <span data-testid={`state-${testId}`} className={`hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold text-[10px] ${enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} /> {enabled ? 'Activé' : 'Désactivé'}
          </span>
          {enabled ? (
            <button onClick={() => onEnabledChange(false)} disabled={saving} data-testid={`toggle-${testId}-off`}
              className="inline-flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 rounded-full font-bold text-[10px] sm:text-xs bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50">
              <ToggleRight className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> {saving ? '…' : 'Désactiver'}
            </button>
          ) : (
            <button onClick={() => onEnabledChange(true)} disabled={saving} data-testid={`toggle-${testId}-on`}
              className="inline-flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 rounded-full font-bold text-[10px] sm:text-xs bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
              <ToggleLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> {saving ? '…' : 'Activer'}
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

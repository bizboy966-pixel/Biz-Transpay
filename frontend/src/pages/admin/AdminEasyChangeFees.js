import { useEffect, useMemo, useState } from 'react';
import { Bitcoin, Eye, EyeOff, RefreshCw, Save, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

const EMPTY_CRYPTO = {
  enabled: true,
  fees: {},
  fees_gateway: {},
  fees_platform: {},
  fees_gateway_fixed: {},
  fees_platform_fixed: {},
  hidden_coins: [],
};

export default function AdminEasyChangeFees({ direction }) {
  const isDeposit = direction === 'deposit';
  const [cfg, setCfg] = useState(null);
  const [coins, setCoins] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const configPath = isDeposit ? '/admin/deposit/config' : '/admin/transfer/config';

  const load = async () => {
    setLoading(true);
    try {
      const [{ data: nextCfg }, { data: nextCoins }] = await Promise.all([
        api.get(configPath),
        api.get('/admin/crypto/coins', { params: { direction } }),
      ]);
      setCfg(nextCfg);
      setCoins(nextCoins || []);
      setDirty(false);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Impossible de charger le catalogue Easy Change Pay');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [configPath, direction]); // eslint-disable-line react-hooks/exhaustive-deps

  const crypto = cfg?.crypto || EMPTY_CRYPTO;
  const hidden = useMemo(() => new Set(crypto.hidden_coins || []), [crypto.hidden_coins]);
  const visibleCoins = coins.filter((coin) => showHidden || !hidden.has(coin.coin));

  const patchCrypto = (patch) => {
    setCfg((current) => ({ ...current, crypto: { ...crypto, ...patch } }));
    setDirty(true);
  };

  const getSplit = (coin, fallback) => ({
    gateway: Number(crypto.fees_gateway?.[coin] ?? crypto.fees?.[coin] ?? fallback ?? 0),
    platform: Number(crypto.fees_platform?.[coin] ?? 0),
    gatewayFixed: Number(crypto.fees_gateway_fixed?.[coin] ?? 0),
    platformFixed: Number(crypto.fees_platform_fixed?.[coin] ?? 0),
  });

  const updateFee = (coin, part, value) => {
    const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
    const gateway = { ...(crypto.fees_gateway || {}) };
    const platform = { ...(crypto.fees_platform || {}) };
    const gatewayFixed = { ...(crypto.fees_gateway_fixed || {}) };
    const platformFixed = { ...(crypto.fees_platform_fixed || {}) };
    const fees = { ...(crypto.fees || {}) };
    if (part === 'gateway') gateway[coin] = safe;
    if (part === 'platform') platform[coin] = safe;
    if (part === 'gatewayFixed') gatewayFixed[coin] = safe;
    if (part === 'platformFixed') platformFixed[coin] = safe;
    fees[coin] = Number((gateway[coin] + platform[coin]).toFixed(4));
    patchCrypto({
      fees, fees_gateway: gateway, fees_platform: platform,
      fees_gateway_fixed: gatewayFixed, fees_platform_fixed: platformFixed,
    });
  };

  const toggleHidden = (coin) => {
    const next = new Set(crypto.hidden_coins || []);
    if (next.has(coin)) next.delete(coin);
    else next.add(coin);
    patchCrypto({ hidden_coins: Array.from(next) });
  };

  const toggleEnabled = async () => {
    try {
      const { data } = await api.patch(configPath, {
        crypto: { ...crypto, enabled: crypto.enabled === false },
      });
      setCfg(data);
      toast.success(crypto.enabled === false ? 'Easy Change Pay activé' : 'Easy Change Pay désactivé');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Erreur');
    }
  };

  const save = async () => {
    try {
      const { data } = await api.patch(configPath, { crypto });
      setCfg(data);
      setDirty(false);
      toast.success('Configuration Easy Change Pay enregistrée');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Erreur');
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const { data } = await api.get('/admin/crypto/coins', {
        params: { direction, refresh: true },
      });
      setCoins(data || []);
      toast.success('Catalogue Easy Change Pay synchronisé');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Synchronisation impossible');
    } finally {
      setSyncing(false);
    }
  };

  if (loading || !cfg) return <div className="text-slate-500 text-sm">Chargement du catalogue Easy Change Pay…</div>;

  return (
    <div className="space-y-4 sm:space-y-6" data-testid={`admin-${direction}-config`}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-cabinet font-bold text-slate-900 text-base sm:text-lg">
            {isDeposit ? 'Configuration des dépôts' : 'Configuration des retraits'}
          </h1>
          <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
            Easy Change Pay est la seule passerelle configurée. Les actifs sont chargés depuis son catalogue.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={sync} disabled={syncing} data-testid={`btn-sync-${direction}-catalog`}
            className="inline-flex items-center gap-1.5 border border-slate-200 text-slate-700 font-bold px-3 py-2 rounded-full text-[11px] disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> Synchroniser
          </button>
          <button onClick={save} disabled={!dirty} data-testid={`btn-save-${direction}-config`}
            className="inline-flex items-center gap-1.5 bg-[#2563EB] text-white font-bold px-3 py-2 rounded-full text-[11px] disabled:opacity-50">
            <Save className="w-3.5 h-3.5" /> Enregistrer
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between mb-4 gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center"><Bitcoin className="w-5 h-5" /></div>
            <div>
              <h2 className="font-cabinet font-bold text-slate-900 text-sm sm:text-base">Easy Change Pay</h2>
              <p className="text-[10px] sm:text-[11px] text-slate-500">{coins.length} actifs disponibles</p>
            </div>
          </div>
          <button onClick={toggleEnabled} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full font-bold text-[10px] ${crypto.enabled === false ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {crypto.enabled === false ? <ToggleLeft className="w-4 h-4" /> : <ToggleRight className="w-4 h-4" />}
            {crypto.enabled === false ? 'Activer' : 'Désactiver'}
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <span className="text-[11px] text-slate-500">Frais total = frais passerelle + frais plateforme</span>
          <button onClick={() => setShowHidden((value) => !value)} className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#2563EB]">
            {showHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {showHidden ? 'Masquer les actifs masqués' : `Afficher les actifs masqués (${hidden.size})`}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[11px] sm:text-xs">
            <thead className="bg-slate-50 text-[9px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-2 py-2">Code</th>
                <th className="text-left px-2 py-2">Actif</th>
                <th className="text-right px-2 py-2">Frais passerelle %</th>
                <th className="text-right px-2 py-2">Frais plateforme %</th>
                {isDeposit ? null : <th className="text-right px-2 py-2">Fixe passerelle</th>}
                {isDeposit ? null : <th className="text-right px-2 py-2">Fixe plateforme</th>}
                <th className="text-right px-2 py-2">Total</th>
                <th className="text-center px-2 py-2">Statut</th>
                <th className="text-center px-2 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleCoins.map((coin) => {
                const split = getSplit(coin.coin, coin.fee_pct);
                const total = split.gateway + split.platform;
                const isHidden = hidden.has(coin.coin);
                return (
                  <tr key={coin.coin} className={`border-t border-slate-50 ${isHidden ? 'opacity-50 bg-slate-50' : ''}`}>
                    <td className="px-2 py-2 font-mono font-bold text-slate-900">{coin.coin}</td>
                    <td className="px-2 py-2 text-slate-600">{coin.name}</td>
                    <td className="px-2 py-2 text-right"><input type="number" min="0" step="0.1" value={split.gateway} disabled={isHidden} onChange={(e) => updateFee(coin.coin, 'gateway', e.target.value)} className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-right disabled:bg-slate-100" /></td>
                    <td className="px-2 py-2 text-right"><input type="number" min="0" step="0.1" value={split.platform} disabled={isHidden} onChange={(e) => updateFee(coin.coin, 'platform', e.target.value)} className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-right disabled:bg-slate-100" /></td>
                    {!isDeposit && <td className="px-2 py-2 text-right"><input type="number" min="0" step="0.0001" value={split.gatewayFixed} disabled={isHidden} onChange={(e) => updateFee(coin.coin, 'gatewayFixed', e.target.value)} className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-right disabled:bg-slate-100" /></td>}
                    {!isDeposit && <td className="px-2 py-2 text-right"><input type="number" min="0" step="0.0001" value={split.platformFixed} disabled={isHidden} onChange={(e) => updateFee(coin.coin, 'platformFixed', e.target.value)} className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-right disabled:bg-slate-100" /></td>}
                    <td className="px-2 py-2 text-right">
                      <span className="px-1.5 py-0.5 rounded-md bg-slate-900 text-white font-bold">{total.toFixed(2)}%</span>
                      {!isDeposit && (split.gatewayFixed > 0 || split.platformFixed > 0) && (
                        <span className="block text-[9px] text-slate-500 mt-1">
                          + {(split.gatewayFixed + split.platformFixed).toFixed(6)} {coin.coin}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center"><span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${isHidden ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700'}`}>{isHidden ? 'Masqué' : 'Actif'}</span></td>
                    <td className="px-2 py-2 text-center"><button onClick={() => toggleHidden(coin.coin)} title={isHidden ? 'Restaurer' : 'Masquer'} className="text-red-500 hover:bg-red-50 rounded-lg p-1">{isHidden ? <Eye className="w-3.5 h-3.5 text-emerald-600" /> : <Trash2 className="w-3.5 h-3.5" />}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
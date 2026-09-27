import { useEffect, useMemo, useState } from 'react';
import { Bitcoin, Eye, EyeOff, RefreshCw, Save, ToggleLeft, ToggleRight } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

const EMPTY_CRYPTO = {
  enabled: true,
  fees: {},
  fees_gateway: {},
  fees_platform: {},
  fees_gateway_fixed: {},
  fees_platform_fixed: {},
  disabled_assets: [],
  hidden_coins: [],
};

export default function AdminEasyChangeFees({ direction }) {
  const isDeposit = direction === 'deposit';
  const [cfg, setCfg] = useState(null);
  const [coins, setCoins] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const configPath = isDeposit ? '/admin/deposit/config' : '/admin/transfer/config';

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [{ data: nextCfg }, { data: nextCoins }] = await Promise.all([
        api.get(configPath),
        api.get('/admin/crypto/coins', { params: { direction } }),
      ]);
      setCfg(nextCfg);
      setCoins(nextCoins || []);
      setDirty(false);
    } catch (err) {
      const detail = err.response?.data?.detail;
      const message = typeof detail === 'string'
        ? detail
        : 'Impossible de charger le catalogue Easy Change Pay';
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [configPath, direction]); // eslint-disable-line react-hooks/exhaustive-deps

  const crypto = cfg?.crypto || EMPTY_CRYPTO;
  const disabledAssets = useMemo(
    () => new Set((crypto.disabled_assets || []).map((id) => String(id).toUpperCase())),
    [crypto.disabled_assets],
  );
  const hiddenCoins = useMemo(
    () => new Set((crypto.hidden_coins || []).map((coin) => String(coin).toUpperCase())),
    [crypto.hidden_coins],
  );
  const isAssetEnabled = (asset) => (
    !disabledAssets.has(asset.asset_id) && !hiddenCoins.has(asset.coin)
  );
  const disabledCount = coins.filter((asset) => !isAssetEnabled(asset)).length;
  const visibleCoins = coins.filter((asset) => showHidden || isAssetEnabled(asset));

  const patchCrypto = (patch) => {
    setCfg((current) => ({ ...current, crypto: { ...crypto, ...patch } }));
    setDirty(true);
  };

  const getSplit = (asset) => ({
    gateway: Number(crypto.fees_gateway?.[asset.asset_id]
      ?? crypto.fees_gateway?.[asset.coin] ?? asset.gateway_fee_pct
      ?? asset.fee_pct ?? 0),
    platform: Number(crypto.fees_platform?.[asset.asset_id]
      ?? crypto.fees_platform?.[asset.coin] ?? asset.platform_fee_pct ?? 0),
    gatewayFixed: Number(crypto.fees_gateway_fixed?.[asset.asset_id]
      ?? crypto.fees_gateway_fixed?.[asset.coin] ?? asset.gateway_fee_fixed ?? 0),
    platformFixed: Number(crypto.fees_platform_fixed?.[asset.asset_id]
      ?? crypto.fees_platform_fixed?.[asset.coin] ?? asset.platform_fee_fixed ?? 0),
  });

  const updateFee = (asset, part, value) => {
    const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
    const gateway = { ...(crypto.fees_gateway || {}) };
    const platform = { ...(crypto.fees_platform || {}) };
    const gatewayFixed = { ...(crypto.fees_gateway_fixed || {}) };
    const platformFixed = { ...(crypto.fees_platform_fixed || {}) };
    const fees = { ...(crypto.fees || {}) };
    const id = asset.asset_id;
    const split = getSplit(asset);
    if (part === 'gateway') gateway[id] = safe;
    if (part === 'platform') platform[id] = safe;
    if (part === 'gatewayFixed') gatewayFixed[id] = safe;
    if (part === 'platformFixed') platformFixed[id] = safe;
    fees[id] = Number((
      (part === 'gateway' ? safe : split.gateway)
      + (part === 'platform' ? safe : split.platform)
    ).toFixed(4));
    patchCrypto({
      fees, fees_gateway: gateway, fees_platform: platform,
      fees_gateway_fixed: gatewayFixed, fees_platform_fixed: platformFixed,
    });
  };

  const toggleAsset = (asset) => {
    const disabled = new Set(crypto.disabled_assets || []);
    const hiddenCoins = new Set(crypto.hidden_coins || []);
    if (isAssetEnabled(asset)) {
      disabled.add(asset.asset_id);
    } else {
      if (hiddenCoins.has(asset.coin)) {
        hiddenCoins.delete(asset.coin);
        coins
          .filter((other) => other.coin === asset.coin && other.asset_id !== asset.asset_id)
          .forEach((other) => disabled.add(other.asset_id));
      }
      disabled.delete(asset.asset_id);
    }
    patchCrypto({
      disabled_assets: Array.from(disabled),
      hidden_coins: Array.from(hiddenCoins),
    });
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

  if (!cfg && loading) {
    return <div className="text-slate-500 text-sm">Chargement du catalogue Easy Change Pay…</div>;
  }
  if (!cfg && loadError) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="alert">
        <p>{loadError}</p>
        <button type="button" onClick={load} disabled={loading}
          data-testid={`btn-retry-${direction}-config`}
          className="mt-3 rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-slate-800 border border-amber-200 disabled:opacity-50">
          Réessayer
        </button>
      </div>
    );
  }
  if (!cfg) return <div className="text-slate-500 text-sm">Catalogue Easy Change Pay indisponible.</div>;

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
              <p className="text-[10px] sm:text-[11px] text-slate-500">
                {coins.length} actifs au catalogue · {coins.filter((asset) => asset.provider_active && isAssetEnabled(asset)).length} disponibles chez Easy Change Pay
              </p>
            </div>
          </div>
          <button onClick={toggleEnabled} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full font-bold text-[10px] ${crypto.enabled === false ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {crypto.enabled === false ? <ToggleLeft className="w-4 h-4" /> : <ToggleRight className="w-4 h-4" />}
            {crypto.enabled === false ? 'Activer' : 'Désactiver'}
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <span className="text-[11px] text-slate-500">Activation et frais configurés séparément pour chaque actif et chaque sens.</span>
          <button onClick={() => setShowHidden((value) => !value)} className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#2563EB]">
            {showHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {showHidden ? 'Masquer les actifs désactivés' : `Afficher les actifs désactivés (${disabledCount})`}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[11px] sm:text-xs">
            <thead className="bg-slate-50 text-[9px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-2 py-2">Code</th>
                <th className="text-left px-2 py-2">Actif</th>
                <th className="text-left px-2 py-2">Réseau</th>
                <th className="text-left px-2 py-2">Code fournisseur</th>
                <th className="text-right px-2 py-2">Frais passerelle %</th>
                <th className="text-right px-2 py-2">Frais plateforme %</th>
                <th className="text-right px-2 py-2">Fixe passerelle</th>
                <th className="text-right px-2 py-2">Fixe plateforme</th>
                <th className="text-right px-2 py-2">Total</th>
                <th className="text-center px-2 py-2">Statut</th>
                <th className="text-center px-2 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleCoins.map((asset) => {
                const split = getSplit(asset);
                const total = split.gateway + split.platform;
                const isEnabled = isAssetEnabled(asset);
                const isDisabled = !isEnabled;
                const providerStatus = asset.provider_active
                  ? 'Disponible'
                  : asset.provider_available
                    ? 'Inactif chez le fournisseur'
                    : 'Non listé chez le fournisseur';
                return (
                  <tr key={asset.asset_id} className={`border-t border-slate-50 ${isDisabled ? 'opacity-60 bg-slate-50' : ''}`}>
                    <td className="px-2 py-2 font-mono font-bold text-slate-900">{asset.asset_id}</td>
                    <td className="px-2 py-2 text-slate-600">{asset.name}</td>
                    <td className="px-2 py-2 text-slate-600">{asset.network}</td>
                    <td className="px-2 py-2 font-mono text-[10px] text-slate-500">{asset.provider_asset_code || '—'}</td>
                    <td className="px-2 py-2 text-right"><input type="number" min="0" step="0.1" value={split.gateway} onChange={(e) => updateFee(asset, 'gateway', e.target.value)} className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-right" /></td>
                    <td className="px-2 py-2 text-right"><input type="number" min="0" step="0.1" value={split.platform} onChange={(e) => updateFee(asset, 'platform', e.target.value)} className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-right" /></td>
                    <td className="px-2 py-2 text-right"><input type="number" min="0" step="0.0001" value={split.gatewayFixed} onChange={(e) => updateFee(asset, 'gatewayFixed', e.target.value)} className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-right" /></td>
                    <td className="px-2 py-2 text-right"><input type="number" min="0" step="0.0001" value={split.platformFixed} onChange={(e) => updateFee(asset, 'platformFixed', e.target.value)} className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-right" /></td>
                    <td className="px-2 py-2 text-right">
                      <span className="px-1.5 py-0.5 rounded-md bg-slate-900 text-white font-bold">{total.toFixed(2)}%</span>
                      {(split.gatewayFixed > 0 || split.platformFixed > 0) && (
                        <span className="block text-[9px] text-slate-500 mt-1">
                          + {(split.gatewayFixed + split.platformFixed).toFixed(6)} {asset.coin}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${asset.provider_active && isEnabled ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                        {isDisabled ? 'Désactivé' : providerStatus}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-center">
                      <button
                        onClick={() => toggleAsset(asset)}
                        title={isEnabled ? 'Désactiver cet actif' : 'Activer cet actif'}
                        aria-label={`${isEnabled ? 'Désactiver' : 'Activer'} ${asset.asset_id}`}
                        data-testid={`toggle-asset-${asset.asset_id}`}
                        className={`rounded-lg p-1 ${isEnabled ? 'text-emerald-600' : 'text-slate-500'}`}
                      >
                        {isEnabled
                          ? <ToggleRight className="w-4 h-4" />
                          : <ToggleLeft className="w-4 h-4" />}
                      </button>
                    </td>
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
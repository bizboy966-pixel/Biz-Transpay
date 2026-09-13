import { useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight, Wallet, Info } from 'lucide-react';
import AdminDepositConfig from './AdminDepositConfig';
import AdminTransferConfig from './AdminTransferConfig';
import AdminRates from './AdminRates';

const TABS = [
  { key: 'deposit', label: 'Dépôts', desc: 'Frais Easy Change Pay', I: ArrowDownToLine, color: 'bg-emerald-500', C: AdminDepositConfig },
  { key: 'withdrawal', label: 'Retraits', desc: 'Frais Mobile Money + Easy Change Pay', I: ArrowUpFromLine, color: 'bg-red-500', C: AdminTransferConfig },
  { key: 'conversion', label: 'Conversions', desc: 'Taux + frais des paires USDT ↔ FCFA', I: ArrowLeftRight, color: 'bg-blue-500', C: AdminRates },
];

/**
 * Unified "Frais" hub — regroupe toute la configuration tarifaire de la
 * plateforme en un seul écran avec 3 onglets. Chaque onglet réutilise le
 * composant historique qui gère sa section pour éviter la duplication
 * de logique métier.
 */
export default function AdminFees() {
  const [active, setActive] = useState('deposit');
  const Active = TABS.find((t) => t.key === active)?.C;

  return (
    <div className="space-y-5" data-testid="admin-fees-page">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-700 text-white flex items-center justify-center">
            <Wallet className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-cabinet font-extrabold text-slate-900 text-xl">Frais</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Point central pour configurer <b>tous</b> les frais de la plateforme —
              dépôts, retraits et conversions.
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border border-slate-100 rounded-2xl p-1.5 inline-flex flex-wrap gap-1" data-testid="fees-tabs">
        {TABS.map((t) => {
          const on = active === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setActive(t.key)}
              data-testid={`tab-${t.key}`}
              className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold transition-colors ${on ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'}`}>
              <span className={`w-6 h-6 rounded-md ${on ? 'bg-white/15' : t.color + ' text-white'} flex items-center justify-center`}>
                <t.I className="w-3.5 h-3.5" />
              </span>
              {t.label}
              {on && <span className="hidden md:inline ml-1 text-[10px] font-normal opacity-70">· {t.desc}</span>}
            </button>
          );
        })}
      </div>

      <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 flex gap-2 text-[12px] text-blue-900" data-testid="fees-hint">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          Modifiez librement les taux et frais — les changements sont appliqués immédiatement sur toute la plateforme, côté utilisateur et côté API publique.
        </span>
      </div>

      {/* Active section */}
      <div data-testid={`fees-section-${active}`}>
        {Active && <Active />}
      </div>
    </div>
  );
}

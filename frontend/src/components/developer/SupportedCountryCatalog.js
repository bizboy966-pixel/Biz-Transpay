import { useEffect, useState } from 'react';
import api from '../../api';

const flowLabels = {
  phone_confirmation: 'Confirmation sur téléphone',
  ussd: 'Parcours USSD',
  otp: 'Code de validation',
  redirect: 'Confirmation opérateur',
};

function formatLimit(value, currency) {
  if (value === null || value === undefined) return 'selon opérateur';
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(value)} ${currency}`;
}

function CountryGroups({ groups, emptyMessage }) {
  if (!groups?.length) {
    return <p className="rounded-lg bg-slate-50 px-3 py-4 text-xs leading-relaxed text-slate-500">{emptyMessage}</p>;
  }

  return <div className="space-y-2">
    {groups.map((country) => <div key={country.country} className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="font-cabinet text-sm font-bold text-slate-900">{country.country_label}</h4>
        <span className="font-mono text-[10px] font-semibold text-slate-400">{country.country}</span>
      </div>
      <div className="mt-2 space-y-2">
        {country.routes.map((route) => <div key={`${route.operator_code}-${route.currency}`} className="border-t border-slate-100 pt-2 first:border-0 first:pt-0">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-xs font-semibold text-slate-700">{route.operator_name}</span>
            <span className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-blue-700">{route.operator_code}</span>
          </div>
          <div className="mt-1 flex flex-wrap justify-between gap-x-3 gap-y-1 text-[10px] text-slate-500">
            <span>{route.currency} · {formatLimit(route.minimum, route.currency)} – {formatLimit(route.maximum, route.currency)}</span>
            {route.customer_flow && <span>{flowLabels[route.customer_flow] || flowLabels.phone_confirmation}</span>}
          </div>
        </div>)}
      </div>
    </div>)}
  </div>;
}

function CatalogCard({ title, description, groups, emptyMessage }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-4">
    <h3 className="font-cabinet text-sm font-bold text-slate-900">{title}</h3>
    <p className="mb-3 mt-1 text-[11px] leading-relaxed text-slate-500">{description}</p>
    <CountryGroups groups={groups} emptyMessage={emptyMessage} />
  </div>;
}

export default function SupportedCountryCatalog() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    api.get('/documentation/catalog')
      .then(({ data }) => {
        if (mounted) setCatalog(data);
      })
      .catch(() => {
        if (mounted) setError(true);
      });
    return () => { mounted = false; };
  }, []);

  return <section id="countries" className="scroll-mt-24 mt-12">
    <h2 className="font-cabinet text-2xl font-extrabold text-slate-900">Pays, opérateurs et intégration</h2>
    <p className="mt-2 text-[14px] leading-relaxed text-slate-700">
      Le catalogue distingue les routes intégrées des routes réellement activées. Les routes actives peuvent varier selon la configuration du compte et de l’environnement.
      Utilisez le code opérateur et la devise indiqués ci-dessous. Le catalogue JSON public est disponible sur <code>GET /api/documentation/catalog</code>.
    </p>
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-4">
        <h3 className="font-cabinet text-sm font-bold text-blue-950">Dépôts locaux</h3>
        <p className="mt-1 text-xs leading-relaxed text-blue-900/80">
          Les méthodes listées comprennent Mobile Money et d'autres moyens locaux lorsqu'ils sont proposés (par exemple EFT). Pour une route Mobile Money, envoyez <code>country</code>, <code>operator</code> et <code>currency</code>; utilisez <code>POST /v1/direct-payments</code> pour la confirmation téléphone, ou <code>POST /v1/checkout</code> (PAR) / <code>POST /v1/psr</code> si ces parcours sont activés pour la route.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-blue-900/80">
          Après création, conservez l'identifiant et vérifiez <code>GET /v1/payments/{'{id}'}/status</code> ou le webhook signé. Ne validez pas une commande sur un statut <code>pending</code>.
        </p>
      </div>
      <div className="rounded-xl border border-amber-100 bg-amber-50/70 p-4">
        <h3 className="font-cabinet text-sm font-bold text-amber-950">Retraits locaux</h3>
        <p className="mt-1 text-xs leading-relaxed text-amber-900/80">
          Pour les routes de retrait vers un opérateur local, utilisez <code>POST /v1/push</code> avec <code>country</code>, <code>operator</code>, <code>currency</code> et <code>beneficiary_phone</code>, puis suivez <code>GET /v1/push/{'{id}'}/status</code>. Seul le statut <code>completed</code> confirme le succès.
        </p>
      </div>
    </div>

    {error && <p role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
      Le catalogue dynamique n'a pas pu être chargé. Consultez le PDF ou réessayez dans quelques instants.
    </p>}
    {!catalog && !error && <p className="mt-4 text-xs text-slate-500">Chargement du catalogue…</p>}
    {catalog && <div className="mt-5 space-y-6">
      <div>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="font-cabinet text-lg font-bold text-slate-900">Dépôts</h3>
            <p className="text-xs text-slate-500">Les opérateurs éligibles peuvent nécessiter une activation avant les paiements live.</p>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {catalog.payin?.eligible?.length || 0} pays intégrés · {catalog.payin?.available?.length || 0} actifs
          </span>
        </div>
        <div className="grid gap-3 xl:grid-cols-2">
          <CatalogCard
            title="Catalogue éligible"
            description="Couverture technique disponible dans l'intégration."
            groups={catalog.payin?.eligible}
            emptyMessage="Aucun pays éligible n'est actuellement listé."
          />
          <CatalogCard
            title="Routes actuellement disponibles"
            description="Routes actives et configurées sur l'environnement qui sert cette page."
            groups={catalog.payin?.available}
            emptyMessage="Aucune route de dépôt n'est active dans cet environnement pour le moment."
          />
        </div>
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="font-cabinet text-lg font-bold text-slate-900">Retraits locaux</h3>
            <p className="text-xs text-slate-500">Les limites et opérateurs actifs dépendent de la configuration live.</p>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {catalog.payout?.eligible?.length || 0} pays intégrés · {catalog.payout?.available?.length || 0} actifs
          </span>
        </div>
        <div className="grid gap-3 xl:grid-cols-2">
          <CatalogCard
            title="Catalogue éligible"
            description="Couverture technique prise en charge pour les retraits."
            groups={catalog.payout?.eligible}
            emptyMessage="Aucun pays éligible n'est actuellement listé."
          />
          <CatalogCard
            title="Routes actuellement disponibles"
            description="Routes actives et configurées sur l'environnement qui sert cette page."
            groups={catalog.payout?.available}
            emptyMessage="Aucune route de retrait n'est active dans cet environnement pour le moment."
          />
        </div>
      </div>
    </div>}
    <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
      Pour protéger les comptes, ce catalogue public n'inclut ni frais détaillés, ni identifiants de prestataire, ni paramètres d'administration, ni secrets.
    </p>
  </section>;
}
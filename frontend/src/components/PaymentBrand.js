import { useState } from 'react';
import { COUNTRIES } from '@/constants/countries';

const BRANDS = [
  // PayDunya supplies the operator codes and names. These two logos were
  // supplied by the project owner and are served locally for reliable history
  // and transaction-detail rendering.
  { key: 'tmoney', aliases: ['t-money', 'tmoney', 'togocel', 'togocom'], src: '/operator-logos/tmoney.jpeg', label: 'T-Money' },
  { key: 'moov', aliases: ['moov', 'flooz'], src: '/operator-logos/flooz.jpeg', label: 'Moov / Flooz' },
  { key: 'mtn', aliases: ['mtn'], src: 'https://www.mtn.com/wp-content/themes/mtn-refresh/public/img/mtn-logo.svg', label: 'MTN' },
  { key: 'wave', aliases: ['wave'], src: 'https://www.wave.com/img/nav-logo.png', label: 'Wave' },
  { key: 'orange', aliases: ['orange'], src: 'https://www.orange.com/favicon.ico', label: 'Orange Money' },
  { key: 'airtel', aliases: ['airtel'], src: 'https://www.airtel.com/favicon.ico', label: 'Airtel' },
  { key: 'free', aliases: ['free'], src: 'https://www.free.sn/favicon.ico', label: 'Free Money' },
  { key: 'celtiis', aliases: ['celtiis'], src: 'https://celtiis.bj/favicon.ico', label: 'Celtiis' },
  { key: 'yas', aliases: ['yas', 'mixx'], src: 'https://www.yas.tg/favicon.ico', label: 'Yas / Mixx' },
  { key: 'djamo', aliases: ['djamo'], src: 'https://djamo.com/favicon.ico', label: 'Djamo' },
  { key: 'expresso', aliases: ['expresso'], src: 'https://www.expressotelecom.sn/favicon.ico', label: 'Expresso' },
  { key: 'wizall', aliases: ['wizall'], src: 'https://www.wizall.com/favicon.ico', label: 'Wizall' },
];

function normalized(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function findCountry(value) {
  const candidate = normalized(value);
  return COUNTRIES.find((item) => normalized(item.code) === candidate || normalized(item.name) === candidate) || null;
}

export function findBrand(operator, name) {
  const value = normalized(`${operator || ''} ${name || ''}`);
  return BRANDS.find((brand) => brand.aliases.some((alias) => value.includes(alias))) || null;
}

export function CountryBadge({ code, label, className = '' }) {
  const country = findCountry(code);
  if (!country && !label) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} title={label || country?.name || code}>
      <span className="text-base leading-none" aria-hidden="true">{country?.flag || '🌐'}</span>
      {label && <span className="truncate">{label}</span>}
    </span>
  );
}

export function OperatorLogo({ operator, name, logoUrl, size = 'md', className = '' }) {
  const brand = findBrand(operator, name);
  const text = name || operator || 'Mobile Money';
  const [failed, setFailed] = useState(false);
  const sizes = {
    sm: 'h-7 w-7 rounded-lg',
    md: 'h-9 w-9 rounded-xl',
    lg: 'h-12 w-12 rounded-2xl',
  };
  const src = logoUrl || brand?.src;
  if (!brand || !src || failed) {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center bg-slate-100 text-[10px] font-bold text-slate-400 ${sizes[size] || sizes.md} ${className}`} title={text} aria-label={text}>
        <span aria-hidden="true">•••</span>
      </span>
    );
  }
  return (
    <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden bg-white shadow-sm ${sizes[size] || sizes.md} ${className}`} title={name || brand.label} aria-label={name || brand.label}>
       <img src={src} alt="" onError={() => setFailed(true)} className="h-full w-full object-cover p-0" />
    </span>
  );
}

export function PaymentIdentity({ country, countryLabel, operator, operatorName, compact = false }) {
  const hasCountry = country || countryLabel;
  const hasOperator = operator || operatorName;
  if (!hasCountry && !hasOperator) return null;
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${compact ? 'text-[10px]' : 'text-xs'}`}>
      {hasCountry && <CountryBadge code={country} label={countryLabel} />}
      {hasOperator && (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <OperatorLogo operator={operator} name={operatorName} size="sm" />
          <span className="truncate font-semibold text-slate-600">{operatorName || operator}</span>
        </span>
      )}
    </span>
  );
}
import { useState } from 'react';
import { COUNTRIES } from '@/constants/countries';

const BRANDS = [
  // PayDunya supplies identifiers and names, not stable logo URLs. Keep all
  // display assets local so history and transaction details work offline and
  // under the production CSP.
  { key: 'tmoney-tg', country: 'tg', aliases: ['t-money-togo', 'togocel_tg', 'togocel', 'togocom', 't-money', 'tmoney'], src: '/operator-logos/tg-tmoney.jpeg', label: 'T-Money Togo', mark: 'T', color: '#E11D48' },
  { key: 'moov-tg', country: 'tg', aliases: ['moov-togo', 'moov_tg', 'moov', 'flooz'], src: '/operator-logos/tg-moov.jpeg', label: 'Moov Money Flooz Togo', mark: 'M', color: '#0EA5E9' },
  { key: 'mtn', aliases: ['mtn'], label: 'MTN', mark: 'MTN', color: '#FACC15', textColor: '#111827' },
  { key: 'wave', aliases: ['wave'], label: 'Wave', mark: 'W', color: '#0EA5E9' },
  { key: 'orange', aliases: ['orange'], label: 'Orange Money', mark: 'O', color: '#F97316' },
  { key: 'airtel', aliases: ['airtel'], label: 'Airtel', mark: 'A', color: '#DC2626' },
  { key: 'free', aliases: ['free'], label: 'Free Money', mark: 'F', color: '#111827' },
  { key: 'celtiis', aliases: ['celtiis'], label: 'Celtiis', mark: 'C', color: '#16A34A' },
  { key: 'yas', aliases: ['yas', 'mixx'], label: 'Yas / Mixx', mark: 'Y', color: '#7C3AED' },
  { key: 'djamo', aliases: ['djamo'], label: 'Djamo', mark: 'D', color: '#111827' },
  { key: 'expresso', aliases: ['expresso'], label: 'Expresso', mark: 'E', color: '#2563EB' },
  { key: 'wizall', aliases: ['wizall'], label: 'Wizall', mark: 'W', color: '#059669' },
];

function normalized(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function findCountry(value) {
  const candidate = normalized(value);
  return COUNTRIES.find((item) => normalized(item.code) === candidate || normalized(item.name) === candidate) || null;
}

export function findBrand(operator, name, country) {
  const value = normalized(`${operator || ''} ${name || ''}`);
  const countryCode = normalized(country);
  return BRANDS
    .filter((brand) => !brand.country || !countryCode || brand.country === countryCode)
    .find((brand) => brand.aliases.some((alias) => value.includes(normalized(alias)))) || null;
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

export function OperatorLogo({ operator, name, country, logoUrl, size = 'md', className = '' }) {
  const brand = findBrand(operator, name, country);
  const text = name || operator || 'Mobile Money';
  const [failed, setFailed] = useState(false);
  const sizes = {
    sm: 'h-7 w-7 rounded-lg',
    md: 'h-9 w-9 rounded-xl',
    lg: 'h-12 w-12 rounded-2xl',
  };
  const src = logoUrl || brand?.src;
  const fallbackMark = brand?.mark || normalized(operator || name).replace(/[^a-z0-9]/g, '').slice(0, 2).toUpperCase() || 'MM';
  const fallbackColor = brand?.color || '#64748B';
  const fallbackTextColor = brand?.textColor || '#FFFFFF';

  if (src && !failed) {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden bg-white shadow-sm ${sizes[size] || sizes.md} ${className}`} title={name || brand?.label || text} aria-label={name || brand?.label || text}>
        <img
          src={src}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover p-0"
        />
      </span>
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden text-[9px] font-black tracking-[-0.06em] shadow-sm ${sizes[size] || sizes.md} ${className}`}
      style={{ backgroundColor: fallbackColor, color: fallbackTextColor }}
      title={name || brand?.label || text}
      aria-label={name || brand?.label || text}
    >
       {fallbackMark}
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
           <OperatorLogo operator={operator} name={operatorName} country={country} size="sm" />
          <span className="truncate font-semibold text-slate-600">{operatorName || operator}</span>
        </span>
      )}
    </span>
  );
}
import { COUNTRIES } from '@/constants/countries';

const BRANDS = [
  { key: 'tmoney', aliases: ['t-money', 'tmoney', 'togocel', 'togocom'], label: 'T', sub: 'money', bg: '#E30613', fg: '#fff' },
  { key: 'moov', aliases: ['moov', 'flooz'], label: 'moov', sub: 'AFRICA', bg: '#0068B7', fg: '#fff' },
  { key: 'mtn', aliases: ['mtn'], label: 'MTN', sub: '', bg: '#FFCC00', fg: '#003B4F' },
  { key: 'wave', aliases: ['wave'], label: 'wave', sub: '', bg: '#1DC8CD', fg: '#fff' },
  { key: 'orange', aliases: ['orange'], label: 'orange', sub: '', bg: '#FF7900', fg: '#fff' },
  { key: 'airtel', aliases: ['airtel'], label: 'airtel', sub: '', bg: '#E4002B', fg: '#fff' },
  { key: 'free', aliases: ['free'], label: 'free', sub: '', bg: '#111827', fg: '#fff' },
  { key: 'celtiis', aliases: ['celtiis'], label: 'celtiis', sub: '', bg: '#5B2D90', fg: '#fff' },
  { key: 'yas', aliases: ['yas', 'mixx'], label: 'Yas', sub: '', bg: '#111827', fg: '#fff' },
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

export function OperatorLogo({ operator, name, size = 'md', className = '' }) {
  const brand = findBrand(operator, name);
  const text = name || operator || 'Mobile Money';
  const sizes = {
    sm: 'h-7 w-7 rounded-lg text-[8px]',
    md: 'h-9 w-9 rounded-xl text-[10px]',
    lg: 'h-12 w-12 rounded-2xl text-xs',
  };
  if (!brand) {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center bg-slate-100 font-extrabold text-slate-600 ${sizes[size] || sizes.md} ${className}`} title={text} aria-label={text}>
        {text.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex shrink-0 flex-col items-center justify-center font-extrabold leading-none shadow-sm ${sizes[size] || sizes.md} ${className}`}
      style={{ backgroundColor: brand.bg, color: brand.fg }}
      title={name || brand.label}
      aria-label={name || brand.label}
    >
      <span className="tracking-[-0.06em]">{brand.label}</span>
      {brand.sub && <span className="mt-0.5 text-[5px] font-bold tracking-[-0.02em]">{brand.sub}</span>}
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
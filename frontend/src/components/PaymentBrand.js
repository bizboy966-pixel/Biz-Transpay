import { useState } from 'react';
import { COUNTRIES } from '../constants/countries';

const BRANDS = [
  // PayDunya supplies identifiers and names, not stable logo URLs. Keep all
  // display assets local so history and transaction details work offline and
  // under the production CSP.
  { key: 'mixx-tg', country: 'tg', aliases: ['mixx-togo', 'mixx_tg', 'mixx', 'yas-tg', 'yas_tg'], src: '/operator-logos/tg-mixx.jpeg', label: 'Mixx Togo', mark: 'M', color: '#0B3D91' },
  { key: 'tmoney-tg', country: 'tg', aliases: ['tmoney_tg', 'tmoney-tg', 't-money-togo', 'togocel_tg', 'togocel', 'togocom', 't-money', 'tmoney'], src: '/operator-logos/tg-tmoney.svg', label: 'T-Money Togo', mark: 'T', color: '#0B3D91' },
  { key: 'moov-tg', country: 'tg', aliases: ['moov-togo', 'moov_tg', 'moov', 'flooz'], src: '/operator-logos/tg-flooz.jpeg', label: 'Moov Money Flooz Togo', mark: 'M', color: '#F97316' },
  { key: 'moov-bf', country: 'bf', aliases: ['moov-bf', 'moov_bf', 'moov', 'moov-burkina-faso', 'moov burkina', 'moov money burkina'], src: '/operator-logos/bf-moov.png', label: 'Moov Money Burkina Faso', mark: 'M', color: '#0EA5E9' },
  { key: 'orange-bf', country: 'bf', aliases: ['orange-bf', 'orange_bf', 'orange', 'orange-money-burkina', 'orange burkina', 'orange money burkina'], src: '/operator-logos/bf-orange.png', label: 'Orange Burkina Faso', mark: 'O', color: '#F97316' },
  { key: 'yas-bf', country: 'bf', aliases: ['yas-bf', 'yas_bf', 'yas', 'mixx-bf', 'mixx burkina', 'mixx by yas'], src: '/operator-logos/tg-mixx.jpeg', label: 'Mixx by Yas Burkina Faso', mark: 'Y', color: '#7C3AED' },
  { key: 'mtn-bj', country: 'bj', aliases: ['mtn-bj', 'mtn_bj', 'mtn', 'mtn-benin', 'mtn benin', 'my mtn'], src: '/operator-logos/bj-mtn.png', label: 'MTN Bénin', mark: 'MTN', color: '#FACC15', textColor: '#111827' },
  { key: 'moov-bj', country: 'bj', aliases: ['moov-bj', 'moov_bj', 'moov', 'moov-benin', 'moov benin', 'moov money benin'], src: '/operator-logos/bj-moov.png', label: 'Moov Money Bénin', mark: 'M', color: '#0EA5E9' },
  { key: 'celtiis-bj', country: 'bj', aliases: ['celtiis-bj', 'celtiis_bj', 'celtiis'], src: '/operator-logos/celtiis.svg', label: 'Celtiis Bénin', mark: 'C', color: '#16A34A' },
  { key: 'mtn', aliases: ['mtn'], src: '/operator-logos/bj-mtn.png', label: 'MTN', mark: 'MTN', color: '#FACC15', textColor: '#111827' },
  { key: 'moov', aliases: ['moov'], src: '/operator-logos/bf-moov.png', label: 'Moov Money', mark: 'M', color: '#0EA5E9' },
  { key: 'wave', aliases: ['wave'], src: '/operator-logos/wave.svg', label: 'Wave', mark: 'W', color: '#0EA5E9' },
  { key: 'orange', aliases: ['orange'], src: '/operator-logos/bf-orange.png', label: 'Orange Money', mark: 'O', color: '#F97316' },
  { key: 'airtel', aliases: ['airtel'], src: '/operator-logos/airtel.svg', label: 'Airtel', mark: 'A', color: '#DC2626' },
  { key: 'free', aliases: ['free'], src: '/operator-logos/free.svg', label: 'Free Money', mark: 'F', color: '#111827' },
  { key: 'celtiis', aliases: ['celtiis'], src: '/operator-logos/celtiis.svg', label: 'Celtiis', mark: 'C', color: '#16A34A' },
  { key: 'yas', aliases: ['yas', 'mixx'], src: '/operator-logos/tg-mixx.jpeg', label: 'Yas / Mixx', mark: 'Y', color: '#7C3AED' },
  { key: 'djamo', aliases: ['djamo'], src: '/operator-logos/djamo.svg', label: 'Djamo', mark: 'D', color: '#111827' },
  { key: 'expresso', aliases: ['expresso'], src: '/operator-logos/expresso.svg', label: 'Expresso', mark: 'E', color: '#2563EB' },
  { key: 'wizall', aliases: ['wizall'], src: '/operator-logos/wizall.svg', label: 'Wizall', mark: 'W', color: '#059669' },
];

const CRYPTO_BRANDS = {
  USDT: { src: '/crypto-logos/usdt.svg', label: 'Tether (USDT)' },
  USDC: { src: '/crypto-logos/usdc.svg', label: 'USD Coin (USDC)' },
  BNB: { src: '/crypto-logos/bnb.svg', label: 'BNB' },
  BTC: { src: '/crypto-logos/btc.svg', label: 'Bitcoin (BTC)' },
  SOL: { src: '/crypto-logos/sol.svg', label: 'Solana (SOL)' },
  TON: { src: '/crypto-logos/ton.svg', label: 'Toncoin (TON)' },
  TRX: { src: '/crypto-logos/trx.svg', label: 'TRON (TRX)' },
  ETH: { src: '/crypto-logos/eth.svg', label: 'Ethereum (ETH)' },
};

const CRYPTO_ALIASES = {
  BITCOIN: 'BTC',
  BINANCECOIN: 'BNB',
  ETHEREUM: 'ETH',
  SOLANA: 'SOL',
  TETHER: 'USDT',
  TETHERUSD: 'USDT',
  TONCOIN: 'TON',
  TRON: 'TRX',
  USDCOIN: 'USDC',
  XBT: 'BTC',
};

function normalized(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function cryptoSymbol(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  const compact = raw.replace(/[^A-Z0-9]/g, '');
  if (CRYPTO_ALIASES[compact]) return CRYPTO_ALIASES[compact];
  const base = raw.split(/[._\s/:|-]/, 1)[0];
  return CRYPTO_ALIASES[base] || base;
}

export function findCryptoBrand(value) {
  return CRYPTO_BRANDS[cryptoSymbol(value)] || null;
}

export function isCryptoTransaction(tx) {
  const meta = tx?.metadata || {};
  const currency = String(tx?.currency || '').toUpperCase();
  return Boolean(
    meta.coin || meta.crypto || meta.asset_code
    || meta.tx_hash || meta.txid
    || /^(USDT|USDC|BNB|BTC|SOL|TON|TRX|ETH)(?:[._-]|$)/.test(currency)
  );
}

export function findCountry(value) {
  const candidate = normalized(value);
  return COUNTRIES.find((item) => normalized(item.code) === candidate || normalized(item.name) === candidate) || null;
}

export function findBrand(operator, name, country) {
  const valueOf = (value) => {
    if (!value) return '';
    if (typeof value === 'object') {
      return [
        value.code,
        value.operator,
        value.name,
        value.label,
      ].filter(Boolean).join(' ');
    }
    return String(value);
  };
  const value = normalized(`${valueOf(operator)} ${valueOf(name)}`);
  const countryCode = normalized(findCountry(country)?.code || country);
  const countryBrands = BRANDS.filter((brand) => brand.country === countryCode);
  const match = (brands) => brands.find((brand) => (
    [brand.key, ...brand.aliases].some((alias) => value.includes(normalized(alias)))
  )) || null;

  return match(countryBrands) || match(BRANDS.filter((brand) => !brand.country)) || match(BRANDS);
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
  // Prefer the bundled operator photos. Provider-supplied logo URLs can be
  // temporary or blocked by the production CSP and must not hide a local
  // operator image behind the letter fallback.
  const src = brand?.src || logoUrl;
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

export function CryptoLogo({
  assetCode, coin, network, size = 'md', className = '',
}) {
  const value = coin || assetCode;
  const brand = findCryptoBrand(value);
  const symbol = cryptoSymbol(value) || 'CRYPTO';
  const networkLabel = network || String(assetCode || '').split(/[._]/)[1] || '';
  const label = `${brand?.label || `${symbol} (crypto)`}${networkLabel ? ` · ${networkLabel}` : ''}`;
  const sizes = {
    sm: 'h-7 w-7 rounded-lg',
    md: 'h-9 w-9 rounded-xl',
    lg: 'h-12 w-12 rounded-2xl',
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white shadow-sm ${sizes[size] || sizes.md} ${className}`}
      title={label}
      aria-label={label}
      data-testid={`crypto-logo-${symbol.toLowerCase()}`}
    >
      <img
        src={brand?.src || '/crypto-logos/generic.svg'}
        alt=""
        className="h-full w-full object-contain"
      />
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
import { Link2 } from 'lucide-react';
import { SafeImage } from './SafeImage';

const SIZES = {
  sm: 'h-12 w-12 rounded-xl',
  md: 'h-16 w-16 rounded-2xl',
  lg: 'h-20 w-20 rounded-2xl',
};

export default function LinkLogo({ src, alt = '', size = 'md', className = '' }) {
  const dimensions = SIZES[size] || SIZES.md;
  const fallback = (
    <span className={`inline-flex shrink-0 items-center justify-center bg-blue-50 text-[#2563EB] ${dimensions} ${className}`} aria-label={alt || 'Logo du lien'}>
      <Link2 className="h-5 w-5" aria-hidden="true" />
    </span>
  );

  return (
    <SafeImage
      src={src}
      alt={alt}
      className={`shrink-0 border border-slate-100 bg-white object-contain p-1 ${dimensions} ${className}`}
      fallback={fallback}
    />
  );
}
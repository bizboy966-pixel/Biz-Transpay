export default function DashboardPageLogo({ src, alt, className = '' }) {
  return (
    <figure className={`flex w-full justify-center ${className}`}>
      <img
        src={src}
        alt={alt}
        className="h-28 w-28 rounded-full object-cover drop-shadow-[0_8px_16px_rgba(15,23,42,0.16)] sm:h-32 sm:w-32"
        loading="lazy"
        decoding="async"
      />
    </figure>
  );
}
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import api from '@/api';

/**
 * Floating live-support shortcut visible on authenticated user pages.
 *
 * Each button is only rendered when its underlying feature is enabled in the
 * The shortcut opens the user support page where the admin-configured
 * Telegram, WhatsApp and e-mail channels are displayed.
 * On mobile the two buttons stay at the screen edges and shrink to 48px.
 */
export default function FloatingSupportButtons() {
  const [cfg, setCfg] = useState(null);

  useEffect(() => {
    // Public endpoint but we use api (auth is fine, just returns the doc).
    api.get('/support/config')
      .then(({ data }) => setCfg(data))
      .catch(() => setCfg({}));
  }, []);

  if (!cfg) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-40" aria-hidden={false}>
      {/* Customer service channels (bottom-right) */}
      {
        <Link
          to="/dashboard/support"
          data-testid="floating-support-btn"
          aria-label="Ouvrir le service client"
          className="pointer-events-auto absolute right-4 bottom-24 sm:right-6 sm:bottom-28 lg:bottom-6 group">
          <span className="relative flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white shadow-[0_10px_28px_-6px_rgba(37,99,235,0.55)] ring-4 ring-white hover:scale-110 transition-transform active:scale-95">
            <span className="absolute inset-0 rounded-full bg-blue-400 opacity-40 animate-ping" />
            <MessageCircle className="w-6 h-6 relative" strokeWidth={2.25} />
          </span>
          <span className="pointer-events-none absolute right-1/2 translate-x-1/2 -top-8 whitespace-nowrap px-2 py-1 rounded-md bg-slate-900 text-white text-[10px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity">
            Service client
          </span>
        </Link>
      }
    </div>
  );
}

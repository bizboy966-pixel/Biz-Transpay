import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Users } from 'lucide-react';
import api from '@/api';

/**
 * Two floating call-to-action buttons visible on all authenticated user
 * pages. The layout is intentional and matches the product brief:
 *  - bottom-left  → community link (WhatsApp / Telegram / Discord invite)
 *  - bottom-right → live support / chat
 *
 * Each button is only rendered when its underlying feature is enabled in the
 * admin support_config (community_enabled and chat_enabled respectively).
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

  const communityUrl = cfg.community_enabled && cfg.community_url ? cfg.community_url : null;
  const chatEnabled = cfg.chat_enabled !== false;

  return (
    <div className="pointer-events-none fixed inset-0 z-40" aria-hidden={false}>
      {/* Community (bottom-left) */}
      {communityUrl && (
        <a
          href={communityUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="floating-community-btn"
          aria-label={cfg.community_label || 'Rejoindre la communauté'}
          className="pointer-events-auto absolute left-4 bottom-24 sm:left-6 sm:bottom-28 lg:bottom-6 group">
          <span className="relative flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-[0_10px_28px_-6px_rgba(16,185,129,0.6)] ring-4 ring-white hover:scale-110 transition-transform active:scale-95">
            <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-40 animate-ping" />
            <Users className="w-6 h-6 relative" strokeWidth={2.25} />
          </span>
          <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 -top-8 whitespace-nowrap px-2 py-1 rounded-md bg-slate-900 text-white text-[10px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity">
            {cfg.community_label || 'Rejoindre la communauté'}
          </span>
        </a>
      )}

      {/* Live support (bottom-right) */}
      {chatEnabled && (
        <Link
          to="/dashboard/support"
          data-testid="floating-support-btn"
          aria-label="Ouvrir le support"
          className="pointer-events-auto absolute right-4 bottom-24 sm:right-6 sm:bottom-28 lg:bottom-6 group">
          <span className="relative flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white shadow-[0_10px_28px_-6px_rgba(37,99,235,0.55)] ring-4 ring-white hover:scale-110 transition-transform active:scale-95">
            <span className="absolute inset-0 rounded-full bg-blue-400 opacity-40 animate-ping" />
            <MessageCircle className="w-6 h-6 relative" strokeWidth={2.25} />
          </span>
          <span className="pointer-events-none absolute right-1/2 translate-x-1/2 -top-8 whitespace-nowrap px-2 py-1 rounded-md bg-slate-900 text-white text-[10px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity">
            Support en ligne
          </span>
        </Link>
      )}
    </div>
  );
}

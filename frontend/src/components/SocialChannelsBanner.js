import { useEffect, useState } from 'react';
import api from '@/api';
import { SOCIAL_CHANNELS } from './socialChannels';

function SocialIcon({ channel }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[9px] font-extrabold text-slate-500" aria-hidden="true">
        {channel.label.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={channel.iconSrc}
      alt=""
      className="h-5 w-5 shrink-0 object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function ChannelLink({ channel, url, decorative = false }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      tabIndex={decorative ? -1 : undefined}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-[10px] font-bold text-slate-700 transition-colors hover:bg-white/80"
      aria-label={`Ouvrir ${channel.label}`}
    >
      <SocialIcon channel={channel} />
      <span>{channel.label}</span>
    </a>
  );
}

export default function SocialChannelsBanner() {
  const [channels, setChannels] = useState([]);

  useEffect(() => {
    api.get('/support/config')
      .then(({ data }) => {
        const configured = (data.social_channels || [])
          .map((item) => ({
            ...item,
            definition: SOCIAL_CHANNELS.find((channel) => channel.key === item.key),
          }))
          .filter((item) => item.definition && item.url);
        setChannels(configured);
      })
      .catch(() => setChannels([]));
  }, []);

  if (channels.length === 0) return null;

  const items = channels.map(({ definition, url }) => (
    <ChannelLink key={definition.key} channel={definition} url={url} />
  ));

  return (
    <div
      className="bt-social-banner"
      data-testid="social-channels-banner"
      aria-label="Réseaux sociaux"
    >
      <span className="bt-social-banner__subtitle">Rejoignez-nous sur</span>
      <div className="bt-social-banner__viewport">
        <div className={`bt-social-banner__track ${channels.length > 1 ? 'bt-social-banner__track--moving' : ''}`}>
          {items}
          {channels.length > 1 && (
            <div className="inline-flex shrink-0 items-center gap-1.5" aria-hidden="true">
              {channels.map(({ definition, url }) => (
                <ChannelLink key={`duplicate-${definition.key}`} channel={definition} url={url} decorative />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

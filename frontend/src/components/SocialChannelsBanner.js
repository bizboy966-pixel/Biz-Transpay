import { useEffect, useState } from 'react';
import api from '@/api';
import { SOCIAL_CHANNELS } from './socialChannels';

function SocialIcon({ channel }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="bt-social-banner__icon inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-extrabold text-slate-500" aria-hidden="true">
        {channel.label.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={channel.iconSrc}
      alt=""
      className="bt-social-banner__icon h-6 w-6 shrink-0 object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function ChannelLink({ channel, url, active }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      tabIndex={active ? 0 : -1}
      aria-hidden={!active}
      className="bt-social-banner__slide inline-flex shrink-0 items-center gap-2 rounded-lg px-2 py-1 text-xs font-bold text-slate-700 transition-colors hover:bg-white/80"
      aria-label={`Ouvrir ${channel.label}`}
    >
      <SocialIcon channel={channel} />
      <span>{channel.label}</span>
    </a>
  );
}

export default function SocialChannelsBanner() {
  const [channels, setChannels] = useState([]);
  const [activeIndex, setActiveIndex] = useState(0);

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

  useEffect(() => {
    setActiveIndex(0);
  }, [channels.length]);

  useEffect(() => {
    if (channels.length < 2) return undefined;
    const interval = window.setInterval(() => {
      setActiveIndex((index) => (index + 1) % channels.length);
    }, 3500);
    return () => window.clearInterval(interval);
  }, [channels.length]);

  if (channels.length === 0) return null;

  return (
    <div
      className="bt-social-banner"
      data-testid="social-channels-banner"
      aria-label="Réseaux sociaux"
    >
      <span className="bt-social-banner__subtitle">Rejoignez-nous sur</span>
      <div className="bt-social-banner__viewport">
        <div
          className="bt-social-banner__track"
          style={{ transform: `translateX(-${activeIndex * 100}%)` }}
          aria-live="polite"
        >
          {channels.map(({ definition, url }, index) => (
            <ChannelLink
              key={definition.key}
              channel={definition}
              url={url}
              active={index === activeIndex}
            />
          ))}
        </div>
      </div>
      {channels.length > 1 && (
        <span key={activeIndex} className="bt-social-banner__progress" aria-hidden="true" />
      )}
    </div>
  );
}

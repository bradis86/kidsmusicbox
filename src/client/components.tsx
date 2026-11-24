import type { LucideIcon } from 'lucide-react';
import { Music2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { ApprovedItem } from '../shared/types';
export const art = (item: ApprovedItem) => item.artworkOverride ?? item.artwork;
export function Cover({
  src,
  alt = '',
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  return (
    <img
      src={src || '/art/fallback.svg?v=2'}
      alt={alt}
      {...props}
      onError={(e) => {
        if (!e.currentTarget.src.endsWith('/art/fallback.svg?v=2'))
          e.currentTarget.src = '/art/fallback.svg?v=2';
      }}
    />
  );
}
export function IconButton({
  icon: Icon,
  label,
  ...props
}: {
  icon: LucideIcon;
  label: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button aria-label={label} title={label} {...props}>
      <Icon aria-hidden="true" />
    </button>
  );
}
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? 'small' : ''}`}>
      <span className="brand-icon">
        <Music2 size={small ? 21 : 27} />
      </span>
      <span>
        Music Hub<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
export function ErrorNotice({
  message,
  onClose,
}: {
  message: string;
  onClose?: () => void;
}) {
  return message ? (
    <div className="notice" role="alert">
      {message}
      {onClose && (
        <IconButton icon={X} label="Dismiss message" onClick={onClose} />
      )}
    </div>
  ) : null;
}
export function Clock() {
  const [date, setDate] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setDate(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span>
      {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </span>
  );
}
export function time(s: number) {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

"use client";

import { useId } from "react";
import type { Platform } from "@/lib/graph/types";

interface PlatformLogoProps {
  platform: Platform;
  decorative?: boolean;
}

export function PlatformLogo({ platform, decorative = true }: PlatformLogoProps) {
  const rawId = useId();
  const gradientId = `instagram-gradient-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const label = `${formatPlatform(platform)} logo`;

  return (
    <svg
      className={`platform-logo platform-logo-${platform}`}
      viewBox="0 0 24 24"
      aria-hidden={decorative}
      aria-label={decorative ? undefined : label}
      role={decorative ? undefined : "img"}
      focusable="false"
    >
      {renderPlatformLogo(platform, gradientId)}
    </svg>
  );
}

export function PlatformName({ platform }: { platform: Platform }) {
  return <span>{formatPlatform(platform)}</span>;
}

export function PlatformIdentity({ platform }: { platform: Platform }) {
  return (
    <span className="platform-identity">
      <PlatformLogo platform={platform} />
      <PlatformName platform={platform} />
    </span>
  );
}

export function formatPlatform(platform: Platform): string {
  const labels: Record<Platform, string> = {
    github: "GitHub",
    x: "X",
    linkedin: "LinkedIn",
    instagram: "Instagram",
    product_hunt: "Product Hunt",
    youtube: "YouTube",
    rss: "RSS",
    web: "Web",
    reddit: "Reddit",
    hacker_news: "Hacker News",
    bilibili: "Bilibili"
  };
  return labels[platform];
}

function renderPlatformLogo(platform: Platform, gradientId: string) {
  switch (platform) {
    case "x":
      return (
        <>
          <rect width="24" height="24" rx="4" fill="#000000" />
          <path
            fill="#ffffff"
            d="M14.2 10.6 21.8 2h-1.8l-6.6 7.5L8.1 2H2l8 11.4L2 22h1.8l7-7.9 5.6 7.9h6.1l-8.3-11.4Zm-2.5 2.8-.8-1.1L4.5 3.4h2.7l5.2 7.2.8 1.1 6.8 9h-2.7l-5.6-7.3Z"
          />
        </>
      );
    case "linkedin":
      return (
        <>
          <rect width="24" height="24" rx="3" fill="#0A66C2" />
          <path
            fill="#ffffff"
            d="M6.9 19.2H3.8V9.5h3.1v9.7ZM5.3 8.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Zm14 11h-3.1v-4.7c0-1.1 0-2.6-1.6-2.6s-1.8 1.2-1.8 2.5v4.8H9.8V9.5h3v1.3h.1a3.3 3.3 0 0 1 3-1.6c3.2 0 3.8 2.1 3.8 4.8v5.2Z"
          />
        </>
      );
    case "instagram":
      return (
        <>
          <defs>
            <linearGradient id={gradientId} x1="3" x2="21" y1="21" y2="3" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FEDA75" />
              <stop offset=".25" stopColor="#FA7E1E" />
              <stop offset=".5" stopColor="#D62976" />
              <stop offset=".75" stopColor="#962FBF" />
              <stop offset="1" stopColor="#4F5BD5" />
            </linearGradient>
          </defs>
          <rect width="24" height="24" rx="6" fill={`url(#${gradientId})`} />
          <rect x="6" y="6" width="12" height="12" rx="4" fill="none" stroke="#ffffff" strokeWidth="2" />
          <circle cx="12" cy="12" r="3" fill="none" stroke="#ffffff" strokeWidth="2" />
          <circle cx="16.8" cy="7.2" r="1.2" fill="#ffffff" />
        </>
      );
    case "youtube":
      return (
        <>
          <rect width="24" height="24" rx="4" fill="#FF0000" />
          <path
            fill="#ffffff"
            d="M20.9 7.1a2.5 2.5 0 0 0-1.7-1.8C17.7 4.9 12 4.9 12 4.9s-5.7 0-7.2.4a2.5 2.5 0 0 0-1.7 1.8A25.7 25.7 0 0 0 2.7 12c0 1.7.1 3.4.4 4.9a2.5 2.5 0 0 0 1.7 1.8c1.5.4 7.2.4 7.2.4s5.7 0 7.2-.4a2.5 2.5 0 0 0 1.7-1.8c.3-1.5.4-3.2.4-4.9s-.1-3.4-.4-4.9ZM10.1 15.2V8.8l5.6 3.2-5.6 3.2Z"
          />
        </>
      );
    case "github":
      return (
        <>
          <circle cx="12" cy="12" r="12" fill="#181717" />
          <path
            fill="#ffffff"
            d="M12 4.2a8 8 0 0 0-2.5 15.6c.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.1-.9-1.1-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.8.8 2.3.6.1-.5.3-.8.5-1-1.8-.2-3.7-.9-3.7-3.9 0-.9.3-1.6.8-2.2-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8.6-.2 1.3-.3 2-.3s1.4.1 2 .3c1.5-1 2.2-.8 2.2-.8.5 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.2 0 3-1.9 3.7-3.7 3.9.3.3.6.8.6 1.6v2.4c0 .2.1.5.6.4A8 8 0 0 0 12 4.2Z"
          />
        </>
      );
    case "product_hunt":
      return (
        <>
          <circle cx="12" cy="12" r="12" fill="#DA552F" />
          <path
            fill="#ffffff"
            d="M10.1 16.3v3H7.8V4.7h5.6a4.7 4.7 0 1 1 0 9.4h-3.3v2.2Zm0-4.4h3.3a2.5 2.5 0 0 0 0-5h-3.3v5Z"
          />
        </>
      );
    case "reddit":
      return (
        <>
          <rect width="24" height="24" rx="4" fill="#000000" />
          <circle cx="12" cy="13.2" r="6" fill="#ffffff" />
          <circle cx="8.7" cy="12.5" r="1" fill="#000000" />
          <circle cx="15.3" cy="12.5" r="1" fill="#000000" />
          <path d="M9.7 15.4c1.3.8 3.3.8 4.6 0" fill="none" stroke="#000000" strokeLinecap="round" strokeWidth="1.2" />
          <path d="M13.2 7.2 14.8 4l3.2.8" fill="none" stroke="#ffffff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
          <circle cx="18.4" cy="5" r="1.5" fill="#ffffff" />
          <circle cx="5.1" cy="11.6" r="1.6" fill="#ffffff" />
          <circle cx="18.9" cy="11.6" r="1.6" fill="#ffffff" />
        </>
      );
    case "rss":
      return (
        <>
          <rect width="24" height="24" rx="4" fill="#F26522" />
          <circle cx="7.1" cy="16.9" r="2.1" fill="#ffffff" />
          <path d="M5 9.2a9.8 9.8 0 0 1 9.8 9.8h3A12.8 12.8 0 0 0 5 6.2v3Z" fill="#ffffff" />
          <path d="M5 13.5A5.5 5.5 0 0 1 10.5 19h3A8.5 8.5 0 0 0 5 10.5v3Z" fill="#ffffff" />
        </>
      );
    case "hacker_news":
      return (
        <>
          <rect width="24" height="24" rx="3" fill="#FF6600" />
          <path fill="#ffffff" d="m7.1 5.5 4.1 7.3v5.7h1.7v-5.7l4-7.3h-1.9L12 11l-3-5.5H7.1Z" />
        </>
      );
    case "bilibili":
      return (
        <>
          <rect width="24" height="24" rx="5" fill="#00A1D6" />
          <path d="m8.2 5.2 1.6 1.9M15.8 5.2l-1.6 1.9" fill="none" stroke="#ffffff" strokeLinecap="round" strokeWidth="1.8" />
          <rect x="4.8" y="7.5" width="14.4" height="11" rx="2.5" fill="none" stroke="#ffffff" strokeWidth="1.8" />
          <path d="M8.3 12.3v2.1M15.7 12.3v2.1" stroke="#ffffff" strokeLinecap="round" strokeWidth="1.8" />
        </>
      );
    case "web":
      return (
        <>
          <circle cx="12" cy="12" r="10" fill="#4B5563" />
          <path d="M3.5 12h17M12 2.4c2.5 2.4 3.7 5.6 3.7 9.6s-1.2 7.2-3.7 9.6c-2.5-2.4-3.7-5.6-3.7-9.6S9.5 4.8 12 2.4Z" fill="none" stroke="#ffffff" strokeWidth="1.5" />
        </>
      );
  }
}

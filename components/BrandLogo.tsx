/**
 * PiForge brand mark, inline so it renders identically in every window without
 * a network request (and without shipping a PNG, which Windows DLP agents can
 * transparently re-encrypt on disk).
 */
export function BrandLogo({ className, size = 64 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      className={className}
      role="img"
      aria-label="PiForge"
    >
      <defs>
        <linearGradient id="piforge-logo-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0c1c31" />
          <stop offset="1" stopColor="#050a12" />
        </linearGradient>
        <radialGradient id="piforge-logo-glow" cx="0.5" cy="0.08" r="0.78">
          <stop offset="0" stopColor="#58a6ff" stopOpacity="0.32" />
          <stop offset="1" stopColor="#58a6ff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="piforge-logo-beam" x1="244" y1="344" x2="780" y2="344" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8fd6ff" />
          <stop offset="0.52" stopColor="#d6f2ff" />
          <stop offset="1" stopColor="#5ba8ff" />
        </linearGradient>
        <linearGradient id="piforge-logo-leg" x1="0" y1="352" x2="0" y2="798" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7cc9ff" />
          <stop offset="1" stopColor="#3f7fe0" stopOpacity="0.78" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="224" fill="url(#piforge-logo-bg)" />
      <rect width="1024" height="1024" rx="224" fill="url(#piforge-logo-glow)" />
      <rect x="244" y="306" width="536" height="76" rx="38" fill="url(#piforge-logo-beam)" />
      <rect x="330" y="352" width="76" height="446" rx="34" transform="rotate(-3 368 575)" fill="url(#piforge-logo-leg)" />
      <rect x="618" y="352" width="76" height="446" rx="34" transform="rotate(3 656 575)" fill="url(#piforge-logo-leg)" />
      <rect x="292" y="836" width="440" height="10" rx="5" fill="#7cc9ff" opacity="0.18" />
      <path d="M812 232 l15 42 42 15 -42 15 -15 42 -15 -42 -42 -15 42 -15 z" fill="#d9f2ff" opacity="0.9" />
    </svg>
  );
}

/**
 * PiForge brand mark — a minimal geometric "P" with a forge spark.
 *
 * Inline SVG on purpose: no network request, no PNG on disk (Windows DLP
 * agents transparently re-encrypt large images), and one shape that stays
 * crisp at 16px in the sidebar and 64px in an empty state. Colour comes from
 * the active theme accent via currentColor.
 */
export function BrandLogo({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="PiForge"
      fill="none"
    >
      <path
        d="M7.2 20.6V3.4h5.06a5.7 5.7 0 0 1 0 11.4H7.2"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="17.4" cy="18.2" r="2.6" fill="currentColor" />
    </svg>
  );
}

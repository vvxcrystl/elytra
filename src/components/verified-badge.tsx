import clsx from "clsx";

/** Filled checkmark badge shown after the display name of a verified account. Renders nothing otherwise. */
export function VerifiedBadge({
  user,
  className,
}: {
  user: { verified: boolean };
  className?: string;
}) {
  if (!user.verified) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="Verified account"
      className={clsx("inline-block size-[1.1em] shrink-0 align-[-0.15em] text-accent-ink", className)}
    >
      <path
        fill="currentColor"
        d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.78 4.78 4 4 0 0 1-6.74 0 4 4 0 0 1-4.78-4.78 4 4 0 0 1 0-6.74Z"
      />
      <path d="m9 12 2 2 4-4" fill="none" stroke="var(--color-bg, #fff)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

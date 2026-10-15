import clsx from "clsx";

/**
 * Elytra mark: a pair of wing cases, traced from the Krita source and mirrored.
 * Stroke weight matches the source file (28.8 units).
 */
export function Logo({
  className,
  strokeWidth = 28.8,
  draw = false,
}: {
  className?: string;
  strokeWidth?: number;
  /** Trace the strokes in on mount (see `.logo-draw` in globals.css). */
  draw?: boolean;
}) {
  const pathLength = draw ? 1 : undefined;
  return (
    <svg
      viewBox="18.64 -8.45 700 700"
      className={clsx("text-accent-ink", draw && "logo-draw", className)}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path pathLength={pathLength} d="M304.2 123.48C112.2 8.28 -20.76 130.68 75.24 457.56L84.24 480.6C251.19 881 367.48 165.19 325.35 136.8Z" />
      <path pathLength={pathLength} d="M304.2 123.48C112.2 8.28 -20.76 130.68 75.24 457.56L84.24 480.6C251.19 881 367.48 165.19 325.35 136.8Z" transform="matrix(-1 0 0 1 737.28 0)" />
      <path pathLength={pathLength} d="M265.5 103.5C334.78 132.22 387.43 130.91 465.34 104.94" />
      <path pathLength={pathLength} d="M336.33 246.96C357.81 238.61 379.29 236.17 400.77 246.96" />
    </svg>
  );
}

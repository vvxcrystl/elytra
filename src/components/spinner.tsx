import clsx from "clsx";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={clsx(
        "inline-block size-6 animate-spin rounded-full border-2 border-accent-soft border-t-accent-ink",
        className,
      )}
    />
  );
}

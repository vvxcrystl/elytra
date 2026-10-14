import clsx from "clsx";
import type { UserSummary } from "@/lib/types";

const SIZES = {
  xs: "size-5 text-[9px]",
  sm: "size-8 text-xs",
  md: "size-10 text-sm",
  lg: "size-12 text-base",
  xl: "size-[134px] text-5xl",
} as const;

// Stable hue per user so initials avatars are distinguishable.
function hueFor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({
  user,
  size = "md",
  className,
}: {
  user: Pick<UserSummary, "id" | "displayName" | "avatarUrl">;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const base = clsx(
    "shrink-0 rounded-full object-cover select-none",
    SIZES[size],
    className,
  );

  if (user.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={user.avatarUrl} alt="" className={base} />;
  }

  const hue = hueFor(user.id);
  return (
    <span
      aria-hidden
      className={clsx(base, "inline-flex items-center justify-center font-semibold")}
      style={{
        background: `oklch(0.7 0.12 ${hue} / 0.22)`,
        color: `oklch(0.62 0.16 ${hue})`,
      }}
    >
      {initials(user.displayName)}
    </span>
  );
}

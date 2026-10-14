const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Twitter-style short timestamp: "now", "5m", "3h", "Oct 12", "Oct 12, 2025". */
export function shortTime(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (seconds < 60) return seconds < 5 ? "now" : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return sameYear ? day : `${day}, ${date.getFullYear()}`;
}

/** "3:42 PM · Oct 12, 2026" for the post detail view. */
export function fullTime(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${time} · ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** "Joined October 2026" */
export function joinedDate(iso: string): string {
  return `Joined ${new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  })}`;
}

/** 999, 1.2K, 34K, 1.5M */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

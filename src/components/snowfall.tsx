import type { CSSProperties } from "react";

// Seeded layout so every render places the same flakes. Bigger flakes fall faster.
const FLAKES = Array.from({ length: 36 }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const size = 2 + r(1) * 4;
  return {
    "--x": `${r(2) * 100}%`,
    "--size": `${size}px`,
    "--fall": `${22 - size * 2.5}s`,
    "--delay": `${-r(3) * 20}s`,
    "--sway": `${3 + r(4) * 3}s`,
  } as CSSProperties;
});

/**
 * Snow drifting behind the page. Hidden unless the Christmas theme is on and the system
 * allows motion; see `.snowfall` in globals.css.
 */
export function Snowfall() {
  return (
    <div aria-hidden className="snowfall">
      {FLAKES.map((style, i) => (
        <span key={i} style={style} />
      ))}
    </div>
  );
}

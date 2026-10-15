"use client";

import { useEffect, useState, ViewTransition } from "react";
import { Logo } from "@/components/logo";

// Set after the first mount, so the strokes trace in on a fresh page load but not when the
// logo flies back in from the auth card.
let drawn = false;

export function LandingMark({ className }: { className?: string }) {
  const [draw] = useState(() => !drawn);
  useEffect(() => {
    drawn = true;
  }, []);

  return (
    <ViewTransition name="elytra-mark" share="mark-morph" default="none">
      <Logo draw={draw} className={className} />
    </ViewTransition>
  );
}

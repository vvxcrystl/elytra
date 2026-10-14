"use client";

import { createContext, useContext } from "react";
import type { Viewer } from "@/lib/types";

const ViewerContext = createContext<Viewer | null>(null);

export function ViewerProvider({
  viewer,
  children,
}: {
  viewer: Viewer;
  children: React.ReactNode;
}) {
  return <ViewerContext value={viewer}>{children}</ViewerContext>;
}

export function useViewer(): Viewer {
  const viewer = useContext(ViewerContext);
  if (!viewer) throw new Error("useViewer must be used inside ViewerProvider");
  return viewer;
}

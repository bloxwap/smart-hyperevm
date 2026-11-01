"use client";

import { HIGProvider } from "@bloxwap/hig-react/provider";
import { RootProvider } from "fumadocs-ui/provider/next";
import { lazy, type ReactNode } from "react";

const SearchDialog = lazy(() => import("./search"));

export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ forcedTheme: "dark" }} search={{ SearchDialog, preload: false }}>
      <HIGProvider density="comfortable" locale="en">
        {children}
      </HIGProvider>
    </RootProvider>
  );
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";
import { mono, sans } from "@/lib/fonts";
import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://bloxwap.github.io/hyperevm/"),
  title: { default: "HyperEVM RPC · Bloxwap", template: "%s · HyperEVM RPC" },
  description: "A latency-aware, cached, multi-endpoint HyperEVM RPC transport for viem.",
  icons: { icon: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/logos/bloxwap-icon-green.svg` },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} dark`} suppressHydrationWarning>
      <body>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}

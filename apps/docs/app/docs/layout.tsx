import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      sidebar={{
        footer: (
          <div className="docs-sidebar-footer">
            <a href="https://www.npmjs.com/package/@bloxwap/smart-hyperevm" className="docs-app-link">
              View on npm <ArrowUpRight size={16} aria-hidden />
            </a>
          </div>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}

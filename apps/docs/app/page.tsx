import { highlight } from "fumadocs-core/highlight";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { InstallCommand } from "@/components/install-command";
import { SiteFooter } from "@/components/site-footer";
import { baseOptions } from "@/lib/layout.shared";

const features = [
  {
    number: "01",
    title: "Configure",
    description: "Connect public or private RPC endpoints with budgets, racing, and failover.",
    href: "/docs/configuration/",
  },
  {
    number: "02",
    title: "Optimize",
    description: "Serve warm reads from memory and keep log indexes current one block at a time.",
    href: "/docs/routing/#read-cache",
  },
  {
    number: "03",
    title: "Measure",
    description: "Compare direct providers and reproduce the routing and cache benchmarks.",
    href: "/docs/benchmarks/",
  },
];

const snippet = `import { createPublicClient } from "viem";
import { hyperEvm } from "viem/chains";
import { hyperevm } from "@bloxwap/smart-hyperevm";

const client = createPublicClient({
  chain: hyperEvm,
  transport: hyperevm(),
});

const block = await client.getBlockNumber();
`;

export default async function Home() {
  const code = await highlight(snippet, {
    lang: "ts",
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
    components: { pre: ({ children }) => <pre>{children}</pre> },
  });
  return (
    <HomeLayout {...baseOptions()} className="min-h-dvh">
      <main className="landing">
        <div className="hero">
          <div className="hero-copy">
            <p className="eyebrow">
              <span /> HYPEREVM RPC TRANSPORT
            </p>
            <h1>
              Every read.
              <br />
              <span>Without the wait.</span>
            </h1>
            <p className="hero-description">
              A latency-aware viem transport that races healthy endpoints, avoids stale nodes, and answers warm reads
              from memory.
            </p>
            <div className="hero-actions">
              <Link className="hig-button hero-action" data-intent="primary" href="/docs/">
                Get started <ArrowRight size={16} aria-hidden />
              </Link>
              <Link className="hig-button hero-action" data-intent="secondary" href="/docs/benchmarks/">
                View benchmarks
              </Link>
            </div>
            <InstallCommand />
            <p className="runtime-note">Bun · Node.js · Browsers · Edge</p>
          </div>
          <div className="code-window not-fumadocs-codeblock">
            <div className="code-toolbar">
              <div className="window-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <span>client.ts</span>
              <div className="code-actions">
                <span className="code-language">TS</span>
                <CopyButton text={snippet} label="Copy code" className="code-copy" />
              </div>
            </div>
            {code}
            <div className="code-status">
              <span /> One drop-in transport. Every endpoint.
            </div>
          </div>
        </div>
        <section className="metrics" aria-label="Live benchmark highlights">
          <div>
            <strong>0.17 ms</strong>
            <span>warm sequential p95</span>
          </div>
          <div>
            <strong>0.10 ms</strong>
            <span>concurrent p95</span>
          </div>
          <div>
            <strong>0%</strong>
            <span>errors in the live run</span>
          </div>
        </section>
        <div className="feature-grid">
          {features.map((feature) => (
            <Link key={feature.number} href={feature.href} className="feature-card">
              <span className="feature-number">{feature.number}</span>
              <h2>
                {feature.title}
                <ArrowRight size={18} aria-hidden />
              </h2>
              <p>{feature.description}</p>
            </Link>
          ))}
        </div>
      </main>
      <SiteFooter />
    </HomeLayout>
  );
}

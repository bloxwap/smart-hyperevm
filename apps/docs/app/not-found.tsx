import { HomeLayout } from "fumadocs-ui/layouts/home";
import Link from "next/link";
import { baseOptions } from "@/lib/layout.shared";

export default function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="landing trust-page">
        <p className="eyebrow">404</p>
        <h1>Page not found</h1>
        <p className="hero-description">The page may have moved. Start again from the documentation.</p>
        <Link className="hig-button hero-action" data-intent="primary" href="/docs/">
          Open documentation
        </Link>
      </main>
    </HomeLayout>
  );
}

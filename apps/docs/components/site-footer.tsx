import Image from "next/image";
import Link from "next/link";

const links = [
  { label: "Documentation", href: "/docs/" },
  { label: "GitHub", href: "https://github.com/bloxwap/smart-hyperevm" },
  { label: "npm", href: "https://www.npmjs.com/package/@bloxwap/smart-hyperevm" },
  { label: "Bloxwap", href: "https://bloxwap.com" },
];

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-brand">
        <a className="footer-lockup" href="https://bloxwap.com" aria-label="Bloxwap home">
          <Image
            src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/logos/bloxwap-icon-green.svg`}
            alt=""
            width={32}
            height={32}
          />
          <span>Bloxwap</span>
        </a>
        <p>Performance infrastructure for HyperEVM.</p>
      </div>
      <nav className="footer-links" aria-label="Project links">
        {links.map((link) => (
          <Link key={link.label} href={link.href}>
            {link.label}
          </Link>
        ))}
      </nav>
      <div className="footer-base">
        <span>&copy; {new Date().getFullYear()} Bloxwap, Inc.</span>
        <span>MIT licensed</span>
      </div>
    </footer>
  );
}

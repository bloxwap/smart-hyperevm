import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="brand-lockup">
          <Image
            src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/logos/bloxwap-icon-green.svg`}
            alt="Bloxwap"
            width={28}
            height={28}
            priority
          />
          <span className="brand-product">HyperEVM RPC</span>
        </span>
      ),
    },
    githubUrl: "https://github.com/bloxwap/smart-hyperevm",
    themeSwitch: { enabled: false },
  };
}

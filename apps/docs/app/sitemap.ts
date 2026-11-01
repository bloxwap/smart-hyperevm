import type { MetadataRoute } from "next";
import { source } from "@/lib/source";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://bloxwap.github.io/smart-hyperevm";
  return [{ url: `${base}/` }, ...source.getPages().map((page) => ({ url: `${base}${page.url}/` }))];
}

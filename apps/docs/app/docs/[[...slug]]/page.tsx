import { DocsBody, DocsPage } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import { ArrowUpRight } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import { source } from "@/lib/source";

type PageProps = { params: Promise<{ slug?: string[] }> };

export default async function Page({ params }: PageProps) {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  const MDX = page.data.body;
  const RelativeLink = createRelativeLink(source, page);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} footer={{ className: "page-nav" }}>
      <DocsBody>
        <MDX components={getMDXComponents({ a: RelativeLink })} />
      </DocsBody>
      <a
        className="edit-link"
        href={`https://github.com/bloxwap/smart-hyperevm/edit/main/apps/docs/content/docs/${page.path}`}
      >
        Edit this page on GitHub <ArrowUpRight size={14} aria-hidden />
      </a>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}

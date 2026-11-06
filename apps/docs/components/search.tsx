"use client";

import { Alert, EmptyState, Skeleton } from "@bloxwap/hig/react/status";
import { useDocsSearch } from "fumadocs-core/search/client";
import { staticClient } from "fumadocs-core/search/client/orama-static";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import Link from "next/link";
import { useEffect } from "react";

const client = staticClient({ from: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/search-index.json` });
const suggestions = [
  { title: "Get started", href: "/docs/" },
  { title: "Configuration", href: "/docs/configuration/" },
  { title: "Routing and caching", href: "/docs/routing/" },
  { title: "Benchmarks", href: "/docs/benchmarks/" },
];

function SearchSkeleton() {
  return (
    <div className="search-skeleton" aria-busy="true">
      <Skeleton label="Searching" />
      <div className="hig-skeleton" aria-hidden="true" />
      <div className="hig-skeleton" aria-hidden="true" />
    </div>
  );
}

function SearchEmpty({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="search-empty" role="status">
      <EmptyState
        title="No matches"
        description="Try a method name, or start from a section:"
        action={
          <ul>
            {suggestions.map((suggestion) => (
              <li key={suggestion.href}>
                <Link href={suggestion.href} onClick={onNavigate}>
                  {suggestion.title}
                </Link>
              </li>
            ))}
          </ul>
        }
      />
    </div>
  );
}

export default function DocsSearchDialog(props: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({ client });

  useEffect(() => {
    if (props.open) Promise.resolve(client.search("")).catch(() => {});
  }, [props.open]);

  const pending = search.length > 0 && (query.isLoading || query.data === "empty");
  const items = query.data !== "empty" ? query.data : pending ? [] : null;

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader className="search-header">
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        {query.error ? (
          <div className="search-error">
            <Alert severity="error" title="Search unavailable">
              <p>Reload to retry, or use the navigation.</p>
            </Alert>
          </div>
        ) : (
          <SearchDialogList
            items={items}
            Empty={() => (pending ? <SearchSkeleton /> : <SearchEmpty onNavigate={() => props.onOpenChange(false)} />)}
          />
        )}
      </SearchDialogContent>
    </SearchDialog>
  );
}

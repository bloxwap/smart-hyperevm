# HyperEVM documentation

Fumadocs renders the Markdown in `content/docs` as a static Next.js site for GitHub Pages. The interface uses BlockSwap's HIG packages and self-hosted Bloxwap Sans and Mono fonts.

## Develop

From the repository root:

```sh
bun install --frozen-lockfile
bun dev
```

Turbo starts the docs server in its terminal UI at `http://localhost:3915` (`bun run docs:dev` is equivalent). Press `Ctrl+C` to stop; add `--ui=stream` for plain logs.

## Edit content

Edit Markdown in `content/docs`. Every page needs `title` and `description` frontmatter and one visible H1. Add new pages to `content/docs/meta.json` so they appear in navigation.

## Check and build

```sh
bun run docs:check
NEXT_PUBLIC_BASE_PATH=/smart-hyperevm bun run docs:build
```

The static export is written to `apps/docs/out`. The Documentation workflow checks pull requests and deploys `main` with GitHub Pages. Set **Settings → Pages → Source** to **GitHub Actions** before the first deployment.

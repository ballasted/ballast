# BALLAST — Web

Next.js (App Router) for **ballasted.xyz**. Marketing site at the root, the app
under `/app`. One project, one domain (build-spec §8).

## Status

**Built:** the marketing site — landing, docs (4 pages), terms, privacy. Fully
static, **no web3 bundle**.

**Not built yet:** the `/app` segment (Discover, Token detail, Create, Portfolio,
Profile, deposit flows), wallet providers, dynamic OG images, X OAuth. See the root
`CLAUDE.md` and build-spec §9.

## The one architectural rule

Wallet providers wrap **only** the `/app` segment (`app/app/layout.tsx`, to be
added). The root layout (`app/layout.tsx`) and the marketing group
(`app/(marketing)/`) load **zero** web3 code, so a first-time visitor downloads a
fast static page. Do not add wagmi/viem to the root layout.

## Layout

```
app/
  layout.tsx                 Root: <html>/<body>, metadata. NO web3.
  globals.css                Tailwind + design-system tokens.
  robots.ts, sitemap.ts
  (marketing)/               Route group — not in the URL.
    layout.tsx               Header + Footer shell (static).
    page.tsx                 Landing (copy from docs/BALLAST-landing-copy.md).
    docs/
      layout.tsx             Sidebar + prose wrapper.
      page.tsx               Overview.
      how-ballast-works/page.mdx
      what-ballast-is-not/page.mdx
      contract-addresses/page.mdx
      verify-a-treasury/page.mdx
    terms/page.tsx           Scaffold — pending legal review.
    privacy/page.tsx         Scaffold — pending legal review.
components/                  Header, Footer, Container, Wordmark.
lib/cn.ts
mdx-components.tsx           Required by @next/mdx.
```

## Develop

```shell
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npm run typecheck
```

Design tokens (colours, radii) live in `tailwind.config.ts`, from build-spec §10.
Legal pages are plain-language scaffolds and **must** be reviewed by counsel before
mainnet (build-spec §13).

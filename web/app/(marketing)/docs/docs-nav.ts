// Shared docs navigation. Kept out of layout.tsx because Next.js route-segment
// files (layout/page/route) may only have specific named exports.
export const DOC_PAGES = [
  { href: "/docs/how-ballast-works", label: "How ballast works" },
  { href: "/docs/what-ballast-is-not", label: "What ballast is not" },
  { href: "/docs/contract-addresses", label: "Contract addresses" },
  { href: "/docs/verify-a-treasury", label: "Verify a treasury yourself" },
  { href: "/docs/why-scanners-flag-us", label: "Why scanners flag us" },
  { href: "/docs/content-policy", label: "Content policy & denylist" },
  { href: "/docs/corrections", label: "Corrections" },
];

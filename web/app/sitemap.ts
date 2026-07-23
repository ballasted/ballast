import type { MetadataRoute } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://ballasted.xyz";

// Static marketing routes only. App (/app/*) routes are dynamic and excluded.
const ROUTES = [
  "",
  "/docs",
  "/docs/how-ballast-works",
  "/docs/what-ballast-is-not",
  "/docs/contract-addresses",
  "/docs/verify-a-treasury",
  "/terms",
  "/privacy",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((route) => ({
    url: `${SITE_URL}${route}`,
    changeFrequency: "weekly",
    priority: route === "" ? 1 : 0.6,
  }));
}

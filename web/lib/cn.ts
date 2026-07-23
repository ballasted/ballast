// Tiny className joiner. No dependency on clsx/tailwind-merge for the static
// marketing site — the app segment can pull those in later if needed.
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

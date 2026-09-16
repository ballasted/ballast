import Link from "next/link";
import { cn } from "@/lib/cn";

// A stylised keel weight: a downward wedge under a waterline. The mark alone,
// no wordmark text — reused standalone (e.g. the Discover hero's orbit centre)
// as well as inside Wordmark below.
export function KeelMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn("text-green", className)}>
      <path d="M3 7h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M12 7v6m0 0l-4 4h8l-4-4z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Simple text wordmark + the keel glyph. Not a Robinhood logo clone.
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn("group inline-flex items-center gap-2", className)}
      aria-label="BALLAST home"
    >
      <KeelMark />
      <span className="font-semibold tracking-[0.15em] text-bone">
        BALLAST
      </span>
    </Link>
  );
}

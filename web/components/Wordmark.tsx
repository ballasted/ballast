import Link from "next/link";
import { cn } from "@/lib/cn";

// Simple text wordmark + a small "keel" glyph. Not a Robinhood logo clone.
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn("group inline-flex items-center gap-2", className)}
      aria-label="BALLAST home"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="text-green"
      >
        {/* A stylised keel weight: a downward wedge under a waterline. */}
        <path d="M3 7h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path
          d="M12 7v6m0 0l-4 4h8l-4-4z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-text-primary font-semibold tracking-tight">
        BALLAST
      </span>
    </Link>
  );
}

"use client";

// Route-transition crossfade for the /app segment. A template re-mounts on every
// navigation (unlike a layout), so each new page fades in over ~200ms — the
// "settle into place" tone, not a performance. Opacity only, no layout shift.
// prefers-reduced-motion collapses this to an instant swap via the global media
// query in globals.css. Marketing keeps its own scroll reveals and is untouched,
// so it stays free of this client boundary.
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="anim-fade">{children}</div>;
}

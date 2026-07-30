import { SocialIcon } from "@/components/SocialIcon";
import type { IconName } from "@/lib/links";
import { cn } from "@/lib/cn";

// The project's self-declared links (website / X / Telegram), read from the pinned
// metadata JSON. These are NOT verified — a project typing an X handle is not proof
// it controls it — so this is labelled "Links", never "Verified links", and carries
// no check mark. "Verified" is reserved for what the backing panel earns.
type LinkMeta = { website?: string; x?: string; telegram?: string };

function toUrl(v: string): string {
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v.replace(/^\/+/, "")}`;
}

// Short, readable label for the row variant: hostname for a website, @handle for X,
// the bare handle/invite for Telegram.
function hostOf(url: string): string {
  try {
    return new URL(toUrl(url)).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//i, "").replace(/^www\./, "").replace(/\/.*$/, "");
  }
}
function after(v: string, marker: string): string {
  const i = v.toLowerCase().lastIndexOf(marker);
  return (i >= 0 ? v.slice(i + marker.length) : v).replace(/^\/+/, "");
}

type Item = { key: string; icon: IconName; label: string; href: string };

function items(meta?: LinkMeta): Item[] {
  if (!meta) return [];
  const out: Item[] = [];
  if (meta.website) out.push({ key: "website", icon: "website", label: hostOf(meta.website), href: toUrl(meta.website) });
  if (meta.x) out.push({ key: "x", icon: "x", label: `@${after(meta.x, "x.com/")}`, href: toUrl(meta.x) });
  if (meta.telegram) out.push({ key: "telegram", icon: "telegram", label: after(meta.telegram, "t.me/"), href: toUrl(meta.telegram) });
  return out;
}

/**
 * `variant="row"` — token page: icon + handle per link, with the unverified line.
 * `variant="icons"` — Discover card: icons only, no handles. Because a card is a
 * single <Link> (an anchor), the icon opens the external link via window.open on a
 * <button> rather than a nested <a> (invalid HTML), and stops propagation so it
 * doesn't also navigate to the token page. Both paths open in a new, isolated tab.
 */
export function ProjectLinks({
  meta,
  variant,
  className,
}: {
  meta?: LinkMeta;
  variant: "row" | "icons";
  className?: string;
}) {
  const list = items(meta);
  if (list.length === 0) return null;

  if (variant === "icons") {
    return (
      <div className={cn("flex items-center gap-2.5", className)}>
        {list.map((it) => (
          <button
            key={it.key}
            type="button"
            aria-label={`${it.key} (opens in a new tab)`}
            title={it.label}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              window.open(it.href, "_blank", "noopener,noreferrer");
            }}
            className="text-text-faint transition-colors hover:text-text-secondary"
          >
            <SocialIcon name={it.icon} className="h-4 w-4" />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {list.map((it) => (
          <a
            key={it.key}
            href={it.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary"
          >
            <SocialIcon name={it.icon} className="h-4 w-4 text-text-faint" />
            {it.label}
          </a>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-text-faint">Provided by the project. Not verified by BALLAST.</p>
    </div>
  );
}

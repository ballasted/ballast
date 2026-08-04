// IPFS helpers. Files/JSON are pinned through our own /api/pin route so the
// Pinata JWT stays server-side; the browser only ever sees the resulting CID and
// reads content back through a public gateway.
//
// ── GATEWAY ISOLATION (hard rule) ────────────────────────────────────────────
// NEXT_PUBLIC_IPFS_GATEWAY MUST resolve to a domain we do NOT serve the app from
// (e.g. gateway.pinata.cloud, or a dedicated ipfs.* subdomain). User-uploaded
// content — including anything an SVG or HTML blob could smuggle in — must never
// be same-origin with ballasted.xyz, or a single malicious upload becomes an XSS
// under our own origin (and a Google Safe Browsing trigger). See CLAUDE.md.

const GATEWAY = process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs/";

// Dev-only guard: shout if someone points the gateway at the app's own origin,
// which would defeat the isolation above. No-op in production and on the server.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  try {
    if (new URL(GATEWAY).host === window.location.host) {
      // eslint-disable-next-line no-console
      console.error(
        "[ballast] NEXT_PUBLIC_IPFS_GATEWAY is the app's own origin. User uploads " +
          "must be served cross-origin — point it at a gateway domain we don't serve the app from.",
      );
    }
  } catch {
    /* malformed gateway URL is caught elsewhere */
  }
}

/** Turn an ipfs://CID (or bare CID) into a gateway URL. Only https and ipfs
 *  sources are honoured — a pinned `logo` field is attacker-controllable (it can
 *  be set directly in the on-chain metadataURI, bypassing our create form), so we
 *  never resolve http:// (mixed content) or exotic schemes (`javascript:`, `data:`)
 *  into an <img src>. Anything else returns undefined and the caller falls back to
 *  the initials mark. */
export function ipfsToGateway(uri?: string): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith("https://")) return uri;
  if (uri.startsWith("http://")) return undefined; // no mixed content / arbitrary http images
  const cid = uri.startsWith("ipfs://") ? uri.slice("ipfs://".length) : uri;
  if (!cid || /[^A-Za-z0-9/._-]/.test(cid)) return undefined; // reject anything not CID-shaped
  return `${GATEWAY}${cid.replace(/^ipfs\//, "")}`;
}

export const MAX_UPLOAD_BYTES = 1_000_000; // ~1 MB before resize
// Raster formats only. SVG is deliberately excluded: it is an active document that
// can carry scripts, and we gain nothing by accepting it since every logo is
// rasterised to a 512×512 PNG before pinning. The /api/pin route enforces this
// again by magic bytes — the client check below is a UX nicety, not the gate.
const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];

export function isAcceptedImage(file: File): boolean {
  return ACCEPTED.includes(file.type);
}

/**
 * Resize a raster image to a square `size`×`size` PNG (cover-fit, centered) on the
 * client, so we never pin large files. Returns a Blob ready to upload. Only the
 * raster formats in ACCEPTED reach here; SVG is rejected before this point.
 */
export async function resizeImage(file: File, size = 512): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available");

  // cover-fit: scale so the shorter side fills, crop the overflow.
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  bitmap.close();

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Resize failed"))), "image/png", 0.92),
  );
}

/** Pin a file through the server route. Returns an ipfs:// URI. */
export async function pinFile(blob: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", blob, filename);
  const res = await fetch("/api/pin", { method: "POST", body: form });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Pin failed");
  const { cid } = (await res.json()) as { cid: string };
  return `ipfs://${cid}`;
}

/** Pin a JSON object through the server route. Returns an ipfs:// URI. */
export async function pinJson(obj: unknown): Promise<string> {
  const res = await fetch("/api/pin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Pin failed");
  const { cid } = (await res.json()) as { cid: string };
  return `ipfs://${cid}`;
}

export type ProjectMetadata = {
  name?: string;
  symbol?: string;
  description?: string;
  category?: string;
  logo?: string; // ipfs://CID or https URL
  website?: string;
  x?: string; // handle or URL
  telegram?: string; // handle or t.me URL
};

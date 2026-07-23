// IPFS helpers. Files/JSON are pinned through our own /api/pin route so the
// Pinata JWT stays server-side; the browser only ever sees the resulting CID and
// reads content back through a public gateway.

const GATEWAY = process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs/";

/** Turn an ipfs://CID (or bare CID) into a gateway URL. Passes http(s) URLs
 *  through unchanged, so a manually-hosted image still works. */
export function ipfsToGateway(uri?: string): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
  const cid = uri.startsWith("ipfs://") ? uri.slice("ipfs://".length) : uri;
  if (!cid) return undefined;
  return `${GATEWAY}${cid.replace(/^ipfs\//, "")}`;
}

export const MAX_UPLOAD_BYTES = 1_000_000; // ~1 MB before resize
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

export function isAcceptedImage(file: File): boolean {
  return ACCEPTED.includes(file.type);
}

/**
 * Resize a raster image to a square `size`×`size` PNG (cover-fit, centered) on the
 * client, so we never pin large files. SVG is passed through untouched (already
 * tiny and vector). Returns a Blob ready to upload.
 */
export async function resizeImage(file: File, size = 512): Promise<Blob> {
  if (file.type === "image/svg+xml") return file;

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

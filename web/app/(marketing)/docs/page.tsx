import type { Metadata } from "next";
import Link from "next/link";
import { DOC_PAGES } from "./docs-nav";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How ballast works, what it is not, contract addresses, and how to verify a treasury yourself.",
};

export default function DocsIndex() {
  return (
    <>
      <h1>Documentation</h1>
      <p>
        BALLAST&apos;s entire pitch is legibility, so these docs are part of the
        product. Start here, then verify everything yourself — you never have to
        trust this interface.
      </p>
      <ul>
        {DOC_PAGES.map((p) => (
          <li key={p.href}>
            <Link href={p.href}>{p.label}</Link>
          </li>
        ))}
      </ul>
    </>
  );
}

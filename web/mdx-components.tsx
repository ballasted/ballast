import type { MDXComponents } from "mdx/types";

// Required by @next/mdx in the App Router. Global MDX styling is handled by the
// `.prose-doc` wrapper in the docs layout, so components mostly pass through.
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...components,
  };
}

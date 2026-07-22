import { cn } from "@/lib/cn";

export function Container({
  children,
  className,
  prose,
}: {
  children: React.ReactNode;
  className?: string;
  prose?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-5 sm:px-6",
        prose ? "max-w-prose" : "max-w-content",
        className,
      )}
    >
      {children}
    </div>
  );
}

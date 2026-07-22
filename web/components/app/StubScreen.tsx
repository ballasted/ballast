// Placeholder for app screens not yet built, so the bottom nav always resolves.
// Honest about what each screen needs rather than faking content.
export function StubScreen({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{title}</h1>
      <div className="card mt-6 p-8 text-center">
        <p className="mx-auto max-w-md text-sm text-text-muted">{body}</p>
        <p className="mt-3 text-xs text-text-faint">Coming soon</p>
      </div>
    </div>
  );
}

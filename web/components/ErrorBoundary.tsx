"use client";

import { Component, type ReactNode } from "react";

// A client-side exception inside any one widget (a chart library choking on a bad
// data shape, for example) must never blank the entire page — React unmounts the
// whole tree above the nearest error boundary, and this app has none by default.
// Wrap any component that renders third-party/untrusted-shape data in this so a
// failure degrades to a small fallback instead of "Application error."
export class ErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error);
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

import type { AuthSession } from "@/lib/types";

export function AuthControl({ session }: { session: AuthSession | null }) {
  if (!session || !session.oidcEnabled) return null;

  if (!session.authenticated) {
    return (
      <a
        href="/api/auth/login"
        className="bg-brand px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-dark"
      >
        Sign in with PingOne
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-ink-muted">
        Signed in{session.name ? ` as ${session.name}` : session.email ? ` as ${session.email}` : ""}
      </span>
      {/* Full navigation, not a fetch — /api/auth/logout redirects the
          browser through PingOne's own end-session endpoint so its SSO
          session ends too, not just this app's cookie. See route comment. */}
      <a
        href="/api/auth/logout"
        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink transition hover:border-brand hover:text-brand"
      >
        Sign out
      </a>
    </div>
  );
}

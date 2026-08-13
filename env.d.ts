declare namespace NodeJS {
  interface ProcessEnv {
    // Server-only, read via src/lib/settings.ts and served to the browser
    // at runtime through GET /api/config — not NEXT_PUBLIC_-inlined, since
    // the whole point is that the Settings panel can change these without a
    // rebuild. See CLAUDE.md's Settings section.
    readonly DEFAULT_REGION?: string;
    readonly DEFAULT_QUALIFIER?: string;
    readonly DEFAULT_HARNESS_ARN?: string;

    // Server-only — deliberately NOT NEXT_PUBLIC_. See src/lib/oidc.ts and
    // src/lib/auth-session.ts; never read these from a "use client" file.
    readonly OIDC_CLIENT_ID?: string;
    readonly OIDC_CLIENT_SECRET?: string;
    readonly OIDC_DISCOVERY_URL?: string;
    readonly OIDC_REDIRECT_URI?: string;
    readonly OIDC_POST_LOGOUT_REDIRECT_URI?: string;
    readonly OIDC_SCOPES?: string;
    readonly SESSION_SECRET?: string;

    // The agent's own machine identity (client credentials grant) —
    // separate PingOne application from OIDC_CLIENT_ID above. Reuses
    // OIDC_DISCOVERY_URL for the token endpoint. These four (like the
    // DEFAULT_* above) are also editable at runtime via the in-app Settings
    // panel once signed in — see src/lib/settings.ts. OIDC_*/SESSION_SECRET
    // above are not: they have to be correct before signing in is possible.
    readonly AGENT_CLIENT_ID?: string;
    readonly AGENT_CLIENT_SECRET?: string;
    readonly AGENT_SCOPE?: string;
    // Scope requested on the RFC 8693 token exchange (distinct from
    // AGENT_SCOPE above, which is for the client_credentials grant).
    readonly AGENT_EXCHANGE_SCOPE?: string;
  }
}

declare namespace NodeJS {
  interface ProcessEnv {
    readonly NEXT_PUBLIC_DEFAULT_REGION?: string;
    readonly NEXT_PUBLIC_DEFAULT_QUALIFIER?: string;
    readonly NEXT_PUBLIC_DEFAULT_HARNESS_ARN?: string;

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
    // OIDC_DISCOVERY_URL for the token endpoint.
    readonly AGENT_CLIENT_ID?: string;
    readonly AGENT_CLIENT_SECRET?: string;
    readonly AGENT_SCOPE?: string;
  }
}

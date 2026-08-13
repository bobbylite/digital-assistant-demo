declare namespace NodeJS {
  interface ProcessEnv {
    readonly NEXT_PUBLIC_DEFAULT_REGION?: string;
    readonly NEXT_PUBLIC_DEFAULT_QUALIFIER?: string;
    readonly NEXT_PUBLIC_DEFAULT_HARNESS_ARN?: string;
  }
}

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone — a self-contained server with only the
  // production node_modules it actually needs traced in, instead of the
  // full dependency tree. That's what makes the Docker runner stage small
  // and lets it skip `npm install` entirely — see Dockerfile.
  output: "standalone",
  allowedDevOrigins: [
    "localhost"
  ],
};

export default nextConfig;

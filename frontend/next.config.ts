import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  transpilePackages: ["@little-sunshine/shared"],
  ...(process.env.NODE_ENV === "production" ? { output: "export" as const } : {}),
  ...(process.env.NODE_ENV === "development"
    ? {
        async rewrites() {
          return [{ source: "/api/:path*", destination: "http://127.0.0.1:3001/api/:path*" }];
        },
      }
    : {}),
};

export default nextConfig;

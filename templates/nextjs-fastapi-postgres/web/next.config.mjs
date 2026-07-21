/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces a minimal standalone server bundle for a small container image.
  output: "standalone",
  reactStrictMode: true,
};

export default nextConfig;

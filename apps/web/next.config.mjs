import { fileURLToPath, URL } from "node:url";

const nextConfig = {
  transpilePackages: ["@agent/shared"],
  turbopack: {
    root: fileURLToPath(new URL("../..", import.meta.url))
  }
};

export default nextConfig;

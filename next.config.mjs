/** @type {import('next').NextConfig} */
const nextConfig = {
  // The render engine (../render) is a separate deployable (ECR image); keep it
  // out of the Next build. App code lives under app/.
};

export default nextConfig;

import { withSerwist } from '@serwist/turbopack'
import type { NextConfig } from 'next'

/**
 * Next.js 16.3 / Turbopack.
 *
 * `withSerwist` from @serwist/turbopack is deliberately tiny: all it does is
 * append "esbuild" / "esbuild-wasm" to `serverExternalPackages` so the service
 * worker route handler can `import()` the bundler at request/prerender time.
 * There is NO webpack plugin here -- @serwist/next is webpack-only and is not
 * installed. The worker itself is produced by the Route Handler in
 * app/serwist/[path]/route.ts and served from /serwist/sw.js.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  images: {
    // Supabase Storage (avatars / attachments) via next/image. Kept here from
    // day one so adding a bucket later does not require a config change and a
    // redeploy of every environment.
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/**',
      },
    ],
  },

  async headers() {
    return [
      {
        // The worker script's own Content-Type and Service-Worker-Allowed
        // headers are set by the Serwist route handler itself. What it does
        // NOT set is caching, and a CDN pinning an old worker is the classic
        // way to strand every installed client on stale code.
        source: '/serwist/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        ],
      },
      {
        source: '/manifest.json',
        headers: [
          {
            key: 'Content-Type',
            value: 'application/manifest+json; charset=utf-8',
          },
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        ],
      },
    ]
  },
}

export default withSerwist(nextConfig)

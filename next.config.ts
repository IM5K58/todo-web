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
    // This app renders ZERO next/image. Every avatar is a plain <img>
    // (lib/avatar.ts explains why: the Google photo host lh3.googleusercontent
    // .com would have to be whitelisted too, and a 40px avatar gains nothing
    // from optimization).
    //
    // `remotePatterns` used to carry `hostname: '*.supabase.co'` "so adding a
    // bucket later does not require a config change". That is not a dormant
    // convenience -- /_next/image is always mounted (and proxy.ts:223 excludes
    // it from the auth matcher), so the pattern was a live, unauthenticated
    // open proxy: anyone could hand us a URL on ANY *.supabase.co project and
    // make our Vercel image-optimization quota fetch and transcode it.
    // Optimization is a metered, CPU-heavy line item. An empty list makes
    // /_next/image reject every remote `url=`; `unoptimized` short-circuits
    // the transform itself.
    //
    // TO USE next/image LATER, restore BOTH lines below -- pin the exact
    // project host, never a wildcard, and never a bare `/storage/v1/**`:
    //   unoptimized: false,
    //   remotePatterns: [
    //     { protocol: 'https', hostname: '<project-ref>.supabase.co',
    //       pathname: '/storage/v1/object/public/avatars/**' },
    //     { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
    //   ],
    // and update the "next/image 가 아니라 <img>" notes in lib/avatar.ts and
    // app/me/page.tsx, which cite this block as the reason.
    unoptimized: true,
    remotePatterns: [],
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

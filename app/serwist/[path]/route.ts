import { createSerwistRoute } from '@serwist/turbopack'

/**
 * Serves the compiled service worker (and its sourcemap) as a prerendered
 * Route Handler, because Turbopack has no plugin API yet.
 *
 * IMPORTANT -- the segment is `[path]`, NOT `[...path]`:
 *   - `createSerwistRoute` types `params` as `Promise<{ path: string }>` and
 *     feeds it straight into `node:path.join()`. A catch-all segment hands
 *     Next.js params as `string[]`, which makes `path.join` throw at request
 *     time and makes `generateStaticParams`'s `{ path: "sw.js" }` the wrong
 *     shape for the generated route types.
 *   - @serwist/turbopack's own bundler config flattens chunk and asset names
 *     ("[name]-[hash]") specifically so nothing is ever nested deeper than one
 *     segment. Its source comment states this outright.
 * Verified against node_modules/@serwist/turbopack/src/{index.ts,lib/build.ts}
 * at 9.5.12.
 *
 * The resulting worker URL is /serwist/sw.js. The handler sets
 * `Service-Worker-Allowed: /` on it, so registration must pass `scope: '/'`
 * for the worker to control the whole origin from that sub-path.
 */
export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } =
  createSerwistRoute({
    swSrc: 'app/sw.ts',
    // Defaults to true on Windows already, but this project is developed on
    // Windows and deployed on Linux, and esbuild-wasm is ~10x slower on the
    // prerender pass. `esbuild` is a direct devDependency, so pin it on.
    useNativeEsbuild: true,
    esbuildOptions: {
      // The worker is not a Next.js module: nothing inlines NEXT_PUBLIC_* for
      // it and there is no `process` at runtime. This define is the ONLY way
      // the VAPID public key reaches app/sw.ts, and sw.ts needs it to rebuild
      // a subscription during `pushsubscriptionchange` on the engines
      // (Firefox, WebKit) that fire that event without
      // `oldSubscription.options`.
      define: {
        'process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY': JSON.stringify(
          process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() ?? '',
        ),
      },
    },
  })

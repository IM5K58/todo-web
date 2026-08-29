import { defaultCache } from '@serwist/turbopack/worker'
import { Serwist } from 'serwist'

// `self.__SW_MANIFEST` and `SerwistPushSubscriptionChangeEvent` come from
// types/serwist.d.ts.
declare const self: ServiceWorkerGlobalScope

// ---------------------------------------------------------------------------
// Build-time constants
// ---------------------------------------------------------------------------

/**
 * Inlined by esbuild `define` in app/serwist/[path]/route.ts. The worker is
 * bundled outside the Next.js pipeline, so `process` does not exist here at
 * runtime and NEXT_PUBLIC_* is not inlined for it automatically.
 *
 * This is the fallback key for `pushsubscriptionchange` on engines that fire
 * the event without a usable `oldSubscription.options.applicationServerKey`.
 */
const VAPID_PUBLIC_KEY = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '').trim()

const DEFAULT_TITLE = '매일 할거 적기'
const DEFAULT_BODY = '새 알림이 도착했어요.'
const DEFAULT_ICON = '/icons/icon-192.png'
const SUBSCRIBE_ENDPOINT = '/api/push/subscribe'

interface PushPayload {
  title?: string
  body?: string
  url?: string
  tag?: string
  icon?: string
  badge?: string
}

// ---------------------------------------------------------------------------
// base64url -> Uint8Array
//
// Intentionally duplicated from lib/push/subscribe.ts rather than imported:
// that module is a "use client" React-land module and reaches for `window`,
// which does not exist in a worker. Ten lines of duplication beats dragging
// the client bundle into the service worker graph.
// ---------------------------------------------------------------------------
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const trimmed = base64String.trim()
  // base64 decodes 4 chars -> 3 bytes, so the input must be a multiple of 4.
  // A 65-byte P-256 VAPID key is 87 base64url chars; 87 % 4 === 3, so exactly
  // one "=" is appended.
  const padding = '='.repeat((4 - (trimmed.length % 4)) % 4)
  // base64url substitutes "-" for "+" (62) and "_" for "/" (63); decoding
  // reverses that mapping.
  const base64 = (trimmed + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = self.atob(base64)
  const output: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

function parsePayload(data: PushMessageData | null): PushPayload {
  if (!data) return {}
  try {
    const parsed: unknown = data.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PushPayload
    }
  } catch {
    /* not JSON -- fall through to text */
  }
  try {
    const text = data.text()
    return text.trim() ? { body: text } : {}
  } catch {
    return {}
  }
}

/**
 * Subscribing with `userVisibleOnly: true` is a promise to the push service
 * that EVERY delivery produces a visible notification. Break it and Chrome /
 * Edge substitute their own "This site has been updated in the background"
 * notice, debit the origin's push budget, and eventually revoke the
 * subscription outright. So this function must show something no matter what
 * arrives -- including a push with no payload, an unparseable payload, or a
 * `showNotification` call that itself rejects.
 */
async function handlePush(event: PushEvent): Promise<void> {
  const payload = parsePayload(event.data)
  const url = typeof payload.url === 'string' ? payload.url : '/'
  const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag : 'nudge'
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : DEFAULT_TITLE
  const body =
    typeof payload.body === 'string' && payload.body.trim()
      ? payload.body.trim()
      : DEFAULT_BODY

  // `renotify` is missing from some lib.dom revisions; widen rather than drop
  // the option. It also REQUIRES a tag -- showNotification throws a TypeError
  // with renotify and no tag, which is exactly the failure this whole function
  // exists to avoid.
  const options: NotificationOptions & { renotify?: boolean } = {
    body,
    icon: typeof payload.icon === 'string' ? payload.icon : DEFAULT_ICON,
    badge: typeof payload.badge === 'string' ? payload.badge : DEFAULT_ICON,
    tag,
    renotify: true,
    lang: 'ko',
    data: { url, receivedAt: Date.now() },
  }

  try {
    await self.registration.showNotification(title, options)
    return
  } catch {
    /* fall through to the minimal notification */
  }

  try {
    // Minimal, option-free retry: no renotify, no icon, nothing that can throw
    // on an engine that rejected the rich version.
    await self.registration.showNotification(DEFAULT_TITLE, { body: DEFAULT_BODY })
  } catch {
    // Nothing further is possible. Swallow so the promise handed to
    // waitUntil() still resolves -- a rejected waitUntil is itself treated as
    // a userVisibleOnly violation.
  }
}

// ---------------------------------------------------------------------------
// notificationclick
// ---------------------------------------------------------------------------

async function focusOrOpen(rawUrl: string): Promise<void> {
  let target: URL
  try {
    target = new URL(rawUrl, self.location.origin)
  } catch {
    target = new URL('/', self.location.origin)
  }
  // Never let a payload-supplied URL send the user off-origin.
  if (target.origin !== self.location.origin) {
    target = new URL('/', self.location.origin)
  }

  // includeUncontrolled matters: a tab opened before this worker took control
  // is otherwise invisible to matchAll.
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })
  const sameOrigin = clients.filter((client) => {
    try {
      return new URL(client.url).origin === target.origin
    } catch {
      return false
    }
  })

  // Prefer a tab already showing the target (path + query + hash), so a nudge
  // for today's list does not re-navigate a tab the user is mid-typing in.
  const exact = sameOrigin.find((client) => {
    const current = new URL(client.url)
    return (
      current.pathname === target.pathname &&
      current.search === target.search &&
      current.hash === target.hash
    )
  })

  const client = exact ?? sameOrigin[0]
  if (client) {
    // client.focus() rejects when the window cannot be focused (no user
    // activation on some engines). Letting that escape would abort the handler
    // before the openWindow fallback below ever runs.
    try {
      const focused = await client.focus()
      if (!exact && 'navigate' in focused) {
        try {
          await focused.navigate(target.href)
        } catch {
          // WindowClient.navigate is unimplemented on iOS Safari; the focused
          // tab simply stays where it was.
        }
      }
      return
    } catch {
      /* fall through to openWindow */
    }
  }

  if (self.clients.openWindow) {
    try {
      await self.clients.openWindow(target.href)
    } catch {
      /* nothing else to try */
    }
  }
}

// ---------------------------------------------------------------------------
// pushsubscriptionchange
// ---------------------------------------------------------------------------

async function notifyResubscribeFailed(): Promise<void> {
  try {
    await self.registration.showNotification('알림이 꺼졌어요', {
      body: '앱을 열고 알림을 다시 켜주세요.',
      icon: DEFAULT_ICON,
      badge: DEFAULT_ICON,
      tag: 'push-resubscribe-failed',
      lang: 'ko',
      data: { url: '/' },
    })
  } catch {
    /* best effort */
  }
}

/**
 * POST the replacement subscription and ACTUALLY CHECK THE RESULT.
 *
 * This event commonly fires days after the last visit, in a worker woken with
 * no page attached. The Supabase session cookie may well have expired, in
 * which case the route answers 401 -- which, if ignored, is indistinguishable
 * from success. The old endpoint has already been discarded by the push
 * service at that point, so the user goes permanently silent with no signal.
 */
async function persistFromWorker(
  subscription: PushSubscription,
  oldEndpoint: string | undefined,
): Promise<boolean> {
  const body = JSON.stringify({
    subscription: subscription.toJSON(),
    oldEndpoint,
  })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(SUBSCRIBE_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      if (response.ok) return true
      // 4xx other than 408/429 will not fix itself on a retry.
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429
      ) {
        return false
      }
    } catch {
      /* offline or DNS failure -- retry once */
    }
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }
  return false
}

async function resubscribe(event: SerwistPushSubscriptionChangeEvent): Promise<void> {
  const oldEndpoint = event.oldSubscription?.endpoint
  let next = event.newSubscription ?? null

  if (!next) {
    // Chrome usually hands us `oldSubscription.options.applicationServerKey`.
    // Firefox and WebKit routinely fire this event with no options object at
    // all -- giving up there would make an expired subscription unrecoverable
    // until the user happens to tap the button again. Fall back to the key
    // compiled in at build time.
    const fromOld = event.oldSubscription?.options?.applicationServerKey ?? null
    let applicationServerKey: BufferSource | null = fromOld

    if (!applicationServerKey) {
      if (!VAPID_PUBLIC_KEY) {
        await notifyResubscribeFailed()
        return
      }
      try {
        applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      } catch {
        await notifyResubscribeFailed()
        return
      }
    }

    try {
      next = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      })
    } catch {
      // Possible if permission was revoked between the two events. Nothing to
      // persist, and a notification would be noise if the user turned it off
      // deliberately.
      return
    }
  }

  const ok = await persistFromWorker(next, oldEndpoint)
  if (!ok) await notifyResubscribeFailed()
}

// ---------------------------------------------------------------------------
// Listener registration
//
// Serwist's docs are explicit: custom listeners must be added BEFORE
// serwist.addEventListeners(), or Serwist's own handlers can claim the event
// first.
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data as { url?: string } | undefined
  event.waitUntil(focusOrOpen(typeof data?.url === 'string' ? data.url : '/'))
})

self.addEventListener('pushsubscriptionchange', (event) => {
  const changeEvent = event as unknown as SerwistPushSubscriptionChangeEvent
  changeEvent.waitUntil(resubscribe(changeEvent))
})

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  disableDevLogs: true,
  runtimeCaching: defaultCache,
  // No `fallbacks` entry on purpose. A fallback URL must ALSO be present in
  // the precache manifest, and precaching a route that 404s or redirects
  // (e.g. through auth) fails the install step outright -- which takes push
  // down with it. Add one only together with a real, publicly reachable
  // offline route.
})

serwist.addEventListeners()

'use client'

/**
 * Browser-side Web Push enrolment.
 *
 * The single most important thing in this file is the ORDER OF THE GUARDS in
 * `subscribeToPush`. On iOS, `window.Notification` and `window.PushManager`
 * only exist inside a Home Screen web app -- in a normal Safari tab they are
 * undefined. Feature-detecting first therefore tells every single iPhone
 * visitor "this browser doesn't support push" and makes the install guide
 * unreachable. The iOS/standalone check must come FIRST.
 */

const VAPID_PUBLIC_KEY = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '').trim()

/** How long to wait on `navigator.serviceWorker.ready` before giving up. */
const SW_READY_TIMEOUT_MS = 10_000

export type SubscribeResult =
  | { status: 'subscribed' }
  | { status: 'already-subscribed' }
  | { status: 'needs-install' }
  | { status: 'denied' }
  | { status: 'dismissed' }
  | { status: 'unsupported'; reason: 'server' | 'no-api' }
  /** Build/deploy problem, NOT a browser problem. Kept separate so the user is
   *  not told their phone is at fault when NEXT_PUBLIC_VAPID_PUBLIC_KEY is
   *  missing from the deploy. */
  | { status: 'misconfigured' }
  | { status: 'error'; message: string }

export type UnsubscribeResult =
  | { status: 'unsubscribed' }
  | { status: 'not-subscribed' }
  | { status: 'error'; message: string }

export type ResyncResult =
  | { status: 'synced' }
  | { status: 'replaced' }
  | { status: 'none' }
  | { status: 'skipped' }
  | { status: 'error'; message: string }

export const SUBSCRIBE_MESSAGES_KO: Record<SubscribeResult['status'], string> = {
  subscribed: '알림을 켰어요.',
  'already-subscribed': '이미 알림이 켜져 있어요.',
  'needs-install':
    '아이폰은 홈 화면에 추가한 뒤, 그 아이콘으로 열어야 알림을 켤 수 있어요.',
  denied: '알림이 차단되어 있어요. 휴대폰 설정 › 알림에서 직접 켜주세요.',
  dismissed: '알림 창을 닫으셨어요. 다시 시도해 주세요.',
  unsupported: '이 브라우저에서는 푸시 알림을 지원하지 않아요.',
  misconfigured: '서버 설정 문제로 알림을 켤 수 없어요. 관리자에게 알려주세요.',
  error: '알림을 켜지 못했어요. 잠시 후 다시 시도해 주세요.',
}

export const UNSUBSCRIBE_MESSAGES_KO: Record<UnsubscribeResult['status'], string> = {
  unsubscribed: '알림을 껐어요.',
  'not-subscribed': '켜져 있는 알림이 없어요.',
  error: '알림을 끄지 못했어요. 잠시 후 다시 시도해 주세요.',
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/** Launched from the Home Screen / installed app window rather than a tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const byMedia =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches
  // `navigator.standalone` is a non-standard, WebKit-only legacy flag. Older
  // iOS builds report it more reliably than the media query, so check both.
  const byLegacy =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  return byMedia || byLegacy
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS 13+ ships a desktop UA string; the touch-point count gives it away.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/** iOS Chrome/Firefox/Edge/Opera cannot add to the Home Screen. Only Safari can. */
export function isIosNonSafari(): boolean {
  if (!isIos()) return false
  return /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(navigator.userAgent)
}

/**
 * True only where the whole Push API surface exists. On iOS this is false in a
 * Safari tab and true inside a Home Screen app -- which is precisely why it
 * must never be the first thing checked.
 */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    typeof window.Notification?.requestPermission === 'function'
  )
}

export function currentPermission(): NotificationPermission | 'unavailable' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unavailable'
  return Notification.permission
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * base64url VAPID public key -> Uint8Array.
 *
 * MDN says `applicationServerKey` accepts a base64 string, but Safari and
 * older Chrome only reliably accept a BufferSource, so always convert. The
 * Uint8Array is backed by an explicit ArrayBuffer so it satisfies BufferSource
 * under TypeScript's typed-array generics.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  // A trailing newline in the env file would otherwise change the length, make
  // the padding calculation wrong, and make atob() throw with an opaque
  // "InvalidCharacterError".
  const trimmed = base64String.trim()
  if (!/^[A-Za-z0-9\-_]+=*$/.test(trimmed)) {
    throw new Error('VAPID 공개 키 형식이 올바르지 않습니다.')
  }
  // base64 encodes 3 bytes per 4 characters, so the padded length must be a
  // multiple of 4. A 65-byte uncompressed P-256 point is 87 base64url
  // characters (87 % 4 === 3), which gets exactly one "=".
  const padding = '='.repeat((4 - (trimmed.length % 4)) % 4)
  // base64url swaps "+" (62) for "-" and "/" (63) for "_"; decoding undoes it.
  const base64 = (trimmed + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

/**
 * `navigator.serviceWorker.ready` NEVER REJECTS. If the worker was never
 * registered, or registration failed (404 on the script, a redirect on it, an
 * install-time throw), the promise simply hangs forever -- leaving a spinner
 * spinning after the user has already granted OS notification permission.
 * Always race it.
 */
async function getReadyRegistration(
  timeoutMs = SW_READY_TIMEOUT_MS,
): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('서비스 워커가 준비되지 않았어요. 앱을 새로고침해 주세요.')),
      timeoutMs,
    )
  })

  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout])
  } catch (error) {
    // Last chance: a registration that is installed but not yet *activated*
    // still exposes a usable pushManager, and `ready` would not have resolved
    // for it.
    const existing = await navigator.serviceWorker.getRegistration('/').catch(() => null)
    if (existing?.pushManager) return existing
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Compare an existing subscription's applicationServerKey with ours.
 *
 * "Unknown" MUST count as a match. `PushSubscriptionOptions.applicationServerKey`
 * is not exposed by every engine; treating absence as "the key was rotated"
 * makes the code unsubscribe and re-subscribe a perfectly healthy
 * subscription on every single call, orphaning a push_subscriptions row and
 * delivering duplicate notifications each time.
 */
function sameApplicationServerKey(
  sub: PushSubscription,
  key: Uint8Array<ArrayBuffer>,
): boolean {
  let existing: ArrayBuffer | null | undefined
  try {
    existing = (sub as PushSubscription & { options?: PushSubscriptionOptions }).options
      ?.applicationServerKey
  } catch {
    return true
  }
  if (!existing) return true
  const bytes = new Uint8Array(existing)
  if (bytes.length !== key.length) return false
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== key[i]) return false
  }
  return true
}

async function persist(
  subscription: PushSubscription,
  oldEndpoint?: string,
): Promise<void> {
  const response = await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON(), oldEndpoint }),
  })
  if (!response.ok) {
    throw new Error(`구독 저장에 실패했어요 (${response.status})`)
  }
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/**
 * MUST be called synchronously from a user gesture handler (click / tap).
 *
 * Two orderings are load-bearing:
 *
 *  1. iOS/standalone is checked BEFORE feature detection, so an iPhone visitor
 *     is routed to /install instead of being told their browser is unsupported.
 *  2. `Notification.requestPermission()` is the FIRST await. On iOS the
 *     transient activation from the tap is consumed by any preceding await
 *     (e.g. `navigator.serviceWorker.ready`), after which the prompt is
 *     silently suppressed with no error at all.
 */
export async function subscribeToPush(): Promise<SubscribeResult> {
  // (a) server / no DOM
  if (typeof window === 'undefined') return { status: 'unsupported', reason: 'server' }

  // (b) iOS outside a Home Screen app -- BEFORE any feature detection.
  if (isIos() && !isStandalone()) return { status: 'needs-install' }

  // (c) real feature detection
  if (!isPushSupported()) return { status: 'unsupported', reason: 'no-api' }

  // (d) our own deploy config
  if (!VAPID_PUBLIC_KEY) return { status: 'misconfigured' }

  let applicationServerKey: Uint8Array<ArrayBuffer>
  try {
    applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  } catch {
    return { status: 'misconfigured' }
  }

  try {
    // (e) permission -- first await, still inside the user gesture.
    let permission = Notification.permission
    if (permission === 'default') {
      // Old WebKit implements only the callback form and returns undefined.
      const result = await Notification.requestPermission()
      permission = result ?? Notification.permission
    }
    if (permission === 'denied') return { status: 'denied' }
    if (permission !== 'granted') return { status: 'dismissed' }

    // (f) subscribe
    const registration = await getReadyRegistration()

    let subscription = await registration.pushManager.getSubscription()
    let wasExisting = Boolean(subscription)
    let oldEndpoint: string | undefined

    // A subscription made against a rotated VAPID key is dead weight -- the
    // push service rejects our sends. Note `sameApplicationServerKey` returns
    // true when the key is unreadable, so this branch only fires on a genuine,
    // observed mismatch.
    if (subscription && !sameApplicationServerKey(subscription, applicationServerKey)) {
      oldEndpoint = subscription.endpoint
      await subscription.unsubscribe().catch(() => undefined)
      subscription = null
      wasExisting = false
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      })
    }

    // Always re-POST, even for an existing subscription: the row may have been
    // pruned server-side after a 404/410 from the push service, and
    // expirationTime may have moved. `oldEndpoint` is passed so a replaced
    // subscription does not leave an orphan row behind.
    await persist(subscription, oldEndpoint)

    return wasExisting ? { status: 'already-subscribed' } : { status: 'subscribed' }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Silent, no-prompt reconciliation. Safe to call on app boot from an effect.
 *
 * This is the counterpart to `pushsubscriptionchange` in app/sw.ts: if that
 * event fired while the session cookie was expired, the replacement endpoint
 * never reached the database and the user is silently unreachable. Running
 * this once per launch repairs that without any UI.
 *
 * It never prompts -- it bails out unless permission is ALREADY granted.
 */
export async function resyncPushSubscription(): Promise<ResyncResult> {
  if (typeof window === 'undefined') return { status: 'skipped' }
  if (isIos() && !isStandalone()) return { status: 'skipped' }
  if (!isPushSupported()) return { status: 'skipped' }
  if (!VAPID_PUBLIC_KEY) return { status: 'skipped' }
  if (Notification.permission !== 'granted') return { status: 'skipped' }

  try {
    const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    const registration = await getReadyRegistration()
    let subscription = await registration.pushManager.getSubscription()

    // No local subscription: do NOT create one here. Enrolment belongs behind
    // an explicit tap, and a silently created subscription would contradict a
    // user who turned notifications off in the app.
    if (!subscription) return { status: 'none' }

    let oldEndpoint: string | undefined
    let replaced = false
    if (!sameApplicationServerKey(subscription, applicationServerKey)) {
      oldEndpoint = subscription.endpoint
      await subscription.unsubscribe().catch(() => undefined)
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      })
      replaced = true
    }

    await persist(subscription, oldEndpoint)
    return replaced ? { status: 'replaced' } : { status: 'synced' }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function unsubscribeFromPush(): Promise<UnsubscribeResult> {
  if (typeof window === 'undefined' || !isPushSupported()) {
    return { status: 'not-subscribed' }
  }

  try {
    // Same hang risk as the subscribe path -- `ready` never rejects.
    const registration = await getReadyRegistration()
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return { status: 'not-subscribed' }

    const { endpoint } = subscription
    await subscription.unsubscribe().catch(() => undefined)

    // Best effort: the local subscription is already gone, so a failure here
    // only leaves a stale row that the sender prunes on its next 404/410.
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).catch(() => undefined)

    return { status: 'unsubscribed' }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

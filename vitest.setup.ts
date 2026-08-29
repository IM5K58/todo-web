import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeAll, vi } from 'vitest'

// RTL auto-cleans when globals are enabled, but be explicit so this still
// works if `globals` is ever turned off.
afterEach(() => {
  cleanup()
})

beforeAll(() => {
  // jsdom has no matchMedia -- anything reading prefers-color-scheme needs it.
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    })
  }

  // jsdom implements neither ResizeObserver nor IntersectionObserver.
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }

  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class {
      root = null
      rootMargin = ''
      thresholds: readonly number[] = []
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    } as unknown as typeof IntersectionObserver
  }

  // PWA surface: jsdom ships no service worker or Notification API.
  if (!('serviceWorker' in navigator)) {
    Object.defineProperty(navigator, 'serviceWorker', {
      writable: true,
      value: {
        register: vi.fn().mockResolvedValue({
          scope: '/',
          update: vi.fn(),
          pushManager: {
            subscribe: vi.fn(),
            getSubscription: vi.fn().mockResolvedValue(null),
          },
        }),
        ready: Promise.resolve({ pushManager: { getSubscription: vi.fn() } }),
        getRegistration: vi.fn().mockResolvedValue(undefined),
        addEventListener: vi.fn(),
      },
    })
  }

  if (!('Notification' in globalThis)) {
    Object.defineProperty(globalThis, 'Notification', {
      writable: true,
      value: Object.assign(vi.fn(), {
        permission: 'default',
        requestPermission: vi.fn().mockResolvedValue('granted'),
      }),
    })
  }
})

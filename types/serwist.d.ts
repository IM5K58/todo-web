import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist'

declare global {
  /**
   * `self.__SW_MANIFEST` is Serwist's default `injectionPoint`: an esbuild
   * `define` replaces the literal text at build time with the precache
   * manifest array. It is `undefined` in development, where
   * `disablePrecacheManifest` is forced on.
   */
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
  }

  /**
   * lib.webworker.d.ts types
   * `ServiceWorkerGlobalScopeEventMap["pushsubscriptionchange"]` as a plain
   * `Event`. Augmenting that map entry with a narrower type is a TS error
   * ("subsequent property declarations must have the same type"), so declare a
   * standalone interface and cast inside the listener instead.
   *
   * Note both fields are nullable AND `options` may be absent on a non-null
   * `oldSubscription` -- Firefox and WebKit both do this.
   */
  interface SerwistPushSubscriptionChangeEvent extends ExtendableEvent {
    readonly newSubscription: PushSubscription | null
    readonly oldSubscription: PushSubscription | null
  }
}

export {}

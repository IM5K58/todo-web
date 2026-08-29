'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'

import {
  SUBSCRIBE_MESSAGES_KO,
  UNSUBSCRIBE_MESSAGES_KO,
  currentPermission,
  isIos,
  isPushSupported,
  isStandalone,
  subscribeToPush,
  unsubscribeFromPush,
} from '@/lib/push/subscribe'
import { createClient } from '@/lib/supabase/client'

/**
 * /settings — 알림 설정.
 *
 * Two independent switches live here, and conflating them is the mistake this
 * page is laid out to prevent:
 *
 *   1. PUSH PERMISSION. An OS-level grant plus a live PushSubscription. Without
 *      it nothing in section 2 can ever be delivered, so section 2 stays
 *      visibly gated on it rather than silently failing at 21:00.
 *   2. 자동 알림. A row in the database saying "at this local time, if I still
 *      have unfinished tasks, remind ME". It is opt-in, defaults to OFF, and
 *      is self-targeted by construction: `set_auto_nudge` takes no user id and
 *      writes `auth.uid()`'s own row, so there is no way to schedule a
 *      notification at somebody else. The copy below says so out loud.
 *
 * Client Component throughout: every meaningful piece of state
 * (Notification.permission, display-mode: standalone, an existing
 * PushSubscription) only exists in the browser, and guessing on the server
 * would produce a hydration mismatch on the very first paint.
 */

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * The scheduler ticks every 5 minutes in UTC, so only 5-minute boundaries are
 * actually reachable — and `profiles_auto_nudge_at_5min_chk` plus the 22023
 * raise inside `set_auto_nudge` reject anything else outright.
 *
 * Every IANA offset in existence is a multiple of 15 minutes, so a 5-minute UTC
 * boundary is a 5-minute local boundary everywhere. There is no phase error to
 * apologise for.
 *
 * Deliberately two <select>s rather than `<input type="time" step="300">`:
 * iOS Safari's wheel picker ignores `step`, so the input would happily hand
 * back 21:03 and the save would fail with a message the user cannot act on.
 */
const HOURS = Array.from({ length: 24 }, (_, index) => index)
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]

const DEFAULT_HOUR = 21
const DEFAULT_MINUTE = 0

function pad2(value: number): string {
  return value.toString().padStart(2, '0')
}

/** Postgres `time` wants HH:MM:SS. PostgREST hands it back the same way. */
function toSqlTime(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}:00`
}

/**
 * Parse whatever `get_auto_nudge()` returned. A `time` column may serialise as
 * '21:00:00' or '21:00', and a legacy row could carry an off-boundary minute,
 * so snap to the nearest 5 rather than rendering a value the <select> has no
 * option for (which would silently show the wrong time).
 */
function parseSqlTime(raw: unknown): { hour: number; minute: number } {
  if (typeof raw !== 'string') return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE }
  const match = /^(\d{1,2}):(\d{2})/.exec(raw.trim())
  if (!match) return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE }

  const hour = Math.min(23, Math.max(0, Number(match[1])))
  const rawMinute = Math.min(59, Math.max(0, Number(match[2])))
  const minute = Math.min(55, Math.round(rawMinute / 5) * 5)

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE }
  }
  return { hour, minute }
}

/** "저녁 9시 00분" — friendlier than 21:00 for a Korean reader. */
function describeTime(hour: number, minute: number): string {
  const meridiem = hour < 12 ? '오전' : '오후'
  const displayHour = hour % 12 === 0 ? 12 : hour % 12
  return `${meridiem} ${displayHour}시 ${pad2(minute)}분`
}

// ---------------------------------------------------------------------------
// Push state
// ---------------------------------------------------------------------------

type PushState =
  /** Still reading browser state after mount. */
  | { kind: 'checking' }
  /** iPhone/iPad in a Safari tab: push cannot exist here at all. */
  | { kind: 'needs-install' }
  /** No Push API on this browser, and it is not the iOS install case. */
  | { kind: 'unsupported' }
  /** Blocked at the OS level — the app cannot re-prompt. */
  | { kind: 'denied' }
  /** Permission granted AND a live PushSubscription exists. */
  | { kind: 'on' }
  /** Push is possible, but not enabled yet (or the subscription is gone). */
  | { kind: 'off' }

/**
 * Whether this device currently holds a real PushSubscription.
 *
 * `Notification.permission === 'granted'` is NOT sufficient. A subscription can
 * be dropped by the browser, cleared with site data, or invalidated by a VAPID
 * rotation while permission stays granted — and in that state the toggle in
 * section 2 would look armed while every reminder silently goes nowhere.
 */
async function hasLiveSubscription(): Promise<boolean> {
  if (!isPushSupported()) return false
  try {
    const registration = await navigator.serviceWorker.getRegistration('/')
    if (!registration) return false
    return Boolean(await registration.pushManager.getSubscription())
  } catch {
    return false
  }
}

async function readPushState(): Promise<PushState> {
  // Order matters, exactly as in lib/push/subscribe.ts: on iOS the Push API
  // does not exist in a Safari tab, so feature-detecting first would tell every
  // iPhone visitor their browser is unsupported and hide the install route.
  if (isIos() && !isStandalone()) return { kind: 'needs-install' }
  if (!isPushSupported()) return { kind: 'unsupported' }

  const permission = currentPermission()
  if (permission === 'denied') return { kind: 'denied' }
  if (permission !== 'granted') return { kind: 'off' }

  return (await hasLiveSubscription()) ? { kind: 'on' } : { kind: 'off' }
}

// ---------------------------------------------------------------------------
// Auto reminder state
// ---------------------------------------------------------------------------

type AutoLoad =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="border-line bg-surface rounded-2xl border p-5">
      <h2 className="text-fg text-base font-semibold">{title}</h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted text-sm leading-relaxed [word-break:keep-all]">{children}</p>
  )
}

function StatusPill({ tone, children }: { tone: 'on' | 'off' | 'bad'; children: string }) {
  const toneClass =
    tone === 'on'
      ? 'bg-accent text-accent-fg'
      : tone === 'bad'
        ? 'border-danger text-danger border'
        : 'bg-surface-2 text-muted'
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium ${toneClass}`}
    >
      {children}
    </span>
  )
}

const primaryButton =
  'bg-accent text-accent-fg h-12 w-full rounded-xl text-base font-medium transition active:scale-[0.99] disabled:opacity-40'
const secondaryButton =
  'border-line text-fg h-12 w-full rounded-xl border text-base font-medium transition active:scale-[0.99] disabled:opacity-40'
const selectClass =
  'border-line bg-surface-2 text-fg h-12 flex-1 rounded-xl border px-3 tabular-nums disabled:opacity-40'

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const router = useRouter()

  const [push, setPush] = useState<PushState>({ kind: 'checking' })
  const [pushBusy, setPushBusy] = useState(false)
  const [pushMessage, setPushMessage] = useState<string | null>(null)

  const [autoLoad, setAutoLoad] = useState<AutoLoad>({ kind: 'loading' })
  const [enabled, setEnabled] = useState(false)
  const [hour, setHour] = useState(DEFAULT_HOUR)
  const [minute, setMinute] = useState(DEFAULT_MINUTE)
  const [lastOn, setLastOn] = useState<string | null>(null)
  /** True while the form differs from what the database last confirmed. */
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [timezone, setTimezone] = useState<string | null>(null)

  // ---- push state, resolved after mount ----------------------------------

  const refreshPush = useCallback(() => {
    let cancelled = false
    void readPushState().then((next) => {
      if (!cancelled) setPush(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const cancel = refreshPush()

    // iOS can flip to standalone without a reload when the app is reopened
    // from the Home Screen icon, which changes the answer above completely.
    const mql = window.matchMedia('(display-mode: standalone)')
    const onChange = () => refreshPush()
    mql.addEventListener('change', onChange)

    return () => {
      cancel()
      mql.removeEventListener('change', onChange)
    }
  }, [refreshPush])

  // ---- saved reminder settings -------------------------------------------

  useEffect(() => {
    let cancelled = false

    async function load() {
      const supabase = createClient()

      const [autoResult, profileResult] = await Promise.all([
        supabase.rpc('get_auto_nudge'),
        // auto_nudge_* columns are NOT selectable by `authenticated` — the
        // grant is column-scoped so groupmates cannot read them. `timezone` is,
        // and the reminder time is interpreted in it, so it is worth showing.
        supabase.auth.getClaims().then(({ data }) => {
          const userId = data?.claims.sub
          if (typeof userId !== 'string' || !userId) return null
          return supabase
            .from('profiles')
            .select('timezone')
            .eq('id', userId)
            .maybeSingle()
        }),
      ])

      if (cancelled) return

      if (autoResult.error) {
        setAutoLoad({
          kind: 'error',
          message:
            // PGRST202: the RPC is not in PostgREST's schema cache — migration
            // 0003 has not been applied (or its `notify pgrst` never ran).
            autoResult.error.code === 'PGRST202'
              ? '자동 알림 기능이 아직 서버에 적용되지 않았어요. 잠시 후 다시 시도해 주세요.'
              : autoResult.error.code === '42501'
                ? '로그인이 풀렸어요. 앱을 새로고침해 주세요.'
                : '알림 설정을 불러오지 못했어요.',
        })
        return
      }

      // `get_auto_nudge()` LEFT JOINs, so it always returns exactly one row
      // even for an account whose profile row is missing. Handle the empty
      // case anyway — falling back to the defaults is strictly better than
      // rendering a blank form.
      const row = (Array.isArray(autoResult.data)
        ? autoResult.data[0]
        : autoResult.data) as
        | { enabled?: unknown; at_local?: unknown; last_on?: unknown }
        | null
        | undefined

      const parsed = parseSqlTime(row?.at_local)
      setEnabled(row?.enabled === true)
      setHour(parsed.hour)
      setMinute(parsed.minute)
      setLastOn(typeof row?.last_on === 'string' ? row.last_on : null)
      setDirty(false)
      setAutoLoad({ kind: 'ready' })

      const tz = profileResult?.data?.timezone
      if (typeof tz === 'string' && tz.trim()) setTimezone(tz.trim())
    }

    void load().catch(() => {
      if (!cancelled) {
        setAutoLoad({ kind: 'error', message: '알림 설정을 불러오지 못했어요.' })
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  // ---- push actions -------------------------------------------------------

  async function enablePush() {
    setPushBusy(true)
    setPushMessage(null)
    try {
      // Must be awaited straight out of the click handler: on iOS any earlier
      // await consumes the transient activation and the permission prompt is
      // suppressed with no error at all.
      const result = await subscribeToPush()

      if (result.status === 'needs-install') {
        router.push('/install')
        return
      }

      setPushMessage(SUBSCRIBE_MESSAGES_KO[result.status])
      refreshPush()
    } finally {
      setPushBusy(false)
    }
  }

  async function disablePush() {
    setPushBusy(true)
    setPushMessage(null)
    try {
      const result = await unsubscribeFromPush()
      setPushMessage(UNSUBSCRIBE_MESSAGES_KO[result.status])
      refreshPush()
    } finally {
      setPushBusy(false)
    }
  }

  // ---- save reminder settings --------------------------------------------

  async function save() {
    setSaving(true)
    setSaveMessage(null)
    setSaveError(null)

    try {
      const supabase = createClient()
      const { error } = await supabase.rpc('set_auto_nudge', {
        p_enabled: enabled,
        p_at: toSqlTime(hour, minute),
      })

      if (error) {
        // The RPC raises rather than returning a reason code, so these are the
        // three SQLSTATEs it can produce. 22023 is unreachable from this UI —
        // the <select>s only offer boundaries — so if it ever fires, the bug is
        // in this file, not in what the user picked.
        setSaveError(
          error.code === '22023'
            ? '알림 시각은 5분 단위로만 정할 수 있어요.'
            : error.code === 'P0002'
              ? '프로필을 찾지 못했어요. 앱을 새로고침한 뒤 다시 시도해 주세요.'
              : error.code === '42501'
                ? '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.'
                : '저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
        )
        return
      }

      setDirty(false)
      setSaveMessage(
        enabled
          ? `매일 ${describeTime(hour, minute)}에 알려드릴게요.`
          : '자동 알림을 껐어요.',
      )

      // `set_auto_nudge` also recomputes the once-per-day guard, so re-read
      // rather than guessing what it decided.
      const { data } = await supabase.rpc('get_auto_nudge')
      const row = (Array.isArray(data) ? data[0] : data) as
        | { last_on?: unknown }
        | null
        | undefined
      setLastOn(typeof row?.last_on === 'string' ? row.last_on : null)
    } catch {
      setSaveError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.')
    } finally {
      setSaving(false)
    }
  }

  function markDirty() {
    setDirty(true)
    setSaveMessage(null)
    setSaveError(null)
  }

  // ---- render -------------------------------------------------------------

  const pushIsOn = push.kind === 'on'
  const autoReady = autoLoad.kind === 'ready'

  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      <header className="flex flex-col gap-1">
        <Link href="/" className="text-muted text-sm underline-offset-4 hover:underline">
          ← 오늘로 돌아가기
        </Link>
        <h1 className="text-fg mt-1 text-2xl font-semibold tracking-tight">알림 설정</h1>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* 1. 푸시 알림 권한                                                  */}
      {/* ---------------------------------------------------------------- */}
      <Section title="푸시 알림">
        <div className="flex items-center justify-between gap-3">
          <span className="text-fg text-sm">이 기기에서 알림 받기</span>
          {push.kind === 'checking' && <StatusPill tone="off">확인 중…</StatusPill>}
          {push.kind === 'on' && <StatusPill tone="on">켜짐</StatusPill>}
          {push.kind === 'off' && <StatusPill tone="off">꺼짐</StatusPill>}
          {push.kind === 'denied' && <StatusPill tone="bad">차단됨</StatusPill>}
          {push.kind === 'needs-install' && <StatusPill tone="bad">설치 필요</StatusPill>}
          {push.kind === 'unsupported' && <StatusPill tone="bad">미지원</StatusPill>}
        </div>

        {push.kind === 'checking' && (
          <p className="text-muted text-sm" aria-live="polite">
            브라우저 상태를 확인하고 있어요.
          </p>
        )}

        {push.kind === 'needs-install' && (
          <>
            <Hint>
              아이폰·아이패드는 <strong className="text-fg">홈 화면에 추가한 앱</strong>{' '}
              안에서만 알림을 켤 수 있어요. 사파리 탭에서는 아예 불가능합니다.
            </Hint>
            <Link href="/install" className={`${primaryButton} grid place-items-center`}>
              설치 방법 보기
            </Link>
          </>
        )}

        {push.kind === 'unsupported' && (
          <Hint>이 브라우저에서는 푸시 알림을 지원하지 않아요.</Hint>
        )}

        {push.kind === 'denied' && (
          <Hint>
            알림이 차단되어 있어요. 앱에서 다시 물어볼 수 없으니{' '}
            <strong className="text-fg">휴대폰 설정 › 알림</strong>에서 직접 켜주세요.
          </Hint>
        )}

        {push.kind === 'off' && (
          <>
            <Hint>친구가 콕 찔러줄 때, 그리고 아래 자동 알림이 이 기기로 옵니다.</Hint>
            <button
              type="button"
              onClick={enablePush}
              disabled={pushBusy}
              className={primaryButton}
            >
              {pushBusy ? '켜는 중…' : '알림 켜기'}
            </button>
          </>
        )}

        {push.kind === 'on' && (
          <button
            type="button"
            onClick={disablePush}
            disabled={pushBusy}
            className={secondaryButton}
          >
            {pushBusy ? '끄는 중…' : '이 기기에서 알림 끄기'}
          </button>
        )}

        {pushMessage && (
          <p className="text-fg text-sm" role="status" aria-live="polite">
            {pushMessage}
          </p>
        )}
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* 2. 자동 알림                                                       */}
      {/* ---------------------------------------------------------------- */}
      <Section title="자동 알림">
        <Hint>
          정한 시각에 <strong className="text-fg">내가 오늘 아직 못 끝낸 할 일</strong>이
          남아 있으면, <strong className="text-fg">나에게만</strong> 알림이 와요. 친구에게
          가지 않고, 친구가 나에게 설정할 수도 없어요.
        </Hint>

        {autoLoad.kind === 'loading' && (
          <p className="text-muted text-sm" aria-live="polite" aria-busy="true">
            저장된 설정을 불러오는 중이에요.
          </p>
        )}

        {autoLoad.kind === 'error' && (
          <>
            <p className="text-danger text-sm" role="alert">
              {autoLoad.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={secondaryButton}
            >
              다시 불러오기
            </button>
          </>
        )}

        {autoReady && (
          <>
            <label className="flex items-center justify-between gap-3 py-1">
              <span className="text-fg text-sm">자동 알림 사용</span>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => {
                  setEnabled(event.target.checked)
                  markDirty()
                }}
                disabled={saving}
                className="accent-accent h-6 w-6 shrink-0"
              />
            </label>

            <div className="flex items-center gap-2">
              <label className="sr-only" htmlFor="auto-nudge-hour">
                알림 시
              </label>
              <select
                id="auto-nudge-hour"
                value={hour}
                onChange={(event) => {
                  setHour(Number(event.target.value))
                  markDirty()
                }}
                disabled={saving || !enabled}
                className={selectClass}
              >
                {HOURS.map((value) => (
                  <option key={value} value={value}>
                    {pad2(value)}시
                  </option>
                ))}
              </select>

              <label className="sr-only" htmlFor="auto-nudge-minute">
                알림 분
              </label>
              <select
                id="auto-nudge-minute"
                value={minute}
                onChange={(event) => {
                  setMinute(Number(event.target.value))
                  markDirty()
                }}
                disabled={saving || !enabled}
                className={selectClass}
              >
                {MINUTES.map((value) => (
                  <option key={value} value={value}>
                    {pad2(value)}분
                  </option>
                ))}
              </select>
            </div>

            <Hint>
              5분 단위로만 정할 수 있어요. 알림은 정확히 그 시각이 아니라{' '}
              <strong className="text-fg">그 시각부터 5분 안쪽</strong>에 도착해요.
              {timezone ? ` 기준 시간대는 ${timezone} 이에요.` : null}
            </Hint>

            <button
              type="button"
              onClick={save}
              disabled={saving || !dirty}
              className={primaryButton}
            >
              {saving ? '저장 중…' : dirty ? '저장하기' : '저장됨'}
            </button>

            {saveMessage && (
              <p className="text-fg text-sm" role="status" aria-live="polite">
                {saveMessage}
              </p>
            )}
            {saveError && (
              <p className="text-danger text-sm" role="alert">
                {saveError}
              </p>
            )}

            {enabled && !pushIsOn && push.kind !== 'checking' && (
              <p className="border-danger text-danger rounded-xl border p-3 text-sm leading-relaxed">
                자동 알림은 켜져 있지만 이 기기의 푸시 알림이 꺼져 있어요. 위에서 먼저
                알림을 켜야 실제로 받을 수 있어요.
              </p>
            )}

            {enabled && (
              <Hint>
                오늘 적어둔 할 일이 하나도 없으면 알림도 오지 않아요. 하루에 한 번만
                보내기 때문에, 오늘 이미 받은 뒤에 시각을 바꾸면 그 알림은 내일부터
                적용돼요.
                {lastOn ? ` (마지막 발송: ${lastOn})` : ' (아직 받은 적 없어요)'}
              </Hint>
            )}
          </>
        )}
      </Section>
    </main>
  )
}

'use client'

import Link from 'next/link'
import { useId, useState } from 'react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { useFormStatus } from 'react-dom'

/**
 * Shared UI primitives.
 *
 * The visual language here is lifted verbatim from app/settings/page.tsx — the
 * most developed screen in the app — so that the group/onboarding screens land
 * looking like the same product rather than a second design:
 *
 *   card    : border-line bg-surface rounded-2xl border p-5
 *   control : h-12 rounded-xl  (48px, comfortably over the 44px touch target)
 *   press   : transition active:scale-[0.99]
 *   disabled: opacity-40
 *
 * Only utilities that app/globals.css actually generates are used. The theme
 * exposes: bg / surface / surface-2 / fg / muted / line / accent / accent-fg /
 * danger, plus the px-safe / pt-safe / pb-safe / screen-safe helpers. Note the
 * border token is `line`, NOT `border` — `border-border` does not exist.
 *
 * This is a Client module because Button reads useFormStatus(), which is what
 * makes every Server Action form get an honest pending state for free. Server
 * Components can still import and render all of it; only the leaf ships JS.
 */

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'danger'
export type ButtonSize = 'md' | 'sm'

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg',
  secondary: 'border-line bg-surface text-fg border',
  danger: 'border-danger text-danger border',
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  md: 'h-12 w-full px-4 text-base',
  // 44px — the iOS minimum, for the inline actions in a member row.
  sm: 'h-11 px-4 text-sm',
}

const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-medium transition active:scale-[0.99] disabled:pointer-events-none disabled:opacity-40'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /**
   * Force the pending state. Leave it off inside a Server Action <form>: a
   * type="submit" button already picks pending up from useFormStatus().
   */
  pending?: boolean
  /** Label shown while pending, e.g. '저장 중…'. Falls back to children. */
  pendingLabel?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  pending,
  pendingLabel,
  type = 'button',
  disabled,
  className = '',
  children,
  ...props
}: ButtonProps) {
  const status = useFormStatus()
  // Only a submit button should go busy when its own form is submitting —
  // a 취소 button sitting next to it must stay clickable-looking.
  const isPending = pending ?? (type === 'submit' && status.pending)

  return (
    <button
      type={type}
      disabled={disabled || isPending}
      aria-busy={isPending || undefined}
      className={`${BUTTON_BASE} ${SIZE_CLASS[size]} ${VARIANT_CLASS[variant]} ${className}`}
      {...props}
    >
      {isPending && pendingLabel ? pendingLabel : children}
    </button>
  )
}

/** A <Link> that looks exactly like a Button. For navigation, not for actions. */
export function LinkButton({
  href,
  variant = 'primary',
  size = 'md',
  className = '',
  children,
}: {
  href: string
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
  children: ReactNode
}) {
  return (
    <Link
      href={href}
      className={`${BUTTON_BASE} ${SIZE_CLASS[size]} ${VARIANT_CLASS[variant]} ${className}`}
    >
      {children}
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Text bits
// ---------------------------------------------------------------------------

/** Muted explanatory copy. `keep-all` stops Korean breaking mid-word. */
export function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted text-sm leading-relaxed [word-break:keep-all]">{children}</p>
  )
}

/**
 * An error the user needs to read. Renders nothing when there is no error, so
 * callers can pass a nullable state straight in without a ternary.
 */
export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null
  return (
    <p className="text-danger text-sm leading-relaxed [word-break:keep-all]" role="alert">
      {children}
    </p>
  )
}

/** A confirmation the user needs to read. Announced politely, not urgently. */
export function SuccessText({ children }: { children?: ReactNode }) {
  if (!children) return null
  return (
    <p className="text-fg text-sm leading-relaxed" role="status" aria-live="polite">
      {children}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The standard page top: an optional back link, the title, optional copy.
 * Pair it with <Screen> from '@/components/screen' -- the page wrapper the
 * settings screen established, which also carries the <BottomNav> clearance.
 */
export function PageHeader({
  title,
  backHref,
  backLabel,
  description,
}: {
  title: string
  backHref?: string
  backLabel?: string
  description?: ReactNode
}) {
  return (
    <header className="flex flex-col gap-1">
      {backHref && (
        <Link
          href={backHref}
          className="text-muted inline-flex h-11 items-center text-sm underline-offset-4 hover:underline"
        >
          ← {backLabel ?? '뒤로'}
        </Link>
      )}
      <h1 className="text-fg mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <Hint>{description}</Hint>}
    </header>
  )
}

/** The card every block of content sits in. `title` renders an <h2>. */
export function Card({
  title,
  children,
  className = '',
}: {
  title?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`border-line bg-surface rounded-2xl border p-5 ${className}`}>
      {title && <h2 className="text-fg text-base font-semibold">{title}</h2>}
      <div className={`flex flex-col gap-3 ${title ? 'mt-3' : ''}`}>{children}</div>
    </section>
  )
}

/** Standalone label, for controls that are not <Input> (selects, groups). */
export function Label({
  htmlFor,
  children,
}: {
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <label htmlFor={htmlFor} className="text-fg text-sm font-medium">
      {children}
    </label>
  )
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: ReactNode
  /** Nullable so a Server Action's returned error state drops straight in. */
  error?: string | null
}

export function Input({
  label,
  hint,
  error,
  id,
  className = '',
  ...props
}: InputProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`

  const describedBy = [hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label htmlFor={inputId}>{label}</Label>}
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`border-line bg-surface-2 text-fg placeholder:text-muted h-12 w-full rounded-xl border px-3 outline-none disabled:opacity-40 ${
          error ? 'border-danger' : ''
        } ${className}`}
        {...props}
      />
      {hint && (
        <p id={hintId} className="text-muted text-sm leading-relaxed [word-break:keep-all]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-danger text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Lists / empty state
// ---------------------------------------------------------------------------

/** One row in a list — a member, a group. `trailing` is where an action goes. */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
}: {
  leading?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  trailing?: ReactNode
}) {
  return (
    <div className="border-line flex min-h-14 items-center gap-3 border-b py-2 last:border-b-0">
      {leading && (
        <div className="bg-surface-2 grid size-10 shrink-0 place-items-center rounded-full text-lg">
          {leading}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-fg truncate text-sm font-medium">{title}</p>
        {subtitle && <p className="text-muted truncate text-xs">{subtitle}</p>}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  )
}

/** Honest "there is nothing here yet" — never a stand-in for a failed load. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
      <p className="text-fg text-sm font-medium">{title}</p>
      {description && (
        <p className="text-muted text-sm leading-relaxed [word-break:keep-all]">
          {description}
        </p>
      )}
      {action && <div className="mt-2 w-full">{action}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Copyable value (the invite code)
// ---------------------------------------------------------------------------

/**
 * Shows a value and copies it on tap.
 *
 * The value stays selectable text, so the screen still works when the
 * Clipboard API is unavailable (http origins, older Android WebViews) — and in
 * that case it says so instead of pretending the copy succeeded.
 */
export function CopyField({
  value,
  label,
  hint,
}: {
  value: string
  label?: string
  hint?: ReactNode
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label>{label}</Label>}
      <div className="flex items-center gap-2">
        <p className="border-line bg-surface-2 text-fg flex h-12 min-w-0 flex-1 items-center overflow-x-auto rounded-xl border px-3 font-mono text-lg tracking-widest select-all">
          {value}
        </p>
        <Button type="button" size="sm" variant="secondary" onClick={copy}>
          복사
        </Button>
      </div>
      {state === 'copied' && <SuccessText>초대코드를 복사했어요.</SuccessText>}
      {state === 'failed' && (
        <ErrorText>복사하지 못했어요. 코드를 길게 눌러 직접 복사해 주세요.</ErrorText>
      )}
      {hint && <Hint>{hint}</Hint>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Destructive confirm
// ---------------------------------------------------------------------------

/**
 * A two-step destructive submit for 나가기 / 내보내기.
 *
 * Deliberately not window.confirm(): it is blocked in some standalone PWA
 * contexts and it freezes the whole page. The armed state is inline, so the
 * warning text can say exactly what is about to happen — which matters here,
 * because 내보내기 rotates the invite code as a side effect.
 *
 * Must be rendered inside the <form> whose Server Action it submits.
 */
export function ConfirmButton({
  children,
  confirmMessage,
  confirmLabel = '네, 진행할게요',
  cancelLabel = '취소',
  pendingLabel = '처리 중…',
  size = 'md',
  disabled,
  name,
  value,
}: {
  /** Idle label, e.g. '내보내기'. */
  children: ReactNode
  /** What arming the button warns about. */
  confirmMessage: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  pendingLabel?: string
  size?: ButtonSize
  disabled?: boolean
  /** Forwarded to the submit button so one form can target several rows. */
  name?: string
  value?: string
}) {
  const [armed, setArmed] = useState(false)
  const { pending } = useFormStatus()

  if (!armed) {
    return (
      <Button
        type="button"
        variant="danger"
        size={size}
        disabled={disabled || pending}
        onClick={() => setArmed(true)}
      >
        {children}
      </Button>
    )
  }

  return (
    <div className="border-danger flex flex-col gap-2 rounded-xl border p-3">
      <p className="text-danger text-sm leading-relaxed [word-break:keep-all]" role="alert">
        {confirmMessage}
      </p>
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="danger"
          size={size}
          name={name}
          value={value}
          disabled={disabled}
          pendingLabel={pendingLabel}
        >
          {confirmLabel}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size={size}
          disabled={pending}
          onClick={() => setArmed(false)}
        >
          {cancelLabel}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Task checkbox  (Phase 2 — /)
// ---------------------------------------------------------------------------

/** The tick inside a checked box. Sized to the box, inherits currentColor. */
function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12.5 10 17.5 19 7" />
    </svg>
  )
}

export interface TaskCheckboxProps {
  /** Current stored state. Pass the optimistic value if the caller keeps one. */
  checked: boolean
  /**
   * The task text. Rendered inside the button so the whole row is one tap
   * target, and struck through when checked.
   */
  children?: ReactNode
  /** Accessible name when there is no `children` (icon-only usage). */
  label?: string
  /** Forwarded to the submit button, so one <form> can serve several rows. */
  name?: string
  value?: string
  disabled?: boolean
  /**
   * Force the pending look. Leave it off inside a Server Action <form>: the
   * component reads useFormStatus() exactly like Button does.
   */
  pending?: boolean
  className?: string
}

/**
 * A checkbox that is really a submit button.
 *
 * It has to live inside a Server Action <form> — that is the whole point: no
 * onChange handler, no client fetch, and useFormStatus() gives an honest
 * pending state for free. `role="checkbox"` + `aria-checked` keeps the
 * semantics a screen reader expects even though the element is a <button>.
 *
 * Touch target: the button is min-h-11 (44px, the iOS minimum) and full width,
 * so the label text is part of the tap area rather than a 24px bullseye.
 *
 * While pending the row dims and the box shows a spinner ring, and the button
 * disables itself so a double-tap cannot fire two toggles at the same row.
 */
export function TaskCheckbox({
  checked,
  children,
  label,
  name,
  value,
  disabled,
  pending,
  className = '',
}: TaskCheckboxProps) {
  const status = useFormStatus()
  const isPending = pending ?? status.pending

  return (
    <button
      type="submit"
      role="checkbox"
      aria-checked={checked}
      aria-label={children ? undefined : label}
      aria-busy={isPending || undefined}
      name={name}
      value={value}
      disabled={disabled || isPending}
      className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-1 py-2 text-left transition active:scale-[0.99] disabled:pointer-events-none ${
        isPending ? 'opacity-60' : ''
      } ${className}`}
    >
      <span
        aria-hidden="true"
        className={`grid size-6 shrink-0 place-items-center rounded-md border transition ${
          checked ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface-2'
        }`}
      >
        {isPending ? (
          // A ring, not a tick: the toggle has not landed yet, so showing the
          // new state here would be a lie the server might not agree with.
          <span
            className={`size-3 animate-spin rounded-full border-2 border-current border-t-transparent ${
              checked ? 'text-accent-fg' : 'text-muted'
            }`}
          />
        ) : checked ? (
          <CheckIcon />
        ) : null}
      </span>

      {children && (
        <span
          className={`min-w-0 flex-1 text-base leading-snug [word-break:keep-all] ${
            checked ? 'text-muted line-through' : 'text-fg'
          }`}
        >
          {children}
        </span>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface ProgressBarProps {
  /** Completed count. Clamped into 0..max, so a stale count cannot overflow. */
  value: number
  /** Total count. `0` renders an inert empty track (nothing to measure yet). */
  max: number
  /** Accessible name, e.g. '민수님의 오늘 진행 상황'. */
  label?: string
  className?: string
}

/**
 * A determinate progress bar.
 *
 * Colour carries the "done" state: a partly-filled bar is a softened accent,
 * a full one is the solid accent — enough to pick the finished members out of
 * a list at a glance without inventing a colour the theme does not have.
 *
 * The only animation is the width transition, and app/globals.css already
 * neutralises it under prefers-reduced-motion.
 */
export function ProgressBar({ value, max, label, className = '' }: ProgressBarProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0
  const safeValue =
    safeMax === 0 ? 0 : Math.min(Math.max(Math.floor(value) || 0, 0), safeMax)
  const percent = safeMax === 0 ? 0 : (safeValue / safeMax) * 100
  const complete = safeMax > 0 && safeValue === safeMax

  const track = `bg-surface-2 h-2 w-full overflow-hidden rounded-full ${className}`

  // max = 0 means "no tasks yet". A progressbar of 0 out of 0 is meaningless to
  // announce, so the track stays decorative and the caller says why in text.
  if (safeMax === 0) {
    return <div aria-hidden="true" className={track} />
  }

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={safeValue}
      aria-valuetext={`${safeMax}개 중 ${safeValue}개 완료`}
      aria-label={label}
      className={track}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ${
          complete ? 'bg-accent' : 'bg-accent/60'
        }`}
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Streak
// ---------------------------------------------------------------------------

export interface StreakBadgeProps {
  /** Consecutive days. Anything ≤ 0 (or NaN) is treated as "no streak yet". */
  days: number
  /**
   * Render nothing at 0 instead of the invitation pill. Use it where a second
   * line of encouragement would just be noise (inside a dense list row).
   */
  hideWhenZero?: boolean
  className?: string
}

/**
 * 연속 일수.
 *
 * At 0 this deliberately does NOT disappear by default: a brand-new user
 * staring at a blank home screen gets 오늘부터 시작해요 instead of nothing,
 * and it is still the truth — no fabricated number. Pass hideWhenZero where
 * that invitation does not fit.
 */
export function StreakBadge({ days, hideWhenZero = false, className = '' }: StreakBadgeProps) {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0

  if (safeDays === 0 && hideWhenZero) return null

  const base =
    'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-medium'

  if (safeDays === 0) {
    return (
      <span className={`bg-surface-2 text-muted ${base} ${className}`}>
        <span aria-hidden="true">🌱</span>
        오늘부터 시작해요
      </span>
    )
  }

  return (
    <span className={`bg-accent text-accent-fg ${base} ${className}`}>
      <span aria-hidden="true">🔥</span>
      {safeDays}일 연속
    </span>
  )
}

// ---------------------------------------------------------------------------
// Member progress row  (Phase 2 — /status)
// ---------------------------------------------------------------------------

export interface MemberProgressRowProps {
  /** Avatar emoji from profiles.avatar_emoji. Falls back to 🙂. */
  emoji?: ReactNode
  name: string
  isSelf?: boolean
  /** Completed / total tasks for that member today. */
  done: number
  total: number
  /** Where 콕 찌르기 goes. Give it a `sm` Button so it stays a 44px target. */
  action?: ReactNode
  /** Replaces the default copy shown when `total` is 0. */
  note?: ReactNode
}

/**
 * One member on the 현황 screen.
 *
 * ListRow is not enough here: its subtitle is a single truncating <p>, and a
 * progress bar plus an n/m counter cannot live inside that. Everything else —
 * the 40px emoji circle, the min-h-14 row, the bottom divider — is copied from
 * ListRow so the two read as the same list.
 *
 * Divider caveat, same as ListRow: if you wrap each row in an <li>, the row is
 * always its <li>'s last child so `last:border-b-0` never fires. Put the border
 * on the <li> in that case (see app/groups/page.tsx), or render rows as
 * siblings inside one <div>.
 */
export function MemberProgressRow({
  emoji,
  name,
  isSelf = false,
  done,
  total,
  action,
  note,
}: MemberProgressRowProps) {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  const safeDone =
    safeTotal === 0 ? 0 : Math.min(Math.max(Math.floor(done) || 0, 0), safeTotal)
  const complete = safeTotal > 0 && safeDone === safeTotal

  return (
    <div className="border-line flex min-h-14 items-center gap-3 border-b py-3 last:border-b-0">
      <div
        aria-hidden="true"
        className="bg-surface-2 grid size-10 shrink-0 place-items-center rounded-full text-lg"
      >
        {emoji ?? '🙂'}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-fg truncate text-sm font-medium">
          {name}
          {isSelf && <span className="text-muted font-normal"> (나)</span>}
        </p>

        {safeTotal === 0 ? (
          <p className="text-muted text-xs [word-break:keep-all]">
            {note ?? '아직 오늘 할 일을 적지 않았어요.'}
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <ProgressBar
              value={safeDone}
              max={safeTotal}
              label={`${name}님의 오늘 진행 상황`}
              className="min-w-0 flex-1"
            />
            <span
              className={`shrink-0 text-xs tabular-nums ${
                complete ? 'text-accent font-medium' : 'text-muted'
              }`}
            >
              {safeDone}/{safeTotal}
            </span>
          </div>
        )}
      </div>

      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

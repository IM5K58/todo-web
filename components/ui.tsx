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
 * Pair it with the page wrapper the settings screen uses:
 *   <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
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

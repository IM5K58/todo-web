'use client'

import type { FormEvent } from 'react'

import { Button, Card, Hint, Input, SuccessText } from '@/components/ui'

import { AvatarBubble } from './avatar-bubble'

/**
 * 화면 맨 위의 프로필 카드와 그 아래 이름 카드. app/me/page.tsx 의 JSX 를
 * 그대로 옮긴 것입니다 — 값은 전부 page.tsx 가 계산해 props 로 내려보냅니다.
 * (아바타 우선순위는 lib/avatar.ts 의 resolveAvatar() 하나만 정합니다.)
 */

/** 사진 · 이름 · 가입일 한 줄. */
export function ProfileSummaryCard({
  avatarImageUrl,
  avatarEmoji,
  displayName,
  joinedAt,
  avatarSourceLabel,
}: {
  avatarImageUrl: string | null
  avatarEmoji: string
  displayName: string
  /** 'ko-KR' 로 이미 포맷된 문자열. 못 만들었으면 null 입니다. */
  joinedAt: string | null
  avatarSourceLabel: string
}) {
  return (
    <Card>
      <div className="flex items-center gap-4">
        <AvatarBubble
          imageUrl={avatarImageUrl}
          emoji={avatarEmoji}
          size="size-16"
          // 이름이 바로 옆에 글자로 있으므로 alt 는 빈 문자열입니다.
          // (lib/avatar.ts 의 avatarAltText 가 설명하는 그 규칙)
          alt=""
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-fg truncate text-lg font-semibold">{displayName}</p>
          {joinedAt ? (
            <p className="text-muted text-xs">{joinedAt} 가입</p>
          ) : (
            <p className="text-muted text-xs">가입일을 불러오지 못했어요.</p>
          )}
        </div>
      </div>
      <Hint>{avatarSourceLabel}</Hint>
    </Card>
  )
}

/** 표시 이름 바꾸기. 저장은 page.tsx 가 Server Action 으로 합니다. */
export function NameCard({
  draft,
  onDraftChange,
  onSubmit,
  error,
  done,
  saving,
  nameMax,
  saveDisabled,
}: {
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  error: string | null
  done: boolean
  saving: boolean
  nameMax: number
  /** "바뀐 게 없다" 판정은 page.tsx 가 합니다 — 프로필 행이 없는 계정 예외 포함. */
  saveDisabled: boolean
}) {
  return (
    <Card title="이름">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Input
          id="display-name"
          name="display_name"
          type="text"
          label="이름"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          error={error}
          required
          // 브라우저가 세는 40 은 UTF-16 코드 유닛이라 이모지가 섞이면 DB 기준
          // 40자보다 짧게 잘립니다. 서버보다 엄격한 쪽이라 안전합니다.
          maxLength={nameMax}
          autoComplete="nickname"
          enterKeyHint="done"
          placeholder="예: 지수"
          hint="1~40자. 친구들에게 이 이름으로 보여요."
          disabled={saving}
        />

        {done && <SuccessText>이름을 바꿨어요.</SuccessText>}

        <Button
          type="submit"
          variant="primary"
          pending={saving}
          pendingLabel="저장 중…"
          disabled={saveDisabled}
        >
          이름 저장
        </Button>
      </form>
    </Card>
  )
}

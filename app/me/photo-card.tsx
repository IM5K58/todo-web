'use client'

import Link from 'next/link'
import type { ChangeEvent, RefObject } from 'react'

import { Button, Card, ErrorText, Hint, Label, SuccessText } from '@/components/ui'
import { AVATAR_MAX_EDGE } from '@/lib/image-normalize'

import { AvatarBubble } from './avatar-bubble'
import { ACCEPT_ATTR } from './avatar-storage'

/**
 * 「프로필 사진」 카드. app/me/page.tsx 의 JSX 를 그대로 옮긴 것입니다.
 *
 * 상태(고른 파일 · 진행 중 · 실패 · 성공)와 실제 업로드 절차는 여전히
 * page.tsx 에 있습니다. 이 파일은 그것을 그리기만 합니다 — 여기서 상태를
 * 새로 만들면 사진 흐름이 두 군데로 갈라집니다.
 */
export function PhotoCard({
  photoError,
  photoDone,
  previewUrl,
  avatarImageUrl,
  avatarEmoji,
  file,
  photoBusy,
  fileInputRef,
  onPickFile,
  onUpload,
  googleUrl,
  onUseGoogle,
  storedAvatarUrl,
  onClear,
}: {
  photoError: string | null
  photoDone: string | null
  previewUrl: string | null
  /** resolveAvatar() 가 고른 사진. 미리보기가 있으면 그쪽이 이깁니다. */
  avatarImageUrl: string | null
  avatarEmoji: string
  file: File | null
  photoBusy: null | 'upload' | 'google' | 'clear'
  fileInputRef: RefObject<HTMLInputElement | null>
  onPickFile: (event: ChangeEvent<HTMLInputElement>) => void
  onUpload: () => void
  /** 구글 계정에 사진이 있을 때만 문자열입니다. 없으면 버튼도 없습니다. */
  googleUrl: string | null
  onUseGoogle: () => void
  /** profiles.avatar_url 원본(가공하지 않은 값). 있을 때만 지우기 버튼. */
  storedAvatarUrl: string | null
  onClear: () => void
}) {
  return (
    <Card title="프로필 사진">
      <ErrorText>{photoError}</ErrorText>
      <SuccessText>{photoDone}</SuccessText>

      <div className="flex items-center gap-3">
        <AvatarBubble
          imageUrl={previewUrl ?? avatarImageUrl}
          emoji={avatarEmoji}
          size="size-12"
          alt={previewUrl ? '고른 사진 미리보기' : ''}
        />
        <p className="text-muted min-w-0 flex-1 text-xs [word-break:keep-all]">
          {previewUrl
            ? '고른 사진이에요. 아래 버튼을 눌러야 저장돼요.'
            : `JPG · PNG · WEBP, 2MB 이하 · 올릴 때 ${AVATAR_MAX_EDGE}px 로 줄이고 위치 정보를 지워요`}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="avatar-file">사진 고르기</Label>
        <input
          id="avatar-file"
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          onChange={onPickFile}
          disabled={photoBusy !== null}
          className="border-line bg-surface-2 text-fg file:bg-surface file:text-fg file:border-line h-12 w-full rounded-xl border px-3 text-sm file:mr-3 file:h-8 file:rounded-lg file:border file:px-3 file:text-sm disabled:opacity-40"
        />
      </div>

      <Button
        type="button"
        variant="primary"
        disabled={!file || photoBusy !== null}
        pending={photoBusy === 'upload'}
        pendingLabel="올리는 중…"
        onClick={onUpload}
      >
        이 사진으로 바꾸기
      </Button>

      {/* 구글 사진은 로그인 계정에 사진이 실제로 있을 때만 제안합니다.
          없는데 버튼만 보이면 눌러 본 뒤에야 없다는 걸 알게 됩니다. */}
      {googleUrl && (
        <Button
          type="button"
          variant="secondary"
          disabled={photoBusy !== null}
          pending={photoBusy === 'google'}
          pendingLabel="바꾸는 중…"
          onClick={onUseGoogle}
        >
          구글 사진 쓰기
        </Button>
      )}

      {/* 지울 사진이 있을 때만 보여 줍니다. avatar_url 이 이미 비어 있으면
          누를 이유가 없고, 이미 이모지를 쓰는 중입니다. */}
      {storedAvatarUrl && (
        <Button
          type="button"
          variant="secondary"
          disabled={photoBusy !== null}
          pending={photoBusy === 'clear'}
          pendingLabel="되돌리는 중…"
          onClick={onClear}
        >
          이모지로 되돌리기
        </Button>
      )}

      <Hint>
        {googleUrl
          ? `사진을 지우면 나에게는 구글 사진이, 친구들에게는 이모지(${avatarEmoji})가 보여요. `
          : `사진을 지우면 이모지(${avatarEmoji})로 보여요. `}
        이모지는{' '}
        <Link href="/onboarding" className="text-accent underline underline-offset-4">
          프로필 수정
        </Link>
        에서 바꿀 수 있어요.
      </Hint>
    </Card>
  )
}

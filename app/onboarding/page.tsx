import { redirect } from 'next/navigation'

import { Button, Card, ErrorText, Hint, Input, PageHeader } from '@/components/ui'
import { createClient } from '@/lib/supabase/server'

import { saveProfile } from './actions'

/**
 * /onboarding -- 프로필 이름/이모지 설정.
 *
 * 구글 로그인 직후 처음 들르는 화면이자, 나중에 다시 들어오면 "프로필 수정"이
 * 되는 화면입니다. 두 경우를 다른 라우트로 나누지 않은 이유는 하는 일이 완전히
 * 같기 때문입니다. 달라지는 건 문구와 뒤로가기 링크뿐입니다.
 *
 * 서버 컴포넌트 + Server Action 만으로 되어 있고 클라이언트 컴포넌트가 하나도
 * 없습니다. 이모지 선택은 라디오 버튼과 `peer-checked:` 로 CSS 만 써서 그리고,
 * 저장 중 표시는 components/ui.tsx 의 <Button type="submit"> 이 useFormStatus()
 * 로 알아서 붙여 줍니다. JS 가 아직 안 붙은 첫 페인트에서도 폼이 동작합니다.
 */

// ---------------------------------------------------------------------------
// 이모지 후보
// ---------------------------------------------------------------------------

/**
 * 전체 이모지 키보드가 아니라 작은 큐레이션입니다. 3~6명이 서로를 한눈에
 * 구분하는 게 목적이라 골고루 다르게 생긴 것들로 고릅니다.
 *
 * 전부 코드 포인트 1개짜리입니다. ZWJ 로 이어 붙인 이모지(예: 👩‍💻)는
 * char_length 가 3 이상이라 profiles_avatar_emoji_len_chk(1..8)에 금방 닿습니다.
 *
 * 이 목록은 actions.ts 에 복제되어 있지 않습니다. 'use server' 파일은 async
 * 함수만 export 할 수 있어서 공유가 안 되고, 복제하면 조용히 어긋납니다.
 * 액션은 대신 DB 제약과 같은 규칙(길이)으로 검사합니다.
 */
const AVATAR_CHOICES: readonly string[] = [
  '🙂', '😎', '🥳', '😴',
  '🐣', '🐱', '🐶', '🦊',
  '🐻', '🐧', '🌱', '🌸',
  '🍀', '⭐', '🔥', '🚀',
]

/** handle_new_user() 가 넣어 두는 기본값. 첫 방문인지 판단하는 기준입니다. */
const DEFAULT_DISPLAY_NAME = '친구'
const DEFAULT_AVATAR_EMOJI = '🙂'

// ---------------------------------------------------------------------------
// 오류 문구
// ---------------------------------------------------------------------------

/** 액션이 `?error=` 로 돌려보내는 코드. 사용자가 읽을 한국어로만 바꿉니다. */
const ERROR_MESSAGES: Record<string, string> = {
  name_empty: '이름을 입력해 주세요.',
  name_long: '이름은 40자까지 쓸 수 있어요.',
  emoji_invalid: '이모지를 다시 골라 주세요.',
  constraint: '이름이나 이모지를 저장할 수 없는 형태예요. 다시 골라 주세요.',
  forbidden: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  save_failed: '저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
}

/** 이름 칸 옆에 붙일 오류인지, 카드 위쪽에 따로 띄울 오류인지. */
const NAME_ERROR_CODES = new Set(['name_empty', 'name_long'])

function readErrorCode(raw: string | string[] | undefined): string | null {
  const code = Array.isArray(raw) ? raw[0] : raw
  if (typeof code !== 'string' || !(code in ERROR_MESSAGES)) return null
  return code
}

// ---------------------------------------------------------------------------
// 이모지 선택 (라디오 그룹, JS 없음)
// ---------------------------------------------------------------------------

function EmojiPicker({ choices, current }: { choices: readonly string[]; current: string }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-fg mb-2 text-sm font-medium">이모지</legend>

      <div className="grid grid-cols-4 gap-2">
        {choices.map((emoji) => (
          <label key={emoji} className="block cursor-pointer">
            {/*
              라디오의 value 가 그대로 아바타가 됩니다. 화면에 그려진 후보
              중에서만 고를 수 있으므로 "지금 쓰는 이모지 그대로 두기" 는 아래
              choices 계산이 현재 값을 항상 포함시키는 것으로 해결됩니다.
            */}
            <input
              type="radio"
              name="avatar_emoji"
              value={emoji}
              defaultChecked={emoji === current}
              className="peer sr-only"
            />
            {/* aria-hidden 을 붙이지 않습니다. 이 글자가 곧 라디오 버튼의
                접근성 이름이고, 스크린 리더는 이모지 이름을 읽어 줍니다. */}
            <span className="border-line bg-surface-2 peer-checked:border-accent peer-checked:ring-accent peer-focus-visible:outline-accent grid h-14 w-full place-items-center rounded-xl border text-2xl transition peer-checked:ring-2 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2">
              {emoji}
            </span>
          </label>
        ))}
      </div>

      <Hint>지금 쓰는 이모지는 처음에 선택되어 있어요. 그대로 두어도 괜찮아요.</Hint>
    </fieldset>
  )
}

// ---------------------------------------------------------------------------
// 페이지
// ---------------------------------------------------------------------------

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [params, supabase] = await Promise.all([searchParams, createClient()])

  // getClaims() 는 JWT 서명을 검증합니다. getSession() 은 쿠키를 그대로 돌려줄
  // 뿐이라 인가 검사가 아닙니다.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub

  if (claimsError || !userId) {
    redirect('/login?next=%2Fonboarding')
  }

  // profiles 는 컬럼 단위 SELECT 권한입니다(0003). '*' 는 42501 이므로 컬럼을
  // 이름으로 고릅니다.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('display_name, avatar_emoji')
    .eq('id', userId)
    .maybeSingle()

  // 프로필 행이 없을 수도 있습니다. handle_new_user() 는 실패를 삼키고 가입을
  // 통과시키기 때문입니다. 그 경우에도 화면은 기본값으로 정상 동작하고,
  // 저장할 때 액션이 안전밸브로 INSERT 합니다.
  const currentName = profile?.display_name.trim() || DEFAULT_DISPLAY_NAME
  const currentEmoji = profile?.avatar_emoji.trim() || DEFAULT_AVATAR_EMOJI

  // 아직 기본 이름 그대로면 첫 설정으로 봅니다. 그 외에는 프로필 수정 화면입니다.
  const isFirstRun = currentName === DEFAULT_DISPLAY_NAME

  // 쓰던 이모지가 큐레이션 목록에 없으면(예전 값, 직접 넣은 값) 맨 앞에 끼워
  // 넣습니다. 이게 없으면 저장 버튼을 누르는 순간 아바타가 조용히 바뀝니다.
  const choices = AVATAR_CHOICES.includes(currentEmoji)
    ? AVATAR_CHOICES
    : [currentEmoji, ...AVATAR_CHOICES]

  const errorCode = readErrorCode(params.error)
  const errorMessage = errorCode ? ERROR_MESSAGES[errorCode] : null
  const nameError = errorCode && NAME_ERROR_CODES.has(errorCode) ? errorMessage : null
  const formError = errorMessage && !nameError ? errorMessage : null

  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      <PageHeader
        title={isFirstRun ? '반가워요!' : '프로필 수정'}
        // 첫 설정에서는 돌아갈 곳이 없습니다. 수정하러 온 경우에만 뒤로가기.
        backHref={isFirstRun ? undefined : '/'}
        backLabel="오늘로 돌아가기"
        description={
          isFirstRun
            ? '친구들에게 보일 이름과 이모지를 정해 주세요. 나중에 언제든 바꿀 수 있어요.'
            : '이름과 이모지는 같은 그룹 친구들에게 보여요.'
        }
      />

      <Card>
        <form action={saveProfile} className="flex flex-col gap-5">
          {/* 프로필을 못 읽은 것과 아직 기본값인 것은 다른 상태입니다. 읽기가
              실패했다면 그렇다고 말해 줍니다. 저장 자체는 여전히 가능합니다. */}
          {profileError && (
            <ErrorText>
              지금 저장된 프로필을 불러오지 못했어요. 아래 값은 기본값이라, 저장하면
              이대로 덮어써집니다.
            </ErrorText>
          )}

          <ErrorText>{formError}</ErrorText>

          <Input
            id="display-name"
            name="display_name"
            type="text"
            label="이름"
            defaultValue={currentName}
            error={nameError}
            required
            // 브라우저가 세는 40 은 UTF-16 코드 유닛이라 이모지가 섞이면 DB 기준
            // 40자보다 짧게 잘립니다. 서버보다 엄격한 쪽이라 안전합니다.
            maxLength={40}
            autoComplete="nickname"
            enterKeyHint="done"
            placeholder="예: 지수"
            hint="1~40자. 친구들에게 이 이름으로 보여요."
          />

          <EmojiPicker choices={choices} current={currentEmoji} />

          <Button type="submit" variant="primary" pendingLabel="저장 중…">
            {isFirstRun ? '시작하기' : '저장하기'}
          </Button>
        </form>
      </Card>

      <Hint>
        {isFirstRun
          ? '저장하면 그룹 만들기로 이어져요. 이미 초대 코드를 받았다면 그 다음 화면에서 참여할 수 있어요.'
          : '저장하면 오늘 화면으로 돌아가요.'}
      </Hint>
    </main>
  )
}

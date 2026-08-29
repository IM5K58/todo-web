'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'

/**
 * /onboarding 의 유일한 쓰기 경로.
 *
 * `handle_new_user()` (0001_init.sql 10번 블록) 가 가입 시점에 이미 profiles 행을
 * '친구' / '🙂' / 'Asia/Seoul' 로 만들어 둡니다. 그래서 이 액션은 INSERT 가 아니라
 * UPDATE 입니다. 다만 그 트리거는 본문 전체가 EXCEPTION 핸들러로 감싸여 있어서
 * "계정은 있는데 프로필 행은 없는" 상태가 실제로 가능합니다. 그 경우에만
 * 0002_rls.sql 의 안전밸브(profiles_insert_self)로 한 번 INSERT 합니다.
 *
 * 이 파일에는 async 함수만 export 할 수 있습니다('use server' 파일 제약). 그래서
 * 이모지 후보 목록 같은 상수는 page.tsx 에만 두고, 여기서는 목록을 화이트리스트로
 * 검사하지 않습니다. 대신 DB CHECK 제약과 똑같은 규칙(길이)으로 검사합니다.
 * 목록을 양쪽에 복제하면 이모지를 하나 추가할 때마다 조용히 어긋납니다.
 */

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

/**
 * Postgres `char_length()` 는 문자(코드 포인트)를 셉니다. JS 의 `.length` 는
 * UTF-16 코드 유닛을 세기 때문에 '😀'.length 는 2 지만 DB 에서는 1 입니다.
 * 이 차이를 무시하면 이모지가 섞인 이름이 여기서는 통과하고 DB 에서 23514 로
 * 터지거나, 반대로 멀쩡한 이름이 여기서 거절됩니다. 제약과 같은 방식으로 셉니다.
 */
function charLength(value: string): number {
  return Array.from(value).length
}

/**
 * 오류 코드를 쿼리스트링에 담아 폼을 다시 그립니다.
 *
 * 사용자가 입력한 이름은 절대 URL 에 싣지 않습니다. 서버 로그와 리퍼러에 남을
 * 이유가 없고, 여기까지 오는 경우는 브라우저의 required / maxLength 를 우회했을
 * 때뿐이라 드뭅니다.
 */
function fail(code: string): never {
  redirect(`/onboarding?error=${code}`)
}

// ---------------------------------------------------------------------------
// 액션
// ---------------------------------------------------------------------------

/**
 * 표시 이름과 아바타 이모지를 auth.uid() 본인 행에 대해서만 저장합니다.
 *
 * 대상 사용자를 인자로 받지 않습니다. `.eq('id', userId)` 의 userId 는 검증된
 * JWT 에서만 나오고, profiles_update_self 정책이 서버에서 같은 조건을 한 번 더
 * 강제합니다. 폼으로 남의 id 를 보낼 방법 자체가 없습니다.
 */
export async function saveProfile(formData: FormData): Promise<void> {
  const rawName = formData.get('display_name')
  const rawEmoji = formData.get('avatar_emoji')

  // FormData 값은 string 아니면 File 입니다. File 은 여기서 이름이 아닙니다.
  const displayName = typeof rawName === 'string' ? rawName.trim() : ''
  const avatarEmoji = typeof rawEmoji === 'string' ? rawEmoji.trim() : ''

  // profiles_display_name_len_chk: char_length(btrim(display_name)) between 1 and 40
  const nameLength = charLength(displayName)
  if (nameLength < 1) fail('name_empty')
  if (nameLength > 40) fail('name_long')

  // profiles_avatar_emoji_len_chk: char_length(avatar_emoji) between 1 and 8
  // (btrim 이 없는 제약이라 저장 전에 우리가 직접 다듬어 둡니다)
  const emojiLength = charLength(avatarEmoji)
  if (emojiLength < 1 || emojiLength > 8) fail('emoji_invalid')

  // 이모지는 라디오 버튼으로만 고를 수 있으므로 정상 경로에서는 도달하지 않습니다.
  // 조작된 요청이 아바타 칸에 평범한 텍스트를 밀어 넣는 것만 막습니다.
  if (/[\sA-Za-z0-9]/.test(avatarEmoji)) fail('emoji_invalid')

  const supabase = await createClient()

  // getClaims() 는 JWT 서명을 검증합니다. getSession() 은 쿠키를 그대로 돌려줄
  // 뿐이라 인가 검사가 아닙니다.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub

  if (claimsError || !userId) {
    redirect('/login?next=%2Fonboarding')
  }

  // `.select('id')` 로 실제로 몇 행이 바뀌었는지 확인합니다. PostgREST 는 0행
  // UPDATE 도 성공으로 돌려주기 때문에, 이게 없으면 저장했다고 말한 뒤 아무것도
  // 바뀌지 않는 조용한 무동작이 생깁니다.
  // profiles 는 0003 이후 컬럼 단위 SELECT 권한이라 '*' 는 42501 입니다. id 만 고릅니다.
  const { data: updated, error: updateError } = await supabase
    .from('profiles')
    .update({ display_name: displayName, avatar_emoji: avatarEmoji })
    .eq('id', userId)
    .select('id')
    .maybeSingle()

  if (updateError) {
    fail(
      updateError.code === '23514'
        ? 'constraint'
        : updateError.code === '42501'
          ? 'forbidden'
          : 'save_failed',
    )
  }

  if (!updated) {
    // 프로필 행이 없는 계정. 0002 의 profiles_insert_self 안전밸브를 씁니다.
    // timezone 은 넘기지 않습니다. 컬럼 기본값 'Asia/Seoul' 이 맞고, 이 화면은
    // 시간대를 묻지 않습니다.
    const { error: insertError } = await supabase
      .from('profiles')
      .insert({ id: userId, display_name: displayName, avatar_emoji: avatarEmoji })

    if (insertError) {
      fail(insertError.code === '23514' ? 'constraint' : 'save_failed')
    }
  }

  // 홈 헤더가 display_name 을 그립니다. 라우터 캐시에 남은 이전 RSC 페이로드를
  // 비워 주지 않으면 저장 직후 옛 이름이 한 번 더 보입니다.
  revalidatePath('/', 'layout')

  // 그룹이 아직 없으면 홈의 빈 상태를 거치지 않고 곧장 그룹 만들기로 보냅니다.
  // 조회 형태는 app/page.tsx 와 같습니다(group_members 를 user_id 로 필터).
  const { data: memberships, error: membershipError } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)
    .limit(1)

  // 멤버십 조회가 실패했다면 "그룹이 없다"고 단정하지 않습니다. 홈으로 보내면
  // 홈이 같은 판단을 다시 하고, 거기서 실패해도 안내 화면이 나옵니다.
  const hasGroup = membershipError !== null || (memberships?.length ?? 0) > 0

  redirect(hasGroup ? '/' : '/groups/new')
}

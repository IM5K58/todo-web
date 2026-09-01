import Link from 'next/link'

import { Card, Hint, LinkButton } from '@/components/ui'
import { createClient } from '@/lib/supabase/server'

/**
 * 홈에 뜨는 "그룹 공약" 카드 (0009 ⑤).
 *
 * ---------------------------------------------------------------------------
 * 이 파일의 계약
 * ---------------------------------------------------------------------------
 * props 는 `{ groupId: string }` 하나뿐입니다. app/page.tsx 는 이미 "지금 보고
 * 있는 그룹"(?g= 또는 profiles.default_group_id 또는 첫 그룹)을 계산해 두고
 * 있고, 그 판정을 여기서 한 번 더 하면 두 화면이 서로 다른 그룹을 그릴 수
 * 있습니다. 그래서 이 컴포넌트는 그룹을 **고르지 않고 받기만** 합니다.
 *
 * Server Component 입니다. JS 를 한 줄도 보내지 않습니다 — 공약은 읽기 전용
 * 문단이고, 고치는 일은 /pledge 라우트가 합니다.
 *
 * ---------------------------------------------------------------------------
 * 무엇을 언제 그리는가 (0009 를 읽고 정한 것 — 기억이 아니라 SQL 이 근거)
 * ---------------------------------------------------------------------------
 *   공약 있음                    -> 본문 카드. 관리자면 "공약 고치기" 링크.
 *   공약 없음 + 관리자           -> "공약 정하기" 안내 카드.
 *   공약 없음 + 일반 멤버        -> **아무것도 그리지 않습니다**.
 *   0009 미배포                  -> **아무것도 그리지 않습니다**.
 *   그 밖의 읽기 실패            -> 못 불러왔다고 말합니다(빈 상태로 삼키지 않음).
 *
 * 일반 멤버에게 빈 카드를 보여 주지 않는 이유는 두 가지입니다. 홈에서 그가 할
 * 수 있는 일이 하나도 없고("공약 정하기" 버튼은 그에게 없습니다), 그 빈 카드는
 * 매일 보는 화면에서 영구히 사라지지 않는 소음이 됩니다.
 *
 * ★ 관리자가 아니면 편집 링크를 아예 렌더하지 않습니다 ★
 * set_group_pledge() 는 비관리자의 호출을 **예외 없이 조용히 무시**합니다
 * (0009 ⑤-d). 그러니 버튼을 보여 주면 "눌렀는데 아무 일도 안 일어난다" 가
 * 됩니다. 0009 의 주석이 직접 말하는 정상 경로가 바로 이것입니다:
 * "public.am_i_admin() 이 false 인 사용자에게 버튼 자체를 보여주지 않는 것".
 *
 * ---------------------------------------------------------------------------
 * 왜 lib/supabase/types.ts 를 쓰지 않고 좁은 캐스트를 쓰는가
 * ---------------------------------------------------------------------------
 * 0009/0010/0011 이 만든 것들은 아직 Database 타입에 없습니다. 타입이 붙은 채로
 * `.from('group_pledges')` / `.rpc('am_i_admin')` 을 부르면 **DB 에는 실재하는
 * 것 때문에 tsc 가 깨집니다.** app/me/actions.ts 가 set_avatar 에 쓴 것과 같은
 * 처방이고, 캐스트는 일부러 좁습니다 — 함수 이름 하나, 컬럼 하나. types.ts 에
 * 항목이 생기면 이 타입 선언들만 지우면 됩니다.
 */

/**
 * 0009 의 CHECK 상한 그대로:
 *   constraint group_pledges_body_len_chk
 *     check (char_length(btrim(body)) between 1 and 2000)
 * set_group_pledge() 도 2000자 초과를 22023 으로 거부합니다. 화면과 서버 액션이
 * 같은 숫자를 쓰도록 여기 한 곳에만 둡니다.
 */
export const PLEDGE_BODY_MAX = 2000

/**
 * Postgres `char_length()` 는 문자(코드 포인트)를 셉니다. JS 의 `.length` 는
 * UTF-16 코드 유닛을 세기 때문에 '😀'.length 는 2 지만 DB 에서는 1 입니다.
 * 이모지가 섞인 공약이 앱에서는 거절되고 DB 에서는 통과하는(또는 그 반대)
 * 어긋남을 막으려면 반드시 코드 포인트로 세야 합니다.
 * (app/me/actions.ts 의 charLength 와 같은 이유, 같은 구현입니다.)
 */
export function pledgeLength(value: string): number {
  return Array.from(value).length
}

/** 이 그룹의 공약을 고치러 가는 곳. 홈과 같은 `?g=` 규약을 씁니다. */
export function pledgeEditHref(groupId: string): string {
  return `/pledge?g=${encodeURIComponent(groupId)}`
}

// ---------------------------------------------------------------------------
// Supabase — 좁은 캐스트
// ---------------------------------------------------------------------------

type DbError = { code?: string | null; message?: string }

/** `select('body').eq('group_id', …).maybeSingle()` 딱 그 한 줄의 모양. */
type PledgeSelect = (table: 'group_pledges') => {
  select: (columns: 'body') => {
    eq: (
      column: 'group_id',
      value: string,
    ) => {
      maybeSingle: () => PromiseLike<{
        data: { body?: string | null } | null
        error: DbError | null
      }>
    }
  }
}

/** 인자 없음 = 남에 대해 물어볼 수 없습니다(0009 ③). 반환은 boolean. */
type AmIAdminRpc = (fn: 'am_i_admin') => PromiseLike<{
  data: boolean | null
  error: DbError | null
}>

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * "0009 가 아직 이 환경에 없다" 를 뜻하는 코드들.
 *
 * 이걸 일반 오류와 구분하는 이유: 마이그레이션 이전 배포에서 홈 화면 전체에
 * 빨간 오류 카드가 뜨는 것보다, 아직 없는 기능이 안 보이는 편이 정직합니다.
 * 반대로 그 밖의 실패(네트워크, 일시적 장애)는 반드시 말해야 합니다 —
 * lib/tasks.ts 규칙 4: 조회 실패를 빈 상태로 삼키지 않습니다.
 */
function isNotDeployed(error: DbError): boolean {
  const code = error.code ?? ''
  return (
    code === 'PGRST202' || // 함수가 PostgREST 스키마 캐시에 없음
    code === 'PGRST205' || // 테이블이 PostgREST 스키마 캐시에 없음
    code === '42883' || // undefined_function
    code === '42P01' // undefined_table
  )
}

export type PledgeRead =
  /** body 가 null 이면 "이 그룹에는 공약이 없다" 입니다(오류가 아닙니다). */
  | { state: 'ok'; body: string | null }
  /** 0009 미배포. 화면은 아무것도 그리지 않습니다. */
  | { state: 'undeployed' }
  | { state: 'error'; message: string }

/**
 * 이 그룹의 공약 본문.
 *
 * ★ 비멤버에게는 예외가 아니라 0행입니다 ★ group_pledges_select_member 정책이
 * `private.is_group_member(group_id)` 로 거르므로, 남의 그룹 id 를 넣어도
 * "공약 없음" 과 구분되지 않습니다. 그건 0009 의 의도입니다(규칙 8) — 여기서
 * 멤버십을 따로 확인해 그 차이를 되살리지 않습니다.
 */
export async function readGroupPledge(
  supabase: SupabaseServerClient,
  groupId: string,
): Promise<PledgeRead> {
  const from = supabase.from as unknown as PledgeSelect

  const { data, error } = await from('group_pledges')
    .select('body')
    .eq('group_id', groupId)
    .maybeSingle()

  if (error) {
    if (isNotDeployed(error)) return { state: 'undeployed' }
    console.error('[pledge] group_pledges 조회 실패', {
      code: error.code,
      message: error.message,
    })
    return { state: 'error', message: '공약을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' }
  }

  const body = typeof data?.body === 'string' ? data.body.trim() : ''
  return { state: 'ok', body: body.length > 0 ? body : null }
}

/**
 * public.am_i_admin() — "지금 로그인한 나" 가 관리자인가.
 *
 * ★ 실패하면 false 입니다 ★ 이 값이 정하는 것은 편집 UI 를 그릴지 말지뿐이고,
 * 진짜 강제는 set_group_pledge() 안의 private.is_app_admin() 입니다. 못 읽었을
 * 때 true 쪽으로 기울면 일반 멤버에게 "눌러도 아무 일 없는 버튼" 이 생깁니다 —
 * 이 화면이 피하려는 바로 그 고장입니다.
 */
export async function amIAppAdmin(supabase: SupabaseServerClient): Promise<boolean> {
  const rpc = supabase.rpc as unknown as AmIAdminRpc

  const { data, error } = await rpc('am_i_admin')

  if (error) {
    if (!isNotDeployed(error)) {
      console.error('[pledge] am_i_admin 호출 실패', {
        code: error.code,
        message: error.message,
      })
    }
    return false
  }

  return data === true
}

// ---------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------

/**
 * 홈에 마운트되는 공약 카드.
 *
 * @param groupId 지금 홈이 보여 주고 있는 그룹. 호출부(app/page.tsx)가 정합니다.
 */
export async function GroupPledge({ groupId }: { groupId: string }) {
  const supabase = await createClient()

  // 서로를 기다릴 이유가 없으므로 한 파(wave)에 묶습니다(lib/tasks.ts 규칙 5).
  const [pledge, isAdmin] = await Promise.all([
    readGroupPledge(supabase, groupId),
    amIAppAdmin(supabase),
  ])

  if (pledge.state === 'undeployed') return null

  if (pledge.state === 'error') {
    return (
      <Card title="그룹 공약">
        <Hint>{pledge.message}</Hint>
      </Card>
    )
  }

  const editHref = pledgeEditHref(groupId)

  if (pledge.body === null) {
    // 일반 멤버에게 빈 카드는 소음입니다 — 그가 여기서 할 수 있는 일이 없습니다.
    if (!isAdmin) return null

    return (
      <Card title="그룹 공약">
        <Hint>
          아직 이 그룹의 공약이 없어요. 다 같이 지킬 약속을 한 번 적어 두면 홈에서 매일
          보여요.
        </Hint>
        <LinkButton href={editHref} variant="secondary" size="sm" className="self-start">
          공약 정하기
        </LinkButton>
      </Card>
    )
  }

  return (
    <Card title="그룹 공약">
      {/*
        whitespace-pre-wrap: 공약은 줄바꿈이 의미를 갖는 문단입니다(0009 는 본문을
        2000자까지 허용합니다). keep-all 은 한국어가 단어 중간에서 끊기지 않게
        합니다 — components/ui.tsx 의 Hint 와 같은 처방입니다.
      */}
      <p className="text-fg text-sm leading-relaxed whitespace-pre-wrap [word-break:keep-all]">
        {pledge.body}
      </p>

      {isAdmin && (
        <Link
          href={editHref}
          className="text-muted inline-flex h-11 items-center self-start text-sm underline-offset-4 hover:underline"
        >
          공약 고치기
        </Link>
      )}
    </Card>
  )
}

export default GroupPledge

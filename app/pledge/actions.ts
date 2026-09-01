'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'

import { PLEDGE_BODY_MAX, pledgeLength, readGroupPledge } from '../group-pledge'

/**
 * /pledge 의 유일한 쓰기 경로 — public.set_group_pledge(uuid, text).
 *
 * ---------------------------------------------------------------------------
 * 왜 평범한 <form action={...}> 인가
 * ---------------------------------------------------------------------------
 * app/groups/manage-actions.ts 와 같은 판단입니다. 이 화면에는 브라우저에만
 * 존재하는 상태가 없습니다(텍스트 한 칸과 저장 버튼 하나). 그래서 페이지는
 * Server Component 로 두고, 결과는 `?ok=` / `?err=` 를 달고 같은 URL 로
 * 되돌아옵니다. 되돌아온 페이지가 group_pledges 를 **다시 읽어** 그리므로,
 * 화면에 보이는 문장은 언제나 DB 에 실제로 들어 있는 문장입니다.
 *
 * ---------------------------------------------------------------------------
 * ★ returns void 를 성공으로 읽으면 안 됩니다 ★
 * ---------------------------------------------------------------------------
 * set_group_pledge() 는 아래 경우에 **예외 없이 조용히 무시**합니다(0009 ⑤-d):
 *   · private.is_app_admin() 이 false
 *   · p_group_id 가 null
 *   · 내가 그 그룹의 멤버가 아님
 * 즉 `error === null` 은 "저장됐다" 가 아니라 "요청이 오류 없이 끝났다" 일
 * 뿐입니다. 그래서 이 액션은 RPC 뒤에 group_pledges 를 한 번 더 읽어, 방금 보낸
 * 값이 실제로 들어갔는지 **확인한 뒤에만** ok= 를 붙입니다. 확인하지 못했으면
 * 그렇다고 말합니다 — "저장했어요" 라고 거짓말하지 않습니다.
 *
 * 정상 경로에서는 여기까지 오지 않습니다. 관리자가 아니면 app/pledge/page.tsx
 * 가 폼 자체를 그리지 않기 때문입니다(0009 가 지정한 정상 경로).
 * 아래 'ignored' 는 그 사이에 관리자 자격이 사라졌거나, 화면을 우회해 이
 * 액션을 직접 부른 경우를 위한 정직한 보고입니다.
 *
 * ---------------------------------------------------------------------------
 * 빈 입력의 의미 — 0009 를 읽고 확인한 사실
 * ---------------------------------------------------------------------------
 * `v_body := nullif(btrim(coalesce(p_body,'')), '')` 이고, 그것이 NULL 이면
 * `delete from public.group_pledges where group_id = p_group_id` 입니다.
 * 즉 **빈 문자열/공백만 = 저장이 아니라 삭제**입니다. 없는 것을 지워도 0행이고
 * 그건 실패가 아니라 성공입니다(원하던 상태가 됐습니다).
 * 화면은 이 사실을 그대로 적습니다 — page.tsx 의 안내 문구 참고.
 *
 * 'use server' 파일은 async 함수만 export 할 수 있습니다. 아래 두 `type` 은
 * 컴파일 시점에 지워지므로 예외입니다(app/groups/manage-actions.ts 와 동일).
 */

// ---------------------------------------------------------------------------
// 결과 코드
// ---------------------------------------------------------------------------

/**
 * `?ok=` / `?err=` 로 실어 나르는 코드. 한국어 문장은 page.tsx 가 갖고 있습니다
 * ('use server' 모듈은 표를 export 할 수 없습니다). 여기에 코드를 하나 더하면
 * page.tsx 가 문구를 가질 때까지 tsc 가 깨집니다 — 그게 목적입니다.
 */
export type PledgeOkCode = 'saved' | 'deleted'

export type PledgeErrCode =
  /** 폼이 쓸 만한 uuid 를 싣고 오지 않았습니다. 사용자 잘못이 아니라 버그입니다. */
  | 'badrequest'
  /** 코드 포인트 기준 2000자 초과. 앱에서 먼저 걸렀거나 RPC 가 22023 을 냈습니다. */
  | 'toolong'
  /** 검증된 세션이 Postgres 까지 닿지 않았습니다(42501). */
  | 'auth'
  /** 0009 가 이 환경에 없습니다(PGRST202 / 42883). */
  | 'notdeployed'
  /** RPC 는 조용히 끝났지만 DB 에 반영되지 않았습니다 = 권한/멤버십이 없습니다. */
  | 'ignored'
  /** 저장 후 확인 조회가 실패했습니다. 성공이라고 말할 수 없습니다. */
  | 'unconfirmed'
  /** 그 밖의 실패. */
  | 'fail'

// ---------------------------------------------------------------------------
// 배관
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `returns void` 이므로 읽을 행이 없습니다 — error 만 봅니다.
 * 좁은 캐스트인 이유는 app/group-pledge.tsx 머리말과 같습니다(types.ts 미반영).
 */
type SetGroupPledgeRpc = (
  fn: 'set_group_pledge',
  args: { p_group_id: string; p_body: string | null },
) => PromiseLike<{ error: { code?: string | null; message?: string } | null }>

/**
 * `redirect()` 는 NEXT_REDIRECT 제어 흐름 예외를 던지므로 절대 try 안에 두지
 * 않습니다. 아래 액션은 항상 이 함수로 끝납니다.
 */
function back(groupId: string | null, query: string): never {
  const base = groupId ? `/pledge?g=${encodeURIComponent(groupId)}&` : '/pledge?'
  redirect(`${base}${query}`)
}

/** 라우터 캐시는 클라이언트에 있습니다. 홈 카드까지 함께 비워야 합니다. */
function refresh(): void {
  revalidatePath('/pledge')
  revalidatePath('/')
}

// ---------------------------------------------------------------------------
// 저장 / 삭제
// ---------------------------------------------------------------------------

/**
 * 그룹 공약 저장. 본문을 비우면 삭제입니다(0009 의 계약).
 *
 * 대상 그룹은 폼의 hidden 필드로 옵니다. 그걸 신뢰해도 되는 이유는 이 액션이
 * 권한을 스스로 판정하지 않기 때문입니다 — 판정은 전부 set_group_pledge() 안의
 * private.is_app_admin() + private.is_group_member() 가 하고, 둘 중 하나라도
 * 아니면 아무 일도 일어나지 않습니다. 그리고 아래 확인 조회는 RLS 가 걸린
 * 사용자 세션으로 하므로, 내가 볼 수 없는 그룹의 공약은 애초에 읽히지 않습니다.
 */
export async function savePledgeAction(formData: FormData): Promise<never> {
  const rawGroupId = formData.get('groupId')
  const groupId =
    typeof rawGroupId === 'string' && UUID_RE.test(rawGroupId.trim())
      ? rawGroupId.trim()
      : null

  if (!groupId) back(null, 'err=badrequest')

  const rawBody = formData.get('body')
  // 앞뒤 공백은 DB 가 어차피 btrim 합니다. 여기서 먼저 다듬어야 "확인 조회"의
  // 기대값과 저장된 값이 같은 모양이 됩니다.
  const body = typeof rawBody === 'string' ? rawBody.trim() : ''

  // 코드 포인트로 셉니다. JS 의 .length 로 세면 이모지가 섞인 공약이 여기서
  // 통과하고 RPC 에서 22023 으로 터지거나, 멀쩡한 공약이 여기서 거절됩니다.
  if (pledgeLength(body) > PLEDGE_BODY_MAX) back(groupId, 'err=toolong')

  const supabase = await createClient()
  const rpc = supabase.rpc.bind(supabase) as unknown as SetGroupPledgeRpc

  // 빈 문자열도 RPC 안에서 NULL 이 되지만, 의도를 값에서 읽을 수 있게 여기서
  // null 로 만들어 보냅니다(= "이 그룹의 공약을 지운다").
  const { error } = await rpc('set_group_pledge', {
    p_group_id: groupId,
    p_body: body.length > 0 ? body : null,
  })

  if (error) {
    const code = error.code ?? ''

    // 42501 은 set_group_pledge 가 "로그인이 필요합니다" 로 던지는 유일한 예외
    // 입니다. 비관리자에게는 예외를 던지지 않습니다(그건 조용한 무시입니다).
    if (code === '42501') back(groupId, 'err=auth')
    // 22023 = 2000자 초과. 관리자 인증을 통과한 뒤에만 도달합니다.
    if (code === '22023') back(groupId, 'err=toolong')
    // 0009 미배포. PostgREST 스키마 캐시에 함수가 없습니다.
    if (code === 'PGRST202' || code === '42883') back(groupId, 'err=notdeployed')

    console.error('[pledge] set_group_pledge rpc 실패', {
      code: error.code,
      message: error.message,
    })
    back(groupId, 'err=fail')
  }

  // ── 여기부터가 이 액션의 핵심입니다 ──────────────────────────────────────
  // RPC 가 오류 없이 끝났다는 사실만으로는 아무것도 알 수 없습니다(returns void
  // + 조용한 무시). 실제로 무엇이 저장됐는지 읽어서 확인합니다.
  const stored = await readGroupPledge(supabase, groupId)

  if (stored.state === 'undeployed') {
    refresh()
    back(groupId, 'err=notdeployed')
  }

  if (stored.state === 'error') {
    // 저장은 됐을 수도, 안 됐을 수도 있습니다. 모르면 모른다고 말합니다.
    refresh()
    back(groupId, 'err=unconfirmed')
  }

  const expected = body.length > 0 ? body : null

  if (stored.body !== expected) {
    // RPC 가 조용히 무시했습니다: 관리자가 아니거나, 그 그룹의 멤버가 아닙니다.
    // 정상 경로에서는 폼 자체가 안 보이므로 여기까지 오지 않습니다.
    refresh()
    back(groupId, 'err=ignored')
  }

  refresh()
  back(groupId, `ok=${expected === null ? 'deleted' : 'saved'}`)
}

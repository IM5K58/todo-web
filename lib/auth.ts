import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'

/**
 * 서버 화면의 로그인 가드 — "세션이 있으면 내 id, 없으면 /login".
 *
 * app/page.tsx · app/status/page.tsx · app/groups/page.tsx ·
 * app/templates/page.tsx · app/groups/new/page.tsx · app/groups/join/page.tsx
 * 이 글자 하나 다르지 않은 같은 여섯 줄을 들고 있었습니다. 판정도 리다이렉트
 * 목적지도 그대로 두고 정의만 하나로 모은 것입니다.
 *
 * ★ getClaims() 인 이유 ★ JWT 서명을 로컬에서 검증합니다(JWKS 는 auth-js 의
 * 모듈 전역에 캐시되므로 따뜻한 인스턴스에서는 네트워크가 나가지 않습니다).
 * getSession() 은 쿠키를 그대로 되돌려줄 뿐이라 인가 검사가 아닙니다.
 *
 * ★ 만든 클라이언트를 함께 돌려주는 이유 ★ 호출하는 화면 대부분이 가드 직후에
 * 같은 클라이언트로 profiles/groups 를 읽습니다. 돌려주지 않으면 요청마다
 * createClient() 가 한 번 더 돌게 됩니다(쿠키 스토어를 다시 읽습니다).
 * 클라이언트는 요청 하나에 하나여야 하므로 모듈 상수로 올리지 않습니다 —
 * lib/supabase/server.ts 머리말 참고.
 *
 * @param loginHref 세션이 없을 때 보낼 곳. 기본값 '/login'.
 *   ?next= 를 붙이는 화면은 붙인 채로 넘깁니다 — 로그인 뒤 돌아올 곳이 홈이
 *   아니라 그 화면이어야 하는 곳들이고(그룹 만들기·코드로 참여), 그 차이는
 *   의도된 것입니다. 이미 URL 인코딩된 문자열을 그대로 받습니다.
 */
export async function requireUserId(loginHref = '/login') {
  const supabase = await createClient()

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub

  if (claimsError || typeof userId !== 'string' || !userId) {
    redirect(loginHref)
  }

  return { supabase, userId }
}

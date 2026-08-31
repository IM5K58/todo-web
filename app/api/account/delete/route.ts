import 'server-only'

import { NextResponse } from 'next/server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/account/delete — 계정 탈퇴. 되돌릴 수 없습니다.
 *
 * ---------------------------------------------------------------------------
 * 왜 Server Action 이 아니라 Route Handler 인가
 * ---------------------------------------------------------------------------
 * 지우는 주체가 service_role 이기 때문입니다. `auth.admin.deleteUser()` 는
 * auth 스키마를 건드리는 관리자 API 라서 사용자 세션 클라이언트로는 절대
 * 호출할 수 없습니다. 그리고 lib/supabase/admin.ts 는 맨 위에
 * `import 'server-only'` 가 있어서, 이 모듈이 클라이언트 번들에 조금이라도
 * 섞이면 **빌드가 실패합니다**. Route Handler 는 정의상 서버에만 존재하므로
 * 그 경계가 파일 단위로 확실합니다.
 *
 * ★ 이 파일을 클라이언트 컴포넌트에서 import 하지 마세요 ★
 * fetch('/api/account/delete') 로만 부르세요. import 하는 순간 service_role
 * 키가 번들 그래프에 들어옵니다.
 *
 * ---------------------------------------------------------------------------
 * 단계 (작업 명세 + 0007 ⑥ 의 순서 요구)
 * ---------------------------------------------------------------------------
 *   1) 세션에서 사용자 확인. 인증 안 됐으면 401
 *   2) 요청 본문의 확인 문자열이 **서버가 읽은** 표시 이름과 일치하는지 재검증.
 *      클라이언트에서 버튼을 활성화하는 조건과 같은 규칙이지만, 그 검사는
 *      UI 편의일 뿐입니다. 여기가 진짜 관문입니다.
 *   3) Storage 의 avatars/<uid>/ 파일 삭제  ← ★ deleteUser 보다 먼저 ★
 *   4) createAdminClient() 로 auth.admin.deleteUser(userId)
 *   5) 세션 쿠키 정리 후 응답
 *
 * 3번이 4번보다 먼저인 이유는 0007 ⑥ 이 못 박아 둔 그대로입니다: Storage 객체는
 * auth.users 의 FK 로 지워지지 않고, avatars 는 **공개 버킷** 이라 남겨 두면
 * 탈퇴 후에도 사진 URL 이 영원히 유효합니다. 사용자를 먼저 지우면 그 uid 로
 * 정리할 기회가 사라져 고아 파일만 남습니다. 그래서 3번이 실패하면 4번을 하지
 * 않고 실패로 응답합니다 — 사용자가 다시 시도할 수 있어야 합니다.
 *
 * ---------------------------------------------------------------------------
 * 삭제가 실제로 지우는 것 (0001_init.sql / 0004_templates.sql 의 ON DELETE 절)
 * ---------------------------------------------------------------------------
 * auth.users 행이 사라지면 연쇄가 이렇게 흐릅니다. 화면의 확인 문구는 이
 * 목록을 그대로 옮겨 적은 것이고, 추측이 섞여 있지 않습니다:
 *
 *   profiles.id            → auth.users(id)   ON DELETE CASCADE   [프로필 삭제]
 *   ├ tasks.user_id        → profiles(id)     ON DELETE CASCADE   [할 일·기록 전부]
 *   ├ task_templates.user_id → profiles(id)   ON DELETE CASCADE   [반복 할 일]
 *   ├ group_members.user_id  → profiles(id)   ON DELETE CASCADE   [그룹 참여]
 *   ├ push_subscriptions.user_id → profiles(id) ON DELETE CASCADE [알림 구독]
 *   └ nudges.from_user_id / to_user_id → profiles(id) ON DELETE CASCADE
 *                                                          [주고받은 콕 찌르기]
 *
 * 남는 것:
 *   groups.created_by → profiles(id) ON DELETE **SET NULL**
 *     내가 만든 그룹은 살아남습니다. '만든 사람' 칸만 비워집니다.
 *     (0001 의 주석: "만든 사람이 탈퇴해도 그룹은 살아남습니다")
 *   다른 사람의 tasks / nudges 는 그대로입니다. 내 할 일을 가리키던 남의
 *   넛지는 nudges.task_id ON DELETE SET NULL 로 참조만 끊깁니다.
 *
 * 마지막 방장:
 *   private.ensure_group_has_owner() (0001 §6b) 는 group_members 의 DEFERRABLE
 *   INITIALLY DEFERRED constraint trigger 입니다. 유일한 소유자의 멤버십 행이
 *   캐스케이드로 사라지면 커밋 시점에 groups 행을 FOR UPDATE 로 잠그고
 *   `order by joined_at asc, user_id asc` 로 가장 오래된 남은 멤버를 'owner'
 *   로 승계시킵니다. **절대 예외를 던지지 않으므로 탈퇴를 막지 않습니다.**
 *   남은 멤버가 0명이면 그룹은 빈 채로 남습니다(자동 삭제 없음).
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 확인 문자열은 아무리 길어도 표시 이름(최대 40자)보다 길 수 없습니다.
 * 그보다 큰 본문은 읽지도 않고 거절합니다.
 */
const MAX_CONFIRM_LENGTH = 200

/** handle_new_user() 가 넣는 profiles.display_name 의 컬럼 DEFAULT. */
const DEFAULT_DISPLAY_NAME = '친구'

/** 0007 ⑤ 가 만드는 공개 버킷. 아바타 파일은 전부 여기 <uid>/ 아래에 있습니다. */
const AVATAR_BUCKET = 'avatars'

/** Storage list 의 한 페이지 크기. 아바타는 몇 개뿐이지만 페이징은 합니다. */
const LIST_PAGE_SIZE = 100

/**
 * 종료 보장용 상한. **상한에 닿는 것은 성공이 아니라 실패입니다.**
 *
 * 예전 이름은 MAX_LIST_PAGES 였고 주석은 "무한 루프 방지" 였지만, 실제 동작은
 * "5000개를 넘으면 조용히 포기하고 탈퇴를 계속 진행" 이었습니다. 그 순간
 * 0007 ⑥ 의 계약("Storage 정리가 실패하면 deleteUser 를 하지 말 것")이 깨집니다
 * — uid 를 아는 주체가 사라진 뒤라 남은 파일은 회수 수단이 없는 영구 고아가
 * 되고, 공개 버킷이므로 그 URL 은 탈퇴 뒤에도 계속 열립니다.
 */
const MAX_PURGE_ROUNDS = 50

interface DeleteBody {
  confirm?: unknown
  confirmName?: unknown
  confirm_name?: unknown
}

/**
 * 화면이 보여 주는 이름과 정확히 같은 규칙.
 *
 * app/me/page.tsx 의 `resolveDisplayName()` 과 한 글자도 다르면 안 됩니다.
 * 다르면 사용자는 화면에 적힌 이름을 그대로 입력했는데 서버가 거절하는,
 * 빠져나갈 길이 없는 막다른 골목에 갇힙니다.
 */
function resolveDisplayName(raw: string | null | undefined): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  return name.length > 0 ? name : DEFAULT_DISPLAY_NAME
}

/**
 * 표시 이름 비교용 정규화.
 *
 * ★ NFC 정규화가 반드시 필요합니다 ★ 한글은 같은 글자를 두 가지 방식으로
 * 표현할 수 있습니다. '한' 은 완성형 코드포인트 하나(NFC)일 수도 있고,
 * 자모 세 개(NFD)일 수도 있습니다. macOS 의 파일/입력 경로와 일부 IME 는
 * NFD 를 만들고, DB 에 저장된 값은 보통 NFC 입니다. 정규화 없이 `===` 로
 * 비교하면 **눈으로는 완전히 똑같은 글자인데** 영원히 불일치가 납니다.
 * 그 상태의 사용자는 탈퇴 버튼을 절대 누를 수 없습니다.
 *
 * 대소문자는 접지 않습니다. 표시 이름은 사용자가 정한 고유명이고, 여기서
 * 요구하는 것은 "자기 이름을 정확히 옮겨 적기" 이기 때문입니다. 다만 앞뒤
 * 공백은 자동완성/붙여넣기가 흔히 붙이는 잡음이라 양쪽 모두 잘라 냅니다.
 */
function normalizeForCompare(value: string): string {
  return value.normalize('NFC').trim()
}

/**
 * 값싼 CSRF 방어선. app/api/nudge/route.ts 와 완전히 같은 함수입니다.
 * 프록시 뒤에서는 request.url 이 내부 오리진을 들고 있어서 실제 요청을 전부
 * 거절하므로, 기대 호스트는 forwarded/Host 헤더에서 읽습니다.
 *
 * ★ nudge 와 여기서 한 가지가 다릅니다 ★ Origin 헤더가 **없는** 요청을
 * app/api/nudge/route.ts 는 통과시키지만 여기서는 거절합니다. 이 라우트는
 * 되돌릴 수 없는 삭제를 하므로, 출처를 말하지 않는 요청을 믿을 이유가 없습니다.
 *
 * 정상 클라이언트는 영향을 받지 않습니다: 브라우저의 fetch/XHR 는 POST 에 항상
 * Origin 을 붙입니다(같은 오리진이어도). 유일한 호출부인 app/me/page.tsx 의
 * `fetch('/api/account/delete', { method: 'POST', ... })` 도 마찬가지입니다.
 * Origin 이 없는 것은 브라우저 밖(curl·스크립트)에서 온 요청이고, 그런 요청까지
 * 받아 줄 이유가 없는 창구입니다.
 */
function crossOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  // 예전에는 false(통과)였습니다. 삭제 라우트는 출처 불명을 신뢰하지 않습니다.
  if (!origin) return true

  const expected =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    (() => {
      try {
        return new URL(request.url).host
      } catch {
        return null
      }
    })()

  if (!expected) return true

  try {
    return new URL(origin).host !== expected
  } catch {
    return true
  }
}

function readConfirm(body: DeleteBody): string | null {
  for (const candidate of [body.confirm, body.confirmName, body.confirm_name]) {
    if (typeof candidate !== 'string') continue
    // 표시 이름은 최대 40자입니다. 그보다 훨씬 긴 값은 자릅니다 — 버리고
    // null 을 돌려주면 "이름을 입력해 주세요" 라는 틀린 안내가 나가고,
    // 자르면 아래 비교에서 반드시 어긋나 "이름이 달라요" 라는 맞는 안내가
    // 나갑니다. 어느 쪽이든 통과하지 못하는 것은 같습니다.
    return candidate.slice(0, MAX_CONFIRM_LENGTH)
  }
  return null
}

/**
 * avatars/<uid>/ 아래의 모든 객체를 지웁니다. service_role 로 부릅니다.
 *
 * 왜 사용자 세션이 아니라 service_role 인가: 정책(0007 ⑤)상 본인 폴더는 사용자도
 * 지울 수 있지만, 그러면 "삭제는 브라우저, 계정 삭제는 서버" 로 갈라져 브라우저가
 * 중간에 끊기면 파일만 사라지고 계정은 남습니다. 한 요청 안에서 순서를 지키는
 * 편이 낫습니다.
 *
 * 반환값이 곧 성공 여부입니다. `list` 가 0건을 돌려주는 것은 오류가 아닙니다 —
 * 사진을 올린 적이 없거나 avatar_url 이 구글 사진(lh3) 인 계정이 그렇습니다.
 *
 * ★ "다 지울 때까지 반복, 다 못 지우면 실패" ★ 페이지를 훑어 모으는 대신
 * 지우면서 다시 읽습니다(그래서 offset 은 항상 0 입니다). 상한에 닿으면 조용히
 * 통과시키지 않고 **실패로 돌려보내** 사용자가 다시 시도하게 합니다. 여기서
 * ok:true 를 돌려주면 그다음 줄이 deleteUser 이고, 그 뒤에는 남은 파일을 찾을
 * 방법이 없습니다.
 */
async function purgeAvatarFiles(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<{ ok: true; removed: number } | { ok: false; message: string }> {
  const storage = admin.storage.from(AVATAR_BUCKET)
  let removed = 0

  for (let round = 0; round < MAX_PURGE_ROUNDS; round += 1) {
    const { data, error } = await storage.list(userId, {
      limit: LIST_PAGE_SIZE,
      // 방금 지운 만큼 앞이 비므로 늘 처음부터 읽습니다. offset 을 전진시키면
      // 삭제로 당겨진 뒷부분을 건너뛰게 됩니다.
      offset: 0,
    })

    if (error) {
      console.error('[account/delete] avatar list failed', {
        bucket: AVATAR_BUCKET,
        folder: `${AVATAR_BUCKET}/${userId}`,
        message: error.message,
      })
      return { ok: false, message: error.message }
    }

    const paths: string[] = []
    for (const entry of data ?? []) {
      // 정책이 깊이 1 을 강제하므로 여기 있는 것은 전부 파일입니다. 그래도
      // 이름이 비어 있으면 건너뜁니다 — 빈 이름을 remove 에 넘기면 폴더 전체를
      // 가리키는 경로가 되어 의미가 달라집니다.
      const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
      if (name) paths.push(`${userId}/${name}`)
    }

    // 폴더가 비었습니다. 정리 완료.
    if (paths.length === 0) return { ok: true, removed }

    const { error: removeError } = await storage.remove(paths)

    if (removeError) {
      console.error('[account/delete] avatar remove failed', {
        count: paths.length,
        paths,
        message: removeError.message,
      })
      return { ok: false, message: removeError.message }
    }

    removed += paths.length
  }

  // 상한까지 돌았는데도 폴더가 비지 않았습니다. 계정을 지우지 않고 실패합니다.
  console.error('[account/delete] avatar purge did not finish within the round cap', {
    folder: `${AVATAR_BUCKET}/${userId}`,
    rounds: MAX_PURGE_ROUNDS,
    removed,
  })
  return {
    ok: false,
    message: `avatars/${userId} 정리가 ${MAX_PURGE_ROUNDS}회 안에 끝나지 않았습니다.`,
  }
}

export async function POST(request: Request) {
  if (crossOrigin(request)) {
    return NextResponse.json({ error: '잘못된 요청입니다.' }, { status: 403 })
  }

  const supabase = await createClient()

  // ---- 1) 세션 확인 -------------------------------------------------------
  // getClaims() 는 JWT 서명을 로컬에서 검증합니다. getSession() 은 쿠키를
  // 그대로 돌려줄 뿐이라 인가 검사가 아닙니다 — 되돌릴 수 없는 삭제를 그런
  // 값에 걸어 둘 수는 없습니다.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub

  if (claimsError || typeof userId !== 'string' || !userId) {
    return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 })
  }

  let body: DeleteBody
  try {
    body = (await request.json()) as DeleteBody
  } catch {
    return NextResponse.json({ error: '잘못된 요청 형식입니다.' }, { status: 400 })
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: '잘못된 요청 형식입니다.' }, { status: 400 })
  }

  const confirm = readConfirm(body)
  if (confirm === null) {
    return NextResponse.json(
      { error: '확인을 위해 이름을 입력해 주세요.' },
      { status: 400 },
    )
  }

  // ---- 2) 이름 서버 재검증 -------------------------------------------------
  // 사용자 자신의 세션 클라이언트로 읽습니다. profiles_select_self_or_groupmate
  // 정책이 걸려 있으므로 본인 행이 맞는지는 RLS 가 한 번 더 보증합니다.
  // profiles 는 0003 이후 컬럼 단위 SELECT 권한이라 '*' 는 42501 입니다.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', userId)
    .maybeSingle()

  if (profileError) {
    console.error('[account/delete] profile lookup failed', {
      code: profileError.code,
      message: profileError.message,
    })
    return NextResponse.json(
      { error: '계정 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' },
      { status: 500 },
    )
  }

  // 프로필 행이 없는 계정도 실제로 존재합니다 — handle_new_user() 가 실패를
  // 삼키고 가입을 통과시키기 때문입니다. 그 경우 화면도 '친구' 를 보여 주므로
  // 여기서도 같은 폴백을 씁니다. 탈퇴는 여전히 가능해야 합니다.
  const expectedName = resolveDisplayName(profile?.display_name)

  if (normalizeForCompare(confirm) !== normalizeForCompare(expectedName)) {
    // 정답을 응답에 담지 않습니다. 화면에 이미 적혀 있고, 여기서 되돌려 주면
    // 세션만 있으면 이름을 캐낼 수 있는 조회 창구가 하나 더 생깁니다.
    return NextResponse.json(
      { error: '입력한 이름이 달라요. 화면에 보이는 이름을 그대로 입력해 주세요.' },
      { status: 400 },
    )
  }

  const admin = createAdminClient()

  // ---- 3) Storage 정리 (deleteUser 보다 먼저) ------------------------------
  // 0007 ⑥: storage.objects 는 auth.users 캐스케이드에 딸려오지 않습니다.
  // 공개 버킷이므로 여기서 안 지우면 탈퇴 후에도 사진 URL 이 계속 유효합니다.
  // 실패하면 계정을 지우지 않고 그대로 돌려보냅니다 — 다시 누르면 같은 지점부터
  // 재시도되고, 실패한 채로 사용자를 지워 버리면 정리할 방법이 영영 없습니다.
  const purge = await purgeAvatarFiles(admin, userId)

  if (!purge.ok) {
    return NextResponse.json(
      {
        error:
          '프로필 사진을 정리하지 못해 탈퇴를 멈췄어요. 잠시 후 다시 시도해 주세요.',
      },
      { status: 502 },
    )
  }

  // ---- 4) service_role 로 삭제 --------------------------------------------
  // 여기부터는 되돌릴 수 없습니다. deleteUser 의 두 번째 인자(shouldSoftDelete)
  // 는 기본 false 이고, 그대로 둡니다. soft delete 는 auth.users 행을 남기므로
  // profiles 로 가는 ON DELETE CASCADE 가 **하나도 돌지 않습니다** — 사용자는
  // 지웠다고 들었는데 할 일도 기록도 그대로 남습니다.
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId)

  if (deleteError) {
    console.error('[account/delete] deleteUser failed', {
      status: deleteError.status,
      message: deleteError.message,
    })
    return NextResponse.json(
      { error: '탈퇴 처리에 실패했어요. 잠시 후 다시 시도해 주세요.' },
      { status: 502 },
    )
  }

  // ---- 5) 세션 정리 -------------------------------------------------------
  // scope: 'local' 로 부릅니다. 기본값(global)은 Auth 서버로 나가서 이제는
  // 존재하지 않는 사용자의 세션을 폐기하려 하고, 그 실패가 쿠키 삭제까지
  // 건너뛰게 만들 수 있습니다. 지우려는 것은 이 브라우저의 쿠키뿐이고,
  // 사용자 행이 사라진 순간 서버 세션은 이미 무효입니다.
  //
  // Route Handler 의 cookies() 는 쓰기가 가능하므로 lib/supabase/server.ts 의
  // setAll() 이 여기서는 실제로 쿠키를 지웁니다(Server Component 에서는 그
  // 호출이 조용히 무시됩니다).
  const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' })

  if (signOutError) {
    // 계정은 이미 지워졌습니다. 쿠키 정리에 실패했다고 실패로 보고하면
    // 사용자는 다시 누를 것이고, 두 번째 시도는 401 을 받습니다. 그건 거짓말에
    // 가깝습니다. 대신 그 사실을 응답에 담아 클라이언트가 로컬 정리를 한 번 더
    // 하게 합니다.
    console.error('[account/delete] local signOut failed', signOutError.message)
  }

  // Clear-Site-Data 는 위 signOut 의 안전망입니다.
  //
  // 막으려는 상황: deleteUser 는 이미 성공했는데 응답이 도착하기 전에 연결이
  // 끊기거나 쿠키 정리가 실패하는 경우. 남은 access token 은 **서명이 여전히
  // 유효**해서 getClaims() 를 통과하므로, 사용자는 계정이 사라진 채로 최대
  // 토큰 만료(기본 1시간)까지 로그인된 것처럼 보이는 유령 세션에 갇힙니다.
  // (refresh token 은 캐스케이드로 지워져 갱신은 실패하고, RLS 의 auth.uid()
  // 가 없는 사용자라 데이터는 전부 빈 결과입니다 — 보안 구멍이 아니라 UX 결함
  // 입니다.)
  //
  // "storage" 까지 지우는 이유: 오프라인 조회용 캐시에 이 계정의 할 일이 남아
  // 있습니다. 계정을 지웠다고 말한 뒤 그 화면이 캐시에서 되살아나면 안 됩니다.
  // 서비스워커는 다음 방문에 다시 등록됩니다.
  //
  // 이건 최선노력입니다(보안 컨텍스트에서만 동작하고 브라우저 지원도 제각각).
  // 그래서 위의 signOut 을 대체하지 않고 덧댑니다.
  return NextResponse.json(
    {
      ok: true,
      sessionCleared: !signOutError,
      avatarFilesRemoved: purge.removed,
    },
    { headers: { 'Clear-Site-Data': '"cookies", "storage"' } },
  )
}

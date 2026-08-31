import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FunctionArgs, FunctionReturns } from '@/lib/supabase/types'

/**
 * tests/push-status.test.ts — lib/push-status.ts 의 변환 계층과 실패 계약.
 *
 * ---------------------------------------------------------------------------
 * 이 파일이 지키는 것은 결국 하나입니다: **모른다고 거짓말하지 않기**
 * ---------------------------------------------------------------------------
 * 알림 켬/끔은 /status 의 **보조 표시**입니다. 진행률도 멤버 목록도 콕 찌르기도
 * 이것 없이 멀쩡히 돕니다. 그래서 이 모듈이 잘못될 수 있는 방식은 딱 두 가지고,
 * 둘 다 조용합니다.
 *
 *   1. 던진다 → 배지 하나 때문에 /status 전체가 오류 화면이 됩니다.
 *      (Server Component 안에서 던지면 그 페이지는 렌더되지 않습니다.)
 *   2. 모르는 것을 "꺼짐" 으로 단정한다 → RPC 가 한 번 실패한 날, 알림을 잘
 *      켜 둔 사람 전원에게 "알림 꺼둠" 이 붙습니다. 사용자는 원인을 알 수
 *      없고, 우리도 로그를 보기 전엔 모릅니다.
 *
 * 그래서 아래 테스트의 절반은 "빈 Map 인가" 가 아니라 **"빈 Map 과 전원 false
 * 를 구분하는가"** 를 봅니다. 그 둘은 같은 화면을 만들면 안 됩니다.
 *
 *   · 키 없음  = 모르겠음      → 화면에 아무 표시도 붙이지 않는다
 *   · false    = 확실히 안 켰음 → "알림 꺼둠" 을 붙여도 되는 유일한 경우
 *
 * ── 모킹 방침 ─────────────────────────────────────────────────────────────
 * getGroupPushStatus 는 createClient() 를 잡으므로 순수 함수가 아닙니다. 다만
 * 잡는 지점이 `@/lib/supabase/server` 의 export **하나**뿐이라, 그 모듈만
 * 갈아끼우면 나머지(응답 → Map 변환, 오류 → 문자열, 예외 삼키기)는 전부
 * 진짜 코드가 돕니다. Supabase 클라이언트 전체를 흉내 내지 않습니다 —
 * 여기서 쓰는 표면은 `rpc(name, args)` 한 개입니다.
 *
 * vi.fn() 을 쓰지 않고 손으로 만든 대역을 씁니다. vitest.config.mts 가
 * `restoreMocks: true` 라서 vi.fn 의 구현이 테스트 사이에 초기화되는데,
 * 그러면 "구현을 언제 심었나" 가 테스트의 일부가 되어 버립니다.
 * ─────────────────────────────────────────────────────────────────────────
 */

/* ==========================================================================
 * Supabase 서버 클라이언트 대역
 *
 * vi.mock 의 팩토리는 import 위로 끌어올려지므로, 공유 상태는 vi.hoisted 로
 * 같이 끌어올립니다.
 * ======================================================================== */

const seam = vi.hoisted(() => {
  const rpcCalls: Array<{ fn: string; args: unknown }> = []
  const box = {
    /** rpc() 가 돌려줄(또는 던질) 것. 테스트마다 갈아끼웁니다. */
    respond: (_fn: string, _args: unknown): unknown => ({ data: [], error: null }),
    /** createClient() 자체가 실패하는 환경(쿠키 없음 등)을 흉내 낼 때 true. */
    clientFails: false,
  }
  return { rpcCalls, box }
})

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    if (seam.box.clientFails) {
      throw new Error('cookies() 를 사용할 수 없습니다')
    }
    return {
      rpc: (fn: string, args: unknown) => {
        seam.rpcCalls.push({ fn, args })
        return seam.box.respond(fn, args)
      },
    }
  },
}))

// ★ import 는 vi.mock 아래에 두어도 hoisting 덕에 대역이 먼저 걸립니다. ★
const { getGroupPushStatus, isPushOff } = await import('@/lib/push-status')
type PushStatusMap = Awaited<ReturnType<typeof getGroupPushStatus>>['statuses']

/* ==========================================================================
 * 픽스처 헬퍼
 * ======================================================================== */

/** 실제 uuid 모양. 자리표시자 문자열을 쓰면 "id 처럼 생긴 값" 이 아니게 됩니다. */
const MINSU = '11111111-1111-4111-8111-111111111111'
const JIHO = '22222222-2222-4222-8222-222222222222'
const SORA = '33333333-3333-4333-8333-333333333333'
const GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/** rpc 가 이 응답을 돌려주게 합니다. */
function replyWith(data: unknown, error: unknown = null): void {
  seam.box.respond = () => ({ data, error })
}

/** rpc 가 동기적으로 던지게 합니다 (클라이언트 내부 오류). */
function replyThrowing(err: unknown): void {
  seam.box.respond = () => {
    throw err
  }
}

/** rpc 가 거부된 프라미스를 돌려주게 합니다 (네트워크 단절). */
function replyRejecting(err: unknown): void {
  seam.box.respond = () => Promise.reject(err)
}

/** PostgrestError 모양. toKoreanDbError 는 code 만 봅니다. */
function pgError(code: string, message = '실패') {
  return { code, message, details: '', hint: '', name: 'PostgrestError' }
}

beforeEach(() => {
  seam.rpcCalls.length = 0
  seam.box.respond = () => ({ data: [], error: null })
  seam.box.clientFails = false
})

/* ==========================================================================
 * 1. 정상 응답 → Map
 *
 * RETURNS TABLE 이므로 PostgREST 는 **배열**을 줍니다. data[0] 을 보는 실수를
 * 하면 첫 사람 것만 반영되고 나머지는 조용히 "모름" 이 됩니다.
 * ======================================================================== */

describe('getGroupPushStatus — 정상 응답을 Map 으로 접는다', () => {
  it('빈 배열이면 빈 Map + error null (그룹에 아무도 없거나 비멤버)', async () => {
    replyWith([])

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(statuses).toBeInstanceOf(Map)
    expect(statuses.size).toBe(0)
    expect(error).toBeNull()
  })

  it('여러 행을 user_id 키로 전부 담는다 — 첫 행만 보지 않는다', async () => {
    replyWith([
      { user_id: MINSU, has_push: true },
      { user_id: JIHO, has_push: false },
      { user_id: SORA, has_push: true },
    ])

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(error).toBeNull()
    expect(statuses.size).toBe(3)
    expect(statuses.get(MINSU)).toBe(true)
    expect(statuses.get(JIHO)).toBe(false)
    expect(statuses.get(SORA)).toBe(true)
  })

  it('★ 전원 false 는 빈 Map 이 아니다 — "다 껐다" 와 "모르겠다" 는 다른 화면이다 ★', async () => {
    replyWith([
      { user_id: MINSU, has_push: false },
      { user_id: JIHO, has_push: false },
    ])

    const { statuses } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(2)
    expect([...statuses.values()]).toEqual([false, false])
    // 이 둘은 "확실히 안 켰음" 이므로 배지가 붙어야 합니다.
    expect(isPushOff(statuses, MINSU)).toBe(true)
    expect(isPushOff(statuses, JIHO)).toBe(true)
  })

  it('전원 true 도 그대로 담긴다 (아무에게도 배지가 붙지 않는다)', async () => {
    replyWith([
      { user_id: MINSU, has_push: true },
      { user_id: JIHO, has_push: true },
    ])

    const { statuses } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(2)
    expect(isPushOff(statuses, MINSU)).toBe(false)
    expect(isPushOff(statuses, JIHO)).toBe(false)
  })

  it('한 명짜리 그룹도 배열로 온다 — 객체 하나로 오지 않는다', async () => {
    replyWith([{ user_id: MINSU, has_push: true }])

    const { statuses } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(1)
    expect(statuses.get(MINSU)).toBe(true)
  })

  it('같은 user_id 가 두 번 오면 마지막 값이 이긴다 (0006 은 멤버당 1행이지만 계약을 못 박는다)', async () => {
    replyWith([
      { user_id: MINSU, has_push: false },
      { user_id: MINSU, has_push: true },
    ])

    const { statuses } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(1)
    expect(statuses.get(MINSU)).toBe(true)
  })

  it('응답에 없던 사람은 키가 생기지 않는다 — 조회 대상 밖은 "모름" 이다', async () => {
    replyWith([{ user_id: MINSU, has_push: true }])

    const { statuses } = await getGroupPushStatus(GROUP)

    expect(statuses.has(JIHO)).toBe(false)
    expect(statuses.get(JIHO)).toBeUndefined()
  })
})

/* ==========================================================================
 * 2. 예상 밖의 응답 형태
 *
 * 여기서 던지면 /status 가 통째로 죽습니다. 그리고 truthy 판정으로 대충
 * 통과시키면 'false' 같은 문자열이 true 로 둔갑합니다 — 구현이 typeof 로
 * 좁히는 이유입니다.
 * ======================================================================== */

describe('getGroupPushStatus — 예상 밖 형태에도 죽지 않고, 믿지도 않는다', () => {
  it('data 가 null 이면 빈 Map + error null', async () => {
    replyWith(null)

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(0)
    expect(error).toBeNull()
  })

  it('data 가 undefined 여도 빈 Map + error null', async () => {
    replyWith(undefined)

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(0)
    expect(error).toBeNull()
  })

  it('행이 null / undefined 여도 던지지 않고 건너뛴다', async () => {
    replyWith([null, { user_id: MINSU, has_push: true }, undefined])

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(error).toBeNull()
    expect(statuses.size).toBe(1)
    expect(statuses.get(MINSU)).toBe(true)
  })

  it('user_id 가 없는 행은 건너뛴다', async () => {
    replyWith([{ has_push: true }, { user_id: MINSU, has_push: false }])

    const { statuses } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(1)
    expect(statuses.get(MINSU)).toBe(false)
  })

  it('has_push 가 없는 행은 건너뛴다 — 없다고 false 로 채우지 않는다', async () => {
    replyWith([{ user_id: MINSU }, { user_id: JIHO, has_push: true }])

    const { statuses } = await getGroupPushStatus(GROUP)

    expect(statuses.has(MINSU)).toBe(false)
    expect(statuses.get(JIHO)).toBe(true)
  })

  it('★ 문자열 "false" 를 true 로 만들지 않는다 — truthy 판정이면 여기서 뒤집힌다 ★', async () => {
    replyWith([{ user_id: MINSU, has_push: 'false' }])

    const { statuses } = await getGroupPushStatus(GROUP)

    // 불리언이 아니므로 아예 담지 않습니다. 담았다면 'false' 는 truthy 라
    // "알림 켜둠" 이 되었을 것입니다.
    expect(statuses.has(MINSU)).toBe(false)
    expect(isPushOff(statuses, MINSU)).toBe(false)
  })

  it('숫자 0 / 1 도 불리언이 아니므로 담지 않는다', async () => {
    replyWith([
      { user_id: MINSU, has_push: 1 },
      { user_id: JIHO, has_push: 0 },
    ])

    const { statuses } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(0)
  })

  it('has_push 가 null 이면 담지 않는다 (null 은 "모름" 이지 "꺼짐" 이 아니다)', async () => {
    replyWith([{ user_id: MINSU, has_push: null }])

    const { statuses } = await getGroupPushStatus(GROUP)

    expect(statuses.has(MINSU)).toBe(false)
    expect(isPushOff(statuses, MINSU)).toBe(false)
  })

  it('user_id 가 문자열이 아니면 담지 않는다', async () => {
    replyWith([
      { user_id: 42, has_push: true },
      { user_id: null, has_push: false },
      { user_id: { id: MINSU }, has_push: true },
    ])

    const { statuses } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(0)
  })

  it('망가진 행이 섞여 있어도 멀쩡한 행은 살아남는다', async () => {
    replyWith([
      null,
      { user_id: MINSU, has_push: true },
      { has_push: false },
      { user_id: JIHO, has_push: 'nope' },
      { user_id: SORA, has_push: false },
    ])

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(error).toBeNull()
    expect(statuses.size).toBe(2)
    expect(statuses.get(MINSU)).toBe(true)
    expect(statuses.get(SORA)).toBe(false)
    expect(statuses.has(JIHO)).toBe(false)
  })

  it('data 가 배열이 아닌 객체여도 던지지 않는다 (순회 불가 → 빈 Map + error)', async () => {
    replyWith({ user_id: MINSU, has_push: true })

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(statuses).toBeInstanceOf(Map)
    expect(statuses.size).toBe(0)
    // 실패를 조용히 삼키지는 않습니다 — 로그로는 남아야 합니다.
    expect(error).toBe('알림 설정 여부를 불러오지 못했습니다.')
  })

  it('data 가 문자열이어도 던지지 않는다', async () => {
    replyWith('unexpected')

    await expect(getGroupPushStatus(GROUP)).resolves.toMatchObject({ statuses: new Map() })
  })

  it('rpc 가 { data, error } 모양이 아니어도 던지지 않는다', async () => {
    seam.box.respond = () => ({ unexpected: true })

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(0)
    expect(error).toBeNull() // error 필드가 undefined → 오류 아님, data 도 undefined → 빈 Map
  })
})

/* ==========================================================================
 * 3. 실패 경로 — ★ 절대 throw 하지 않는다 ★
 *
 * 이 모듈이 던지면 /status 의 서버 렌더가 통째로 실패합니다. 알림 배지 하나
 * 때문에 진행률도 콕 찌르기도 같이 사라지는 건 명백한 손해입니다.
 * ======================================================================== */

describe('getGroupPushStatus — 실패해도 던지지 않고 빈 Map + error 를 돌려준다', () => {
  it('PostgrestError 가 오면 빈 Map + 한국어 문자열', async () => {
    replyWith(null, pgError('42501'))

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(statuses).toBeInstanceOf(Map)
    expect(statuses.size).toBe(0)
    expect(error).toBe('권한이 없습니다. 다시 로그인해 주세요.')
  })

  it('★ 0006 미배포(PGRST202)도 정상적으로 견딘다 — 마이그레이션 전에도 화면은 뜬다 ★', async () => {
    replyWith(null, pgError('PGRST202'))

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(0)
    expect(error).toBe('서버 함수를 찾을 수 없습니다. 잠시 후 다시 시도해 주세요.')
  })

  it('모르는 오류 코드는 fallback + 코드가 함께 남는다 (디버깅용)', async () => {
    replyWith(null, pgError('XX000'))

    const { error } = await getGroupPushStatus(GROUP)

    expect(error).toBe('알림 설정 여부를 불러오지 못했습니다. (XX000)')
  })

  it('오류와 함께 data 가 와도 그 data 를 쓰지 않는다', async () => {
    replyWith([{ user_id: MINSU, has_push: true }], pgError('42501'))

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(0)
    expect(error).not.toBeNull()
  })

  it('rpc 가 거부되면(네트워크 단절) 빈 Map + error, 던지지 않는다', async () => {
    replyRejecting(new TypeError('fetch failed'))

    await expect(getGroupPushStatus(GROUP)).resolves.toEqual({
      statuses: new Map(),
      error: '알림 설정 여부를 불러오지 못했습니다.',
    })
  })

  it('rpc 가 동기적으로 던져도 잡는다', async () => {
    replyThrowing(new Error('boom'))

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(0)
    expect(error).toBe('알림 설정 여부를 불러오지 못했습니다.')
  })

  it('createClient() 자체가 던져도 잡는다 (쿠키 없는 컨텍스트)', async () => {
    seam.box.clientFails = true

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(statuses.size).toBe(0)
    expect(error).toBe('알림 설정 여부를 불러오지 못했습니다.')
    expect(seam.rpcCalls).toHaveLength(0)
  })

  it('Error 가 아닌 것을 던져도 잡는다', async () => {
    replyThrowing('문자열을 던지는 라이브러리도 있습니다')

    await expect(getGroupPushStatus(GROUP)).resolves.toMatchObject({
      error: '알림 설정 여부를 불러오지 못했습니다.',
    })
  })

  it('★ 어떤 실패에서도 statuses 는 항상 Map 이다 — null 이나 undefined 가 아니다 ★', async () => {
    const failures: Array<() => void> = [
      () => replyWith(null, pgError('42501')),
      () => replyWith(null, pgError('PGRST202')),
      () => replyThrowing(new Error('boom')),
      () => replyRejecting(new Error('offline')),
      () => replyWith({ not: 'an array' }),
      () => {
        seam.box.clientFails = true
      },
    ]

    for (const setup of failures) {
      seam.box.clientFails = false
      setup()
      const { statuses } = await getGroupPushStatus(GROUP)
      expect(statuses).toBeInstanceOf(Map)
      expect(statuses.size).toBe(0)
    }
  })

  it('★ 실패한 조회 결과로는 아무에게도 "알림 꺼둠" 이 붙지 않는다 ★', async () => {
    replyWith(null, pgError('42501'))

    const { statuses } = await getGroupPushStatus(GROUP)

    // 조회가 실패한 날 전원에게 틀린 배지를 붙이는 것이 이 기능 최악의 고장입니다.
    for (const id of [MINSU, JIHO, SORA]) {
      expect(isPushOff(statuses, id)).toBe(false)
    }
  })
})

/* ==========================================================================
 * 4. RPC 호출 규약 — 왕복은 세어서 관리합니다 (lib/tasks.ts 의 규칙 5)
 * ======================================================================== */

describe('getGroupPushStatus — RPC 호출 규약', () => {
  it("함수 이름은 'group_push_status', 인자는 p_group_id 하나", async () => {
    replyWith([])

    await getGroupPushStatus(GROUP)

    expect(seam.rpcCalls).toHaveLength(1)
    expect(seam.rpcCalls[0].fn).toBe('group_push_status')
    expect(seam.rpcCalls[0].args).toEqual({ p_group_id: GROUP })
  })

  it('멤버 수와 무관하게 왕복은 1회다 (멤버당 질의 금지)', async () => {
    replyWith([
      { user_id: MINSU, has_push: true },
      { user_id: JIHO, has_push: false },
      { user_id: SORA, has_push: true },
    ])

    await getGroupPushStatus(GROUP)

    expect(seam.rpcCalls).toHaveLength(1)
  })

  it('★ groupId 가 빈 문자열이면 아예 나가지 않는다 — 헛왕복 금지 ★', async () => {
    const { statuses, error } = await getGroupPushStatus('')

    expect(seam.rpcCalls).toHaveLength(0)
    expect(statuses.size).toBe(0)
    // "그룹을 아직 못 고른 상태" 는 오류가 아닙니다.
    expect(error).toBeNull()
  })
})

/* ==========================================================================
 * 5. 비멤버 = 0행 = 정상 경로
 *
 * 0006 은 비멤버에게 예외를 던지지 않습니다. 예외로 만들면 "그 group_id 는
 * 실재한다" 가 새고, 진짜 조회 실패와도 구분할 수 없습니다.
 * ======================================================================== */

describe('getGroupPushStatus — 비멤버는 오류가 아니라 0행', () => {
  it('0행이어도 error 는 null 이다 (권한 오류로 둔갑시키지 않는다)', async () => {
    replyWith([])

    const { statuses, error } = await getGroupPushStatus(GROUP)

    expect(error).toBeNull()
    expect(statuses.size).toBe(0)
  })

  it('그 결과 화면에는 아무 표시도 붙지 않는다', async () => {
    replyWith([])

    const { statuses } = await getGroupPushStatus(GROUP)

    expect(isPushOff(statuses, MINSU)).toBe(false)
    expect(isPushOff(statuses, JIHO)).toBe(false)
  })
})

/* ==========================================================================
 * 6. isPushOff — "모름" 을 "꺼짐" 으로 단정하지 않는 계약
 *
 * 이 함수가 존재하는 이유 자체가 `!map.get(id)` 를 못 쓰게 하기 위해서입니다.
 * 그 표현은 undefined(모름) 와 false(꺼짐) 를 같은 값으로 뭉갭니다.
 * ======================================================================== */

describe('isPushOff — 확실히 꺼진 사람만 true', () => {
  const map: PushStatusMap = new Map([
    [MINSU, true],
    [JIHO, false],
  ])

  it('false 로 조회된 사람만 true', () => {
    expect(isPushOff(map, JIHO)).toBe(true)
  })

  it('true 로 조회된 사람은 false', () => {
    expect(isPushOff(map, MINSU)).toBe(false)
  })

  it('★ 조회되지 않은 사람은 false — 모르는 것을 "꺼짐" 으로 단정하지 않는다 ★', () => {
    expect(map.has(SORA)).toBe(false)
    expect(isPushOff(map, SORA)).toBe(false)
  })

  it('빈 Map(=조회 실패)에서는 누구에게도 true 가 나오지 않는다', () => {
    const empty: PushStatusMap = new Map()
    expect(isPushOff(empty, MINSU)).toBe(false)
    expect(isPushOff(empty, JIHO)).toBe(false)
    expect(isPushOff(empty, SORA)).toBe(false)
  })

  it('빈 문자열 id 로 물어도 던지지 않고 false', () => {
    expect(() => isPushOff(map, '')).not.toThrow()
    expect(isPushOff(map, '')).toBe(false)
  })

  it('★ `!map.get(id)` 와 결과가 다르다 — 이 함수가 존재하는 이유 ★', () => {
    // 모르는 사람에게 두 표현은 정반대의 화면을 만듭니다.
    expect(!map.get(SORA)).toBe(true) // 이렇게 썼다면 "알림 꺼둠" 이 붙습니다
    expect(isPushOff(map, SORA)).toBe(false) // 실제 계약: 아무것도 붙이지 않는다
  })

  it('Map 을 수정하지 않는다 (읽기 전용 판정)', () => {
    const before = new Map(map)
    isPushOff(map, SORA)
    isPushOff(map, JIHO)
    expect(map).toEqual(before)
  })
})

/* ==========================================================================
 * 7. 컴파일 타임 계약 — 이 함수가 무엇을 돌려주지 "않는가"
 *
 * `@ts-expect-error` 는 `tsc --noEmit` 게이트에서 검사됩니다. 아래 블록은
 * 런타임 assert 가 아니라, 0006 이 지키기로 한 사생활 경계가 타입에서도
 * 유지되는지를 못 박습니다. 누가 endpoint 를 추가하면 여기서 먼저 터집니다.
 * (반대로 기대한 오류가 사라지면 tsc 가 "Unused '@ts-expect-error'" 로 터집니다.)
 * ======================================================================== */

describe('group_push_status 타입 계약', () => {
  const row: FunctionReturns<'group_push_status'>[number] = {
    user_id: MINSU,
    has_push: true,
  }

  it('반환 행은 user_id 와 has_push 두 칸뿐', () => {
    expect(Object.keys(row).sort()).toEqual(['has_push', 'user_id'])
  })

  it('★ endpoint 는 타입에 없다 — 남의 기기로 푸시를 보낼 수 있는 자격증명이다 ★', () => {
    // @ts-expect-error endpoint 를 이 함수로 내보내면 안 됩니다 (0006 주석 참고).
    const leaked: unknown = row.endpoint
    expect(leaked).toBeUndefined()
  })

  it('p256dh / auth 키도 타입에 없다', () => {
    // @ts-expect-error p256dh 는 절대 노출하지 않습니다.
    const p256: unknown = row.p256dh
    // @ts-expect-error auth 키도 마찬가지입니다.
    const authKey: unknown = row.auth
    expect(p256).toBeUndefined()
    expect(authKey).toBeUndefined()
  })

  it('★ 기기 개수도 타입에 없다 — exists() 이지 count(*) 가 아니다 ★', () => {
    // @ts-expect-error 몇 대를 쓰는지는 이 화면이 알 필요 없는 사생활 정보입니다.
    const deviceCount: unknown = row.device_count
    expect(deviceCount).toBeUndefined()
  })

  it('user_agent / 시각도 타입에 없다', () => {
    // @ts-expect-error 어떤 기기·브라우저인지는 노출하지 않습니다.
    const ua: unknown = row.user_agent
    // @ts-expect-error 마지막 사용 시각은 행동 추적이 됩니다.
    const lastUsed: unknown = row.last_used_at
    expect(ua).toBeUndefined()
    expect(lastUsed).toBeUndefined()
  })

  it('★ RETURNS TABLE 은 배열이다 — 객체 하나로 받으면 컴파일에서 막힌다 ★', () => {
    // @ts-expect-error data[0] 이 아니라 순회해야 합니다.
    const wrong: FunctionReturns<'group_push_status'> = { user_id: MINSU, has_push: true }
    expect(wrong).toBeDefined()
  })

  it('인자는 p_group_id 하나 — 남의 id 를 끼워 넣을 길이 없다', () => {
    const args: FunctionArgs<'group_push_status'> = {
      p_group_id: GROUP,
      // @ts-expect-error 인자를 늘리면 SECURITY DEFINER 가 우회 통로가 됩니다.
      p_user_id: MINSU,
    }
    expect(args.p_group_id).toBe(GROUP)
  })

  it('has_push 는 boolean 이다 (개수를 담을 자리가 아니다)', () => {
    const numeric: FunctionReturns<'group_push_status'>[number] = {
      user_id: MINSU,
      // @ts-expect-error 숫자를 넣으려는 시도는 곧 count(*) 로 바꾸려는 시도입니다.
      has_push: 2,
    }
    expect(numeric).toBeDefined()
  })
})

/**
 * lib/push-status.ts — "이 그룹원은 알림을 켜 뒀는가" (0006)
 *
 * ★ 서버 전용 ★ createClient() 가 next/headers 를 타므로 Client Component 에서
 * import 하지 마세요. lib/tasks.ts 와 같은 계층입니다.
 *
 * ---------------------------------------------------------------------------
 * 왜 테이블을 직접 읽지 않는가
 * ---------------------------------------------------------------------------
 * push_subscriptions 는 0002 의 `push_subscriptions_all_own` 정책
 * (`user_id = auth.uid()`) 때문에 **본인 행만** 읽힙니다. 정책을 그룹원까지
 * 넓히면 endpoint / p256dh / auth 가 같이 열리는데, 그 셋은 남의 기기로 푸시를
 * 보낼 수 있는 자격증명입니다. 그래서 정책은 건드리지 않고, 0006 의 SECURITY
 * DEFINER 함수 `public.group_push_status(p_group_id)` 로 **불리언 한 칸만**
 * 받아옵니다.
 *
 * 그 함수가 돌려주지 않는 것: endpoint, p256dh, auth, expiration_time,
 * user_agent, 시각들, 그리고 **구독 개수**. 개수는 exists() 로 접혀 있습니다 —
 * "기기 몇 대를 쓰는가" 는 이 화면이 알 필요가 없는 사생활 정보입니다.
 * 그러니 여기서도 boolean 위로 아무것도 만들어 붙이지 마세요.
 *
 * ---------------------------------------------------------------------------
 * 실패는 값이지 예외가 아닙니다 — 그리고 여기서는 그게 특히 중요합니다
 * ---------------------------------------------------------------------------
 * 이 정보는 현황 화면의 **보조 표시**입니다. 진행률도, 멤버 목록도, 콕 찌르기도
 * 이것 없이 멀쩡히 동작합니다. RPC 가 실패했다고 화면 전체가 오류로 바뀌면
 * 부수적인 배지 하나 때문에 본체를 잃는 셈입니다. 그래서 절대 throw 하지 않고,
 * 실패하면 **빈 Map** 을 돌려줍니다. 빈 Map 은 "다들 알림을 껐다" 가 아니라
 * "모르겠다" 이고, 화면은 모르는 사람에게는 아무 표시도 하지 않습니다
 * (`hasPush(map, id)` 가 undefined 를 돌려주는 이유).
 *
 * `error` 는 로깅/디버깅용으로만 함께 돌려줍니다. 화면에 띄우지 마세요.
 */

import { createClient } from '@/lib/supabase/server'
import { toKoreanDbError } from '@/lib/tasks'

/**
 * userId → 알림 켬 여부.
 *
 * ★ 키가 없는 것과 값이 false 인 것은 다릅니다 ★
 *   - 키 없음 : 알 수 없음(조회 실패, 또는 그 사람이 응답에 없었음)
 *   - false   : 확실히 안 켰음
 * 화면에서 `map.get(id) === false` 로 좁혀 쓰세요. `!map.get(id)` 는 둘을
 * 뭉개서, 조회가 실패한 순간 전원에게 "알림 꺼둠" 을 붙입니다.
 */
export type PushStatusMap = Map<string, boolean>

export type GroupPushStatus = {
  /** 실패했으면 빈 Map. 절대 null 이 아닙니다. */
  statuses: PushStatusMap
  /** 진단용. null 이면 정상. ★ 화면에 렌더링하지 마세요. ★ */
  error: string | null
}

/**
 * 그룹원들의 알림 켬/끔.
 *
 * 반환 행은 "알림을 켠 사람" 이 아니라 **그 그룹의 멤버 전원**입니다. 안 켠
 * 사람도 has_push=false 로 들어옵니다.
 *
 * 호출자가 그 그룹의 멤버가 아니면 함수가 예외 대신 0행을 돌려주므로, 여기서는
 * 그냥 빈 Map + error null 이 됩니다("아무도 모르겠다"). 이것도 정상 경로입니다.
 *
 * ★ RETURNS TABLE 이라 data 는 배열입니다 ★ data[0] 이 아니라 순회하세요.
 */
export async function getGroupPushStatus(groupId: string): Promise<GroupPushStatus> {
  const empty: PushStatusMap = new Map()

  if (!groupId) {
    return { statuses: empty, error: null }
  }

  try {
    const supabase = await createClient()

    const { data, error } = await supabase.rpc('group_push_status', {
      p_group_id: groupId,
    })

    if (error) {
      // PGRST202 = 함수가 아직 배포되지 않음(0006 미적용). 그 경우에도 화면은
      // 그냥 "알림 여부를 모르는 화면" 으로 동작합니다.
      return {
        statuses: empty,
        error: toKoreanDbError(error, '알림 설정 여부를 불러오지 못했습니다.'),
      }
    }

    const statuses: PushStatusMap = new Map()
    for (const row of data ?? []) {
      // 방어적으로 좁힙니다. 이 Map 의 소비자는 `=== false` 로 판정하므로,
      // 불리언이 아닌 값이 섞이면 판정이 조용히 어긋납니다.
      if (typeof row?.user_id === 'string' && typeof row?.has_push === 'boolean') {
        statuses.set(row.user_id, row.has_push)
      }
    }

    return { statuses, error: null }
  } catch {
    // 네트워크 단절 등 postgrest 가 값으로 돌려주지 못한 실패까지 여기서 삼킵니다.
    // 이 함수가 던지면 /status 전체가 죽습니다.
    return { statuses: empty, error: '알림 설정 여부를 불러오지 못했습니다.' }
  }
}

/**
 * "이 사람은 알림을 확실히 꺼 뒀는가."
 *
 * 모르면 false 입니다 — 모르는 것을 "꺼짐" 으로 단정하면, 조회가 한 번 실패한
 * 날 전원에게 틀린 표시가 붙습니다.
 */
export function isPushOff(statuses: PushStatusMap, userId: string): boolean {
  return statuses.get(userId) === false
}

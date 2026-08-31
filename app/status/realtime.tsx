'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef } from 'react'

import { createClient } from '@/lib/supabase/client'

/**
 * /status 실시간 반영 — 렌더하는 것이 하나도 없는 컴포넌트.
 *
 * app/status/page.tsx 는 Server Component 로 남습니다. 이 파일은 `tasks` 의
 * Postgres Changes 를 구독하다가 변경이 오면 `router.refresh()` 를 불러서
 * **서버 컴포넌트를 다시 받아옵니다**. 즉 데이터는 여전히 lib/tasks.ts 의
 * getStatusPageData() 한 곳에서만 나옵니다 — 실시간 이벤트를 화면 상태에
 * 직접 적용하지 않습니다.
 *
 * 왜 페이로드를 안 쓰는가:
 *   현황 화면의 한 줄은 "그 사람의 오늘 할 일 총 개수 / 완료 개수" 라는 집계고,
 *   그 집계는 RLS 를 통과한 tasks 전체를 봐야 나옵니다. INSERT 한 건의
 *   페이로드로 카운터를 ±1 하는 건 재접속 중 놓친 이벤트 하나에 영원히
 *   어긋나는 화면을 만듭니다. 이벤트는 "다시 물어보라"는 신호로만 씁니다.
 *   덤으로, DELETE 페이로드에는 어차피 기본키밖에 없습니다(아래 참고).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ★ REPLICA IDENTITY 를 FULL 로 바꾸지 마세요 ★
 * ───────────────────────────────────────────────────────────────────────────
 * 0001_init.sql 이 `alter table public.tasks replica identity default` 를 박아
 * 두고 그 이유를 테이블 주석에 적어 놨습니다. 그 이유는 그대로 유효하지만,
 * **진짜 방어선은 `tasks` 에 켜져 있는 RLS 입니다.** Realtime 은 RLS 가 켜진
 * 테이블에서 INSERT/UPDATE 를 구독자별로 거르고(비멤버는 이벤트 자체를 못 받음),
 * DELETE 페이로드는 클라이언트로 나가기 전에 기본키로 축소합니다. REPLICA
 * IDENTITY DEFAULT 는 그 위에 얹힌 2차 방어선입니다 — 겹쳐 있다고 해서 FULL 로
 * 바꿀 이유가 되지는 않습니다. FULL 로 바꿔서 얻는 것은 아무것도 없고(아래
 * DELETE 리스너가 이미 필터 없이 받습니다), 잃는 것은 방어선 한 겹입니다.
 * 그대로 두세요.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 조용히 죽습니다
 * ───────────────────────────────────────────────────────────────────────────
 * Realtime 이 꺼져 있거나(퍼블리케이션 미등록), WebSocket 이 막힌 네트워크거나,
 * 채널이 끝내 붙지 못해도 **사용자에게는 아무것도 띄우지 않습니다.** 그때의 앱은
 * "고장난 앱" 이 아니라 "실시간이 아닌 앱" 이고, 새로고침하면 멀쩡히 최신입니다.
 * 실시간은 부가 기능이지 이 화면의 전제가 아닙니다.
 */

/** 이벤트 폭풍을 한 번의 refresh 로 묶는 창(ms). */
const DEBOUNCE_MS = 400

/**
 * 갱신 빈도 상한(ms). 이벤트가 아무리 몰려와도 이 간격보다 자주 서버를 때리지
 * 않습니다 — 지속 상한 0.5회/초.
 *
 * 디바운스만으로는 상한이 아닙니다. 400ms 창은 "같은 창 안에 몰린" 이벤트만
 * 묶고, 사람이 20개를 20초에 걸쳐 체크하면 refresh 도 20번 흩어져 나갑니다.
 * refresh 한 번은 getStatusPageData() 의 쿼리들 + group_push_status RPC 왕복이라
 * 싸지 않습니다.
 *
 * ★ 이 상한은 아래 DELETE 리스너(필터 없음)의 안전장치이기도 합니다. ★
 * 필터가 없으니 다른 그룹의 삭제도 이 클라이언트를 깨웁니다. 누가 자기 할 일을
 * 추가/삭제로 두들겨도 이 화면이 감당하는 것은 초당 0.5회뿐입니다.
 */
const MIN_INTERVAL_MS = 2_000

/**
 * 이보다 오래 숨어 있다 돌아왔으면, 놓친 이벤트가 없어도 한 번 갱신합니다.
 * (폰을 잠갔다 켜는 동안 소켓이 조용히 얼어붙는 경우 — 아래 onVisibility 참고.)
 */
const STALE_AFTER_HIDDEN_MS = 60_000

/**
 * 채널 토픽 일련번호.
 *
 * realtime-js 의 `client.channel(topic)` 은 같은 topic 이 아직 `client.channels`
 * 에 남아 있으면 **그 채널을 그대로 재사용**합니다. 그런데 `removeChannel` 은
 * phx_leave 왕복을 기다리므로 목록에서 빠지는 시점이 비동기입니다. 그래서
 * 언마운트 직후 재마운트(React StrictMode 의 이중 마운트, 하단 내비로 /status →
 * 다른 탭 → /status 왕복)는 "죽는 중인 채널" 을 돌려받고,
 *
 *   - `.on()` 은 중복 바인딩으로 무시되고(콘솔 로그만 남습니다),
 *   - `.subscribe()` 는 채널이 closed 가 아니라서 join 을 통째로 건너뜁니다.
 *
 * 결과는 채널 2개가 아니라 **0개** 입니다. 그리고 "조용히 죽습니다" 정책 때문에
 * 아무도 눈치채지 못합니다. 토픽을 마운트마다 유일하게 만들면 이 경로가 아예
 * 없어집니다.
 */
let channelSeq = 0

/**
 * 다음 refresh 까지 기다릴 시간(ms) — 디바운스와 빈도 상한을 합친 순수 함수.
 *
 * 마지막 refresh 로부터 충분히 지났으면 그냥 디바운스 창만큼,
 * 방금 했으면 상한을 채울 때까지 더 기다립니다.
 */
export function nextRefreshDelayMs(
  now: number,
  lastRefreshAt: number,
  debounceMs: number = DEBOUNCE_MS,
  minIntervalMs: number = MIN_INTERVAL_MS,
): number {
  const since = now - lastRefreshAt
  return Math.max(debounceMs, minIntervalMs - since)
}

/**
 * 탭이 다시 보일 때 갱신할 것인가 — 순수 함수.
 *
 * 숨어 있는 동안 이벤트가 왔으면 당연히 갱신하고, 이벤트가 없었더라도 너무 오래
 * 숨어 있었으면 갱신합니다(소켓이 조용히 죽어서 이벤트가 "없는" 것일 수 있음).
 */
export function shouldRefreshOnVisible(
  missed: boolean,
  hiddenForMs: number,
  staleAfterMs: number = STALE_AFTER_HIDDEN_MS,
): boolean {
  return missed || hiddenForMs >= staleAfterMs
}

export default function StatusRealtime({ groupId }: { groupId: string }) {
  const router = useRouter()

  // router 를 ref 로 붙듭니다. Next 16 의 라우터 인스턴스는 사실상 모듈
  // 싱글턴이라 지금은 안정적이지만, 그 가정이 깨지는 날 schedule 이 바뀌고
  // effect 가 다시 돌면서 refresh 마다 채널이 재생성됩니다. 그 경로를 막습니다.
  const routerRef = useRef(router)
  useEffect(() => {
    routerRef.current = router
  })

  // refresh 를 예약해 둔 타이머. 창이 열려 있는 동안 들어온 이벤트는 전부
  // 이 한 건으로 합쳐집니다.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 마지막으로 실제 refresh 를 부른 시각. 빈도 상한의 기준점.
  const lastRefreshRef = useRef(0)
  // 탭이 숨어 있는 동안 이벤트가 왔는가. 다시 보일 때 한 번만 갱신하는 근거.
  const missedRef = useRef(false)
  // 탭이 숨은 시각. 얼마나 오래 숨어 있었는지 재는 용도.
  const hiddenSinceRef = useRef<number | null>(null)
  // 언마운트 뒤에 남은 타이머가 refresh 를 부르는 걸 막는 빗장.
  const aliveRef = useRef(true)

  /**
   * router.refresh() 를 디바운스 + 빈도 상한으로 묶습니다.
   *
   * 5명이 동시에 체크하면 이벤트가 여러 건 몰려오는데, 그때마다 refresh 하면
   * /status 의 서버 왕복이 그만큼 늡니다. 사용자 눈에는 어차피 한 번의
   * 갱신으로 보입니다.
   *
   * 미루는 경우 세 가지 — 전부 missedRef 에 표시만 남기고, 조건이 풀리는 순간
   * (visibilitychange / online) 한 번에 갚습니다:
   *   - 문서가 안 보임: 백그라운드 탭이 계속 서버를 두들기지 않게.
   *   - 오프라인: refresh 실패는 하드 내비게이션이고, 그러면 서비스워커가
   *     오프라인 문서를 물려줍니다 — 보드를 보고 있던 사용자가 오프라인
   *     페이지로 튕깁니다. 실시간이 안 되는 것보다 나쁩니다. navigator.onLine
   *     은 true 를 못 믿지만 false 는 비교적 믿을 만하고, 여기 필요한 건 그
   *     방향뿐입니다(lib/offline.ts 의 probeNetwork() 는 쓰지 않습니다 —
   *     왕복을 하나 더 늘리자고 이걸 막는 건 앞뒤가 맞지 않습니다).
   */
  const schedule = useCallback(() => {
    if (!aliveRef.current) return

    if (typeof document !== 'undefined' && document.hidden) {
      missedRef.current = true
      return
    }

    if (timerRef.current !== null) return

    const wait = nextRefreshDelayMs(Date.now(), lastRefreshRef.current)

    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (!aliveRef.current) return
      // 타이머가 도는 사이에 탭이 숨었을 수도 있습니다. 그러면 미루세요.
      if (typeof document !== 'undefined' && document.hidden) {
        missedRef.current = true
        return
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        missedRef.current = true
        return
      }
      missedRef.current = false
      lastRefreshRef.current = Date.now()
      routerRef.current.refresh()
    }, wait)
  }, [])

  useEffect(() => {
    aliveRef.current = true

    // 채널을 못 만드는 환경(env 누락 등)에서 화면 전체가 죽지 않도록.
    let supabase: ReturnType<typeof createClient>
    try {
      supabase = createClient()
    } catch {
      return
    }

    /**
     * 토픽에 groupId 와 마운트 일련번호를 함께 넣습니다. groupId 는 그룹 칩
     * 전환을 구분하려고, 일련번호는 위 channelSeq 주석의 "죽는 중인 채널
     * 재사용" 을 막으려고 붙습니다.
     */
    const channel = supabase
      .channel(`status:tasks:${groupId}:${(channelSeq += 1)}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'tasks',
          filter: `group_id=eq.${groupId}`,
        },
        () => {
          // 페이로드는 일부러 읽지 않습니다(파일 상단 주석).
          schedule()
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'tasks',
          filter: `group_id=eq.${groupId}`,
        },
        () => {
          schedule()
        },
      )
      /*
       * ───────────────────────────────────────────────────────────────────
       * ★ DELETE 에는 필터를 걸 수 없습니다 — 걸면 이벤트가 하나도 안 옵니다 ★
       * ───────────────────────────────────────────────────────────────────
       * tasks 는 REPLICA IDENTITY DEFAULT 라 DELETE 페이로드에 기본키(id)만
       * 실립니다. Realtime 의 필터 판정은 "필터 컬럼이 레코드에 없으면 불일치"
       * 이므로, group_id 가 없는 DELETE 레코드에 `group_id=eq.…` 를 걸면 항상
       * false 입니다. Supabase 문서의 "Delete events are not filterable" 이
       * 같은 이야기입니다. 그래서 INSERT/UPDATE 만 필터를 유지하고 DELETE 는
       * 여기서 필터 없이 따로 받습니다.
       *
       * ★ 이걸 `replica identity full` 로 고치려는 유혹을 참으세요. ★
       * FULL 이면 group_id 가 페이로드에 실려 필터가 "동작" 합니다. 하지만
       * 얻는 것이 없습니다 — 이 리스너가 이미 삭제를 받고 있고, 페이로드는
       * 어차피 읽지 않으며(신호로만 씀), 필터를 되찾아 아끼는 것은 다른 그룹의
       * 삭제 한 건당 refresh 하나뿐인데 그건 위 MIN_INTERVAL_MS 가 상한을
       * 물려 놨습니다. 반면 잃는 것은 방어선 한 겹입니다: DELETE 는 RLS 평가
       * 대상이 아니고, FULL 은 삭제된 행 전체(title 포함)를 페이로드에 올려
       * 놓습니다. RLS 가 진짜 방어선이고 REPLICA IDENTITY 는 2차 방어선이지만,
       * 2차 방어선을 스스로 걷어낼 이유가 없습니다. DEFAULT 로 두세요.
       *
       * 대가: 앱 전체의 tasks 삭제가 이 클라이언트를 깨웁니다. 페이로드에는
       * 랜덤 uuid 하나뿐이라 읽을 것이 없고(그래서 읽지 않습니다), 빈도는
       * MIN_INTERVAL_MS 가 막습니다.
       *
       * 왜 broadcast 트리거(realtime.send + realtime.messages 정책) 로 안 갔나:
       * 그 쪽이 더 정확하지만 SECURITY DEFINER 트리거와 realtime.messages RLS
       * 정책이라는 새 공격면을 엽니다. 지금 규모(친구 3~6명, 구글 OAuth 테스트
       * 사용자 허용목록으로 가입 자체가 통제됨)에는 과한 대가라고 판단했습니다.
       * ★ 인원이 늘어 아무나 가입할 수 있게 되면 broadcast 방식으로 옮기세요. ★
       * 그때 이 리스너를 private 채널의 'task_deleted' broadcast 구독으로
       * 바꾸면 됩니다 — schedule() 을 부르는 신호라는 점은 그대로입니다.
       */
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'tasks' },
        () => {
          schedule()
        },
      )

    // 채널을 두 번 치우지 않기 위한 빗장(포기 경로 + cleanup).
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true

      // ★ removeChannel 필수 ★ unsubscribe() 만으로는 클라이언트가 들고 있는
      // 채널 목록에서 빠지지 않습니다. 그룹 칩을 몇 번 눌렀다 오면 죽은 채널이
      // 계속 쌓이고, 소켓은 그만큼 살아 있습니다.
      void supabase
        .removeChannel(channel)
        .catch(() => {})
        .finally(() => {
          // leave 응답이 'ok' 가 아니면(타임아웃 등) removeChannel 이 teardown 을
          // 부르지 않아 채널이 목록에 남고 재접속 때 되살아납니다.
          try {
            channel.teardown()
          } catch {
            /* 이미 정리됨 */
          }
        })
    }

    /**
     * 재접속 처리.
     *
     * 연결이 끊긴 동안의 변경은 이벤트로 오지 않습니다. Postgres Changes 에는
     * 재생(replay)이 없습니다. 그래서 SUBSCRIBED 로 *다시* 들어오면 놓친 게
     * 있다고 보고 한 번 갱신합니다. 첫 SUBSCRIBED 는 방금 서버에서 받은
     * 데이터와 같으므로 건너뜁니다 — 화면이 뜨자마자 한 번 더 왕복하는 건
     * 순수한 낭비입니다.
     */
    let everSubscribed = false

    /**
     * 연달아 이만큼 실패하면 실시간을 포기합니다.
     *
     * 세션이 만료(SIGNED_OUT)되면 realtime 의 토큰이 비고, 채널은 CHANNEL_ERROR
     * 로 떨어진 뒤 최대 10초 간격으로 **영원히** 재조인을 시도합니다. 재시도로
     * 풀리지 않는 상태에서 배터리만 태우는 루프라, 몇 번 해보고 조용히 놓습니다.
     * 화면은 그대로 두고 실시간만 포기하는 것이고, 아래 가시성 복귀 갱신이
     * 남아 있으므로 보드가 영원히 낡은 채로 남지는 않습니다.
     */
    const MAX_ERROR_STREAK = 5
    let errorStreak = 0

    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        errorStreak = 0
        if (everSubscribed) schedule()
        else everSubscribed = true
        return
      }

      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // 사용자에게는 여전히 아무것도 띄우지 않습니다. 개발 중에만 보입니다 —
        // 이 경로가 통째로 버려지면 원리적으로 진단이 불가능해집니다.
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[status realtime]', status, err)
        }
        errorStreak += 1
        if (errorStreak >= MAX_ERROR_STREAK) dispose()
      }
    })

    /**
     * 탭이 다시 보일 때. 숨어 있는 동안 온 이벤트를 여기서 한 번에 갚습니다.
     *
     * 이벤트가 없었어도 오래 숨어 있었으면 갱신합니다. 폰을 두 시간 잠갔다 켜는
     * 경우가 그렇습니다 — 그동안의 변경은 이벤트로 오지 않고(소켓 끊김/프리즈),
     * 소켓이 프리즈에서 그대로 살아나면 재구독 갱신도 없어서, 이 조건이 없으면
     * 낡은 보드가 그대로 남습니다.
     */
    const onVisibility = () => {
      if (document.hidden) {
        hiddenSinceRef.current = Date.now()
        return
      }
      const hiddenFor =
        hiddenSinceRef.current === null ? 0 : Date.now() - hiddenSinceRef.current
      hiddenSinceRef.current = null
      if (!shouldRefreshOnVisible(missedRef.current, hiddenFor)) return
      missedRef.current = false
      schedule()
    }

    /** 오프라인이라 미뤄 둔 갱신을 온라인 복귀 때 갚습니다(위 schedule 주석). */
    const onOnline = () => {
      if (!missedRef.current) return
      missedRef.current = false
      schedule()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)

    return () => {
      aliveRef.current = false
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)

      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }

      dispose()
    }
  }, [groupId, schedule])

  return null
}

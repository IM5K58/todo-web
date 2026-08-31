'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useOptimistic, useRef, useState, useTransition } from 'react'

import { ErrorText, Hint } from '@/components/ui'
import {
  probeNetwork,
  readTodaySnapshot,
  saveTodaySnapshot,
  type OfflineTask,
} from '@/lib/offline'

import { addTask, deleteTask, toggleTask } from './tasks/actions'
// 값이 아니라 타입만 가져옵니다. lib/tasks.ts 는 next/headers 를 타고 들어가는
// 서버 전용 모듈이라, 값으로 import 하면 클라이언트 번들에 끌려 들어옵니다.
// `import type` 은 컴파일 시점에 지워지므로 안전합니다.
import type { ActionResult } from '@/lib/tasks'

/**
 * "오늘" 화면의 상호작용 부분 — 진행 요약 · 할 일 목록 · 추가 폼.
 *
 * app/page.tsx 는 Server Component 로 남고(읽기는 전부 거기서 lib/tasks.ts 로),
 * 이 파일만 클라이언트로 내려갑니다. 세 덩어리가 한 컴포넌트에 같이 있는 이유는
 * 셋 다 "낙관적 목록"이라는 하나의 상태를 보기 때문입니다. 진행바를 서버
 * 데이터로, 목록을 낙관적 데이터로 그리면 체크한 순간 0.3초 동안 둘이 서로 다른
 * 말을 합니다.
 *
 * 쓰기는 전부 app/tasks/actions.ts 의 Server Action 입니다. 검증(코드 포인트 기준
 * 200자), 소유권 재확인, 한국어 오류 매핑, revalidatePath 는 전부 그쪽에 있고
 * 여기서 다시 구현하지 않습니다.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 낙관적 업데이트를 쓰기로 한 이유와, 실패했을 때의 계약
 * ───────────────────────────────────────────────────────────────────────────
 * 체크는 이 앱에서 가장 자주 눌리는 버튼이고, 왕복을 기다리면 "눌렸나?" 싶어서
 * 한 번 더 누르게 됩니다(그리고 두 번 누르면 원위치입니다). 그래서 useOptimistic
 * 으로 즉시 반영합니다.
 *
 * 대신 실패를 삼키지 않습니다. 트랜지션이 끝나면 React 가 낙관적 상태를 버리고
 * 서버 props 로 되돌리므로 화면은 자동으로 진실로 복구되고, 그 위에 액션이 돌려준
 * 한국어 문장을 목록 위에 띄웁니다. 되돌아간 이유를 사용자가 읽을 수 있어야
 * 낙관적 업데이트가 거짓말이 아니게 됩니다.
 *
 * 성공 경로에서는 액션이 revalidatePath('/') 를 부르므로, 새 서버 데이터가
 * 도착하면서 낙관적 상태가 같은 값으로 교체됩니다(깜빡임 없음).
 */

// ---------------------------------------------------------------------------
// 뷰 모델
// ---------------------------------------------------------------------------

/**
 * 화면이 실제로 쓰는 만큼만. lib/tasks.ts 의 `TodayTask`(테이블 부분집합)를
 * page.tsx 에서 이 모양으로 줄여서 넘깁니다 — done_at 타임스탬프는 이 화면
 * 어디에도 표시되지 않고, 클라이언트 번들에 보낼 이유도 없습니다.
 */
export type TodayTaskView = {
  id: string
  title: string
  done: boolean
}

/** 아직 서버에 없는 행(추가 직후)은 id 가 임시값이라 삭제/체크를 걸 수 없습니다. */
type TaskRowView = TodayTaskView & { pending?: boolean }

type OptimisticOp =
  | { kind: 'add'; tempId: string; title: string }
  | { kind: 'set-done'; id: string; done: boolean }
  | { kind: 'remove'; id: string }

/**
 * 정렬 규칙: 여기서 재정렬하지 않습니다. 서버가 준 순서(sort_order, created_at =
 * 적은 순서)를 그대로 유지하고, 완료 항목은 자리를 지킨 채 취소선 + 흐리게로만
 * 구분합니다.
 *
 * 왜 "미완료 위 / 완료 아래"로 옮기지 않는가:
 *   1. 낙관적 업데이트라 이동이 즉시 일어납니다. 체크한 줄이 손가락 밑에서
 *      사라지고 그 자리에 다음 줄이 올라오므로, 연속으로 체크할 때 바로 다음
 *      항목을 잘못 누르게 됩니다. 이 앱에서 가장 흔한 오조작 경로입니다.
 *   2. 잘못 체크했을 때 되돌리려면 방금 사라진 줄을 목록 아래에서 다시 찾아야
 *      합니다. 제자리에 있으면 같은 자리를 한 번 더 누르면 끝입니다.
 *   3. 하루치 목록은 보통 3~7줄입니다. 정렬로 얻을 스캔 이득이 거의 없습니다.
 * "완료된 것도 목록에서 사라지지 않게" 라는 요구와도 같은 방향입니다.
 */
function applyOp(state: TaskRowView[], op: OptimisticOp): TaskRowView[] {
  switch (op.kind) {
    case 'add':
      // 새 할 일은 언제나 맨 아래. 서버도 (sort_order=0, created_at) 순이라
      // 되돌아올 때 같은 자리입니다.
      return [...state, { id: op.tempId, title: op.title, done: false, pending: true }]
    case 'set-done':
      return state.map((task) => (task.id === op.id ? { ...task, done: op.done } : task))
    case 'remove':
      return state.filter((task) => task.id !== op.id)
  }
}

/**
 * lib/tasks.ts 의 `TASK_TITLE_MAX` 와 같은 값입니다. 저건 값 export 라
 * 클라이언트에서 import 하면 서버 모듈이 딸려오므로 여기에 복제했습니다.
 * 어긋나도 안전한 방향입니다 — 실제 상한은 DB 의 tasks_title_len_chk 이고,
 * 서버 액션이 코드 포인트 기준으로 다시 검사합니다.
 */
const TITLE_MAX = 200

/** DB 의 `char_length()` 와 같은 단위(코드 포인트). '😀' 는 2가 아니라 1입니다. */
function codePointLength(value: string): number {
  return Array.from(value).length
}

/**
 * 오프라인에서 쓰기를 시도했을 때의 문장.
 *
 * "나중에 자동으로 보낼게요" 라고 쓰지 않습니다. 이번 범위에는 쓰기 큐도
 * 재접속 동기화도 없고, iOS Safari 는 Background Sync 를 지원하지도 않습니다.
 * 지킬 수 없는 약속을 하고 조용히 잃는 것이 제일 나쁩니다.
 */
const OFFLINE_WRITE_KO =
  '지금은 저장할 수 없어요. 인터넷에 연결된 뒤에 다시 눌러주세요.'

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

export default function TodayTasks({
  tasks,
  groupId,
  groupName,
  showGroupHint,
}: {
  /** 오늘(사용자 시간대 기준) 내 할 일. 서버가 정렬해서 넘겨줍니다. */
  tasks: TodayTaskView[]
  /** 새 할 일을 기록할 그룹. 가장 먼저 참여한 그룹입니다. */
  groupId: string
  groupName: string
  /** 그룹이 둘 이상일 때만 "어디에 적히는지" 안내합니다. */
  showGroupHint: boolean
}) {
  const [optimisticTasks, applyOptimistic] = useOptimistic<TaskRowView[], OptimisticOp>(
    tasks,
    applyOp,
  )
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const router = useRouter()

  /**
   * "지금 서버에 닿지 않는다"고 **확인된** 상태.
   *
   * navigator.onLine 을 그대로 믿지 않습니다. true 는 "인터페이스가 올라와
   * 있다"는 뜻일 뿐이고, 카페 와이파이에 붙었지만 포털을 통과하지 않은 상태도
   * true 입니다. 이 값이 true 가 되는 경로는 둘뿐입니다.
   *   · 서버 액션 호출이 네트워크 예외로 거절됐다  (= 진짜 실패한 요청)
   *   · navigator.onLine 이 false 다               (= 음성은 비교적 믿을 만함)
   * 해제되는 경로도 둘뿐입니다.
   *   · 서버 액션이 결과를 돌려줬다
   *   · probeNetwork() 가 실제로 성공했다
   */
  const [offline, setOffline] = useState(false)

  /**
   * 서버가 아무것도 못 준 상태에서 저장소로 복원한 목록.
   *
   * ★ 이 화면에서 이 경로는 보조수단입니다 ★
   * `/` 는 동적 SSR 이라, 네트워크가 없으면 이 컴포넌트가 마운트되는 일 자체가
   * 없습니다 — 그 자리는 app/sw.ts 가 만들어 내는 오프라인 문서가 대신합니다.
   * 여기 남겨 둔 것은 bfcache 복원처럼 "컴포넌트는 살아 있는데 서버 데이터가
   * 비어 있는" 경우를 위한 것이고, 그래서 조건을 아주 좁게 겁니다:
   * **probeNetwork() 가 실제로 실패했을 때만** 복원합니다.
   *
   * onLine 만 보고 복원하면, 사용자가 오늘 할 일을 전부 지운 직후에 지운
   * 항목들이 되살아납니다. 그건 오프라인 표시보다 훨씬 나쁜 거짓말입니다.
   */
  const [restored, setRestored] = useState<OfflineTask[] | null>(null)

  /** 복원본을 보여주는 중 = 쓰기가 불가능한 읽기 전용 모드. */
  const readOnly = restored !== null

  const inputRef = useRef<HTMLInputElement>(null)
  // crypto.randomUUID() 는 보안 컨텍스트에서만 존재합니다. 임시 키는 이 렌더
  // 트리 안에서만 유일하면 되므로 카운터로 충분합니다.
  const tempCounter = useRef(0)

  /**
   * 낙관적 변경을 적용하고 서버 액션을 부릅니다.
   *
   * applyOptimistic 은 반드시 트랜지션 안에서 호출해야 하고(밖에서 부르면 React 가
   * 경고와 함께 무시합니다), await 뒤의 setError 도 같은 트랜지션에 속합니다.
   * 트랜지션이 끝나는 순간 낙관적 상태는 폐기되고 props 가 다시 진실이 됩니다.
   */
  function run(op: OptimisticOp, call: () => Promise<ActionResult>) {
    // 새 시도가 시작되면 이전 오류는 즉시 치웁니다(트랜지션 밖 = 긴급 업데이트).
    setError(null)
    startTransition(async () => {
      applyOptimistic(op)
      try {
        const result = await call()
        // 결과가 왔다 = 서버에 닿았다. onLine 이 뭐라고 하든 이게 증거입니다.
        setOffline(false)
        if (!result.ok) setError(result.error)
      } catch {
        // 서버 액션은 실패를 값으로 돌려줍니다(lib/tasks.ts 의 ActionResult).
        // 그러니 여기로 오는 예외는 요청 자체가 나가지 못한 경우 — 네트워크
        // 단절입니다. 삼키면 낙관적 변경만 소리 없이 되돌아가서, 체크가
        // "튕겨 나온" 것처럼 보입니다.
        setOffline(true)
        setError(OFFLINE_WRITE_KO)
      }
    })
    // 트랜지션이 끝나면 React 가 낙관적 상태를 버리고 props 로 되돌립니다.
    // 오프라인이든 아니든 화면은 자동으로 진실(서버가 마지막으로 준 값)로
    // 복구되고, 위 문장이 왜 되돌아갔는지 설명합니다.
  }

  /**
   * 마운트 시점에 저장돼 있던 스냅샷. (오늘 것이 아니면 이미 null 입니다.)
   *
   * ★ 왜 효과가 아니라 useState 초기화인가 ★
   * 아래 두 효과가 저장과 복원을 모두 하는데, 효과는 선언 순서대로 돕니다.
   * 복원 효과가 읽기 전에 저장 효과가 먼저 써 버리면 우리가 복원하려던 바로
   * 그 값을 우리 손으로 지운 뒤에 읽게 됩니다. 초기화 함수는 첫 렌더에서
   * 실행되므로 어떤 효과보다도 먼저입니다.
   *
   * 서버 렌더에서도 실행되지만 그쪽에는 localStorage 가 없어 null 이고,
   * 이 값은 렌더 결과에 직접 쓰이지 않으므로 하이드레이션이 어긋나지 않습니다.
   */
  const [bootSnapshot] = useState(() => readTodaySnapshot())

  /**
   * 서버가 준 오늘 목록을 저장소에 새겨 둡니다.
   *
   * `tasks` 는 서버 props 입니다(낙관적 목록이 아닙니다). 즉 여기 저장되는
   * 것은 언제나 "서버가 마지막으로 확인해 준 오늘"이고, 아직 왕복이 끝나지
   * 않은 낙관적 변경은 절대 들어가지 않습니다.
   *
   * ★ 빈 목록은 여기서 저장하지 않습니다 ★
   * 이 화면에서 빈 배열은 두 가지를 뜻할 수 있습니다 — "오늘 적은 게 없다"와
   * "서버 데이터를 못 받았다". 둘을 구분하지 않고 덮어쓰면 두 번째 경우에
   * 우리가 지키려던 스냅샷을 스스로 지웁니다. 그래서 빈 배열의 처리는 아래
   * 효과가 실제 연결을 확인한 다음에 합니다.
   *
   * 복원본을 보여주는 중에도 저장하지 않습니다(같은 이유).
   */
  useEffect(() => {
    if (readOnly) return
    if (tasks.length === 0) return
    saveTodaySnapshot({
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        done: task.done,
      })),
      groupName,
    })
  }, [tasks, groupName, readOnly])

  /**
   * 연결 상태 감시.
   *
   * 'online' 이벤트는 결론이 아니라 "확인해 볼 만하다"는 신호입니다. 실제
   * 요청(probeNetwork)이 성공해야 온라인으로 칩니다. 성공하면 복원본을 버리고
   * router.refresh() 로 서버에서 진짜 오늘을 다시 받아옵니다.
   *
   * 'offline' 이벤트의 음성은 받아들입니다. 인터페이스가 내려간 것이라 요청을
   * 보내 봐야 실패하고, 배너를 즉시 띄우는 편이 사용자에게 정직합니다.
   */
  const confirmOnline = useCallback(async () => {
    const reachable = await probeNetwork()
    if (!reachable) {
      setOffline(true)
      return false
    }
    setOffline(false)
    setRestored(null)
    router.refresh()
    return true
  }, [router])

  useEffect(() => {
    let alive = true

    function handleOffline() {
      if (alive) setOffline(true)
    }

    function handleOnline() {
      void confirmOnline()
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // 마운트 시점의 상태. onLine 의 음성만 신뢰합니다 — 여기서 무조건
    // probeNetwork() 를 부르면 멀쩡한 첫 로딩마다 요청이 하나 늘어납니다.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setOffline(true)
    }

    return () => {
      alive = false
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [confirmOnline])

  /**
   * 목록이 비어 있을 때만 도는 효과 — "이 빈 상태가 진짜인가"를 판정합니다.
   *
   * 순서가 전부입니다: **먼저 probeNetwork() 로 확인하고** 그 다음에 결정합니다.
   *   · 서버에 닿는다  → 서버가 정말 "오늘은 없다"고 한 것. 스냅샷도 비웁니다.
   *                      (다른 기기에서 다 지웠을 수도 있으니 여기서 정리합니다.)
   *   · 닿지 않는다    → 오프라인. 저장해 둔 목록이 있으면 복원해서 보여줍니다.
   *
   * 반대로 하면(확인 없이 복원) "오늘 할 일을 전부 지웠다"와 "오프라인이라 못
   * 받았다"를 구분하지 못해, 방금 지운 항목이 되살아납니다.
   *
   * 요청 한 번(HEAD, 본문 없음)이 늘지만 목록이 빈 경우에만입니다 — 하루에
   * 아침 한 번 정도이고, 그 대가로 지운 항목이 되살아나는 일이 없습니다.
   */
  useEffect(() => {
    if (tasks.length > 0) {
      setRestored(null)
      return
    }

    let alive = true
    void (async () => {
      const reachable = await probeNetwork()
      if (!alive) return

      if (reachable) {
        setOffline(false)
        saveTodaySnapshot({ tasks: [], groupName })
        return
      }

      setOffline(true)
      // 오늘 것이 아니면 bootSnapshot 이 이미 null 입니다.
      if (bootSnapshot && bootSnapshot.tasks.length > 0) setRestored(bootSnapshot.tasks)
    })()

    return () => {
      alive = false
    }
    // `tasks` 자체가 아니라 길이만 봅니다. 복원은 tasks 를 바꾸지 않으므로
    // 이 효과가 자기 자신을 다시 부르는 경로가 없습니다(확인 요청 반복 없음).
  }, [tasks.length, groupName, bootSnapshot])

  const [restoredCount, restoredDone] = restored
    ? [restored.length, restored.filter((task) => task.done).length]
    : [0, 0]

  function handleAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const input = inputRef.current
    if (!input) return

    const title = input.value.trim()
    if (title.length === 0) {
      setError('할 일을 한 글자 이상 적어주세요.')
      input.focus()
      return
    }
    if (codePointLength(title) > TITLE_MAX) {
      setError(`할 일은 ${TITLE_MAX}자까지 적을 수 있어요.`)
      return
    }

    // 먼저 비우고 포커스를 되돌려 놓습니다. 이 앱의 주 사용 패턴이 "적고 엔터,
    // 적고 엔터"라서, 서버 응답을 기다렸다가 비우면 그 사이에 친 글자가 지워집니다.
    input.value = ''
    input.focus()

    tempCounter.current += 1
    run({ kind: 'add', tempId: `optimistic-${tempCounter.current}`, title }, () =>
      addTask(title, groupId),
    )
  }

  function handleToggle(task: TaskRowView, done: boolean) {
    if (task.pending) return
    // 두 번째 인자를 반드시 넘깁니다. 생략하면 toggleTask 가 서버에서 현재 값을
    // 읽어 뒤집는데, 빠르게 두 번 누르면 두 요청이 서로를 되돌려 원위치합니다.
    run({ kind: 'set-done', id: task.id, done }, () => toggleTask(task.id, done))
  }

  function handleDelete(task: TaskRowView) {
    if (task.pending) return
    run({ kind: 'remove', id: task.id }, () => deleteTask(task.id))
  }

  // 읽기 전용(복원) 모드에서는 진행 요약도 복원본을 봐야 합니다. 목록은
  // 복원본인데 요약만 빈 서버 데이터를 보면 둘이 서로 다른 말을 합니다.
  const total = readOnly ? restoredCount : optimisticTasks.length
  const doneCount = readOnly ? restoredDone : optimisticTasks.filter((task) => task.done).length
  const allDone = total > 0 && doneCount === total
  const percent = total === 0 ? 0 : Math.round((doneCount / total) * 100)

  return (
    <>
      {/* ---- 오프라인 배너 ---------------------------------------------- */}
      {/*
        사용자가 지금 보는 것이 최신이 아니라는 사실을 반드시 알아야 합니다.
        진행 요약보다 위에 둡니다 — "3/5 완료"라는 숫자를 읽기 **전에**
        그 숫자가 언제 것인지 알아야 하기 때문입니다.

        role="status" + aria-live="polite" 라서 화면을 보지 않는 사용자에게도
        전환 시점에 한 번 읽힙니다(경고음 없이).
      */}
      {offline && (
        <section
          role="status"
          aria-live="polite"
          className="border-line bg-surface-2 rounded-2xl border p-4"
        >
          <p className="text-fg text-sm font-medium">
            <span aria-hidden="true">📴</span> 오프라인 — 마지막으로 본 내용이에요
          </p>
          <p className="text-muted mt-1 text-sm leading-relaxed [word-break:keep-all]">
            {readOnly
              ? '인터넷에 연결돼 있지 않아 저장해 둔 목록을 보여주고 있어요. 지금은 체크하거나 새로 적을 수 없어요.'
              : '인터넷에 연결돼 있지 않아요. 화면은 마지막으로 확인한 내용이고, 지금은 저장할 수 없어요.'}
          </p>
        </section>
      )}

      {/* ---- 진행 요약 ------------------------------------------------- */}
      <section className="border-line bg-surface rounded-2xl border p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-fg text-base font-semibold">오늘 진행</h2>
          <p className="text-muted text-sm tabular-nums">
            {total === 0 ? '0개' : `${doneCount} / ${total}`}
          </p>
        </div>

        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="오늘 할 일 진행률"
          className="bg-surface-2 mt-3 h-2 w-full overflow-hidden rounded-full"
        >
          <div
            className="bg-accent h-full rounded-full transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>

        <p className="text-muted mt-3 text-sm leading-relaxed [word-break:keep-all]">
          {total === 0
            ? '오늘은 아직 적은 게 없어요.'
            : allDone
              ? '오늘 할 일을 전부 끝냈어요. 잘했어요 🎉'
              : `${total - doneCount}개 남았어요.`}
        </p>
      </section>

      {/* ---- 오류 ------------------------------------------------------ */}
      {/*
        낙관적 변경이 되돌아간 이유를 여기서 말합니다. 목록 바로 위에 두는 건
        되돌아간 줄과 설명이 같은 화면 안에 보이게 하기 위해서입니다.
      */}
      {error && (
        <div className="border-danger rounded-2xl border p-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}

      {/* ---- 목록 ------------------------------------------------------ */}
      <section className="border-line bg-surface rounded-2xl border p-5">
        <h2 className="text-fg text-base font-semibold">할 일</h2>

        {readOnly ? (
          /*
            복원본은 정적으로 그립니다. 체크박스도 삭제 버튼도 없습니다 —
            누를 수 있게 해 놓고 저장이 안 되는 것보다, 이번 범위가 읽기
            전용이라는 사실이 화면에 그대로 보이는 편이 정직합니다.
          */
          <ul className="mt-2 flex flex-col">
            {(restored ?? []).map((task) => (
              <RestoredRow key={task.id} task={task} />
            ))}
          </ul>
        ) : total === 0 ? (
          <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
            <p className="text-fg text-sm font-medium">오늘 할 일이 아직 없어요</p>
            <p className="text-muted text-sm leading-relaxed [word-break:keep-all]">
              아래에 오늘 하려는 일을 적어보세요. 아주 작은 것부터 괜찮아요. 적어두면
              같은 그룹 친구들에게도 진행 상황이 보여요.
            </p>
          </div>
        ) : (
          <ul className="mt-2 flex flex-col">
            {optimisticTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onToggle={handleToggle}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}

        {/* ---- 추가 폼 ------------------------------------------------- */}
        {readOnly ? (
          <div className="border-line mt-4 border-t pt-4">
            <Hint>
              연결되면 자동으로 최신 목록을 불러와요. 그때부터 다시 적을 수 있어요.
            </Hint>
          </div>
        ) : (
        /*
          <form action={addTaskFromForm}> 이 아니라 onSubmit 입니다. form action 은
          제출할 때마다 폼을 리셋하면서 포커스를 놓고, 낙관적 목록에 새 줄을 넣을
          자리도 없습니다. 여기서는 입력을 비우고 포커스를 유지하는 쪽이 중요합니다.
        */
        <form onSubmit={handleAdd} className="border-line mt-4 flex gap-2 border-t pt-4">
          <label htmlFor="new-task" className="sr-only">
            새 할 일
          </label>
          {/*
            components/ui.tsx 의 <Input> 대신 직접 씁니다. 저 컴포넌트는 ref 를
            타입에 노출하지 않아서 "제출 후 포커스 유지"를 걸 수 없습니다. 클래스는
            <Input> 과 같은 값이라 생김새는 동일합니다.
            (maxLength 는 UTF-16 단위라 이모지가 섞이면 DB 한도보다 짧게 잘립니다 —
             더 허용하는 쪽이 아니라 덜 허용하는 쪽이라 안전합니다.)
          */}
          <input
            id="new-task"
            ref={inputRef}
            type="text"
            name="title"
            autoComplete="off"
            enterKeyHint="done"
            maxLength={TITLE_MAX}
            placeholder="오늘 할 일 적기"
            className="border-line bg-surface-2 text-fg placeholder:text-muted h-12 w-full min-w-0 flex-1 rounded-xl border px-3 outline-none"
          />
          {/*
            <Button> 은 size='md' 가 h-12 w-full 이라 한 줄에 못 넣고, size='sm' 은
            h-11 이라 입력창과 높이가 어긋납니다. 같은 토큰으로 인라인 버튼을
            만들어 정확히 맞춥니다. 일부러 전송 중에도 비활성화하지 않습니다 —
            연달아 여러 개 적는 게 주 사용 패턴이라, 왕복마다 버튼이 잠기면 흐름이
            끊깁니다.
          */}
          <button
            type="submit"
            className="bg-accent text-accent-fg inline-flex h-12 shrink-0 items-center justify-center rounded-xl px-5 text-base font-medium transition active:scale-[0.99]"
          >
            추가
          </button>
        </form>
        )}

        {showGroupHint && !readOnly && (
          <div className="mt-3">
            <Hint>
              새로 적는 할 일은 <strong className="text-fg">{groupName}</strong> 그룹에
              기록돼요.
            </Hint>
          </div>
        )}
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// 복원된 한 줄 (읽기 전용)
//
// TaskRow 와 생김새를 맞추되 상호작용은 전부 뺐습니다. disabled 체크박스로
// 만들지 않은 이유: 회색으로 눌리는 체크박스는 "지금은 안 되지만 곧 될 것"
// 처럼 보입니다. 여기서는 아예 컨트롤이 아니어야 합니다.
// ---------------------------------------------------------------------------

function RestoredRow({ task }: { task: OfflineTask }) {
  return (
    <li className="border-line flex min-h-14 items-center gap-3 border-b py-3 last:border-b-0">
      <span
        aria-hidden="true"
        className={`grid size-6 shrink-0 place-items-center rounded-md border ${
          task.done ? 'border-accent bg-accent text-accent-fg' : 'border-line text-transparent'
        }`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m5 12.5 4.5 4.5L19 7" />
        </svg>
      </span>
      <span
        className={`min-w-0 flex-1 text-sm leading-relaxed [word-break:keep-all] ${
          task.done ? 'text-muted line-through' : 'text-fg'
        }`}
      >
        {task.title}
        {/* 취소선은 시각적 신호일 뿐이라 스크린 리더에는 들리지 않습니다. */}
        <span className="sr-only">{task.done ? ' (완료)' : ' (미완료)'}</span>
      </span>
    </li>
  )
}

// ---------------------------------------------------------------------------
// 한 줄
// ---------------------------------------------------------------------------

function TaskRow({
  task,
  onToggle,
  onDelete,
}: {
  task: TaskRowView
  onToggle: (task: TaskRowView, done: boolean) => void
  onDelete: (task: TaskRowView) => void
}) {
  // 두 단계 삭제. window.confirm 은 standalone PWA 에서 막히는 경우가 있고 페이지
  // 전체를 얼립니다. components/ui.tsx 의 ConfirmButton 과 같은 인라인 방식이지만,
  // 저건 <form> 안에서만 동작하도록(useFormStatus) 만들어져 있어 여기서는 못 씁니다.
  const [armed, setArmed] = useState(false)

  return (
    <li className="border-line flex flex-col border-b last:border-b-0">
      <div className="flex min-h-14 items-center gap-2">
        <label
          className={`flex min-w-0 flex-1 items-center gap-3 py-3 ${
            task.pending ? 'cursor-default opacity-50' : 'cursor-pointer'
          }`}
        >
          <input
            type="checkbox"
            className="peer sr-only"
            checked={task.done}
            disabled={task.pending}
            onChange={(event) => onToggle(task, event.currentTarget.checked)}
          />
          <span
            aria-hidden="true"
            className={`peer-focus-visible:ring-accent grid size-6 shrink-0 place-items-center rounded-md border transition peer-focus-visible:ring-2 ${
              task.done
                ? 'border-accent bg-accent text-accent-fg'
                : 'border-line text-transparent'
            }`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m5 12.5 4.5 4.5L19 7" />
            </svg>
          </span>
          <span
            className={`min-w-0 flex-1 text-sm leading-relaxed [word-break:keep-all] ${
              task.done ? 'text-muted line-through' : 'text-fg'
            }`}
          >
            {task.title}
          </span>
        </label>

        {!armed && (
          <button
            type="button"
            disabled={task.pending}
            onClick={() => setArmed(true)}
            aria-label={`${task.title} 삭제`}
            className="text-muted inline-flex h-11 shrink-0 items-center rounded-xl px-3 text-sm transition active:scale-[0.99] disabled:opacity-40"
          >
            삭제
          </button>
        )}
      </div>

      {armed && (
        <div className="border-danger mb-3 flex flex-col gap-2 rounded-xl border p-3">
          <p className="text-danger text-sm leading-relaxed [word-break:keep-all]" role="alert">
            이 할 일을 지울까요? 되돌릴 수 없어요.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setArmed(false)
                onDelete(task)
              }}
              className="border-danger text-danger inline-flex h-11 shrink-0 items-center justify-center rounded-xl border px-4 text-sm font-medium transition active:scale-[0.99]"
            >
              네, 지울게요
            </button>
            <button
              type="button"
              onClick={() => setArmed(false)}
              className="border-line bg-surface text-fg inline-flex h-11 shrink-0 items-center justify-center rounded-xl border px-4 text-sm font-medium transition active:scale-[0.99]"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

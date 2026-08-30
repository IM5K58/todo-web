'use client'

import { useOptimistic, useRef, useState, useTransition } from 'react'

import { ErrorText, Hint } from '@/components/ui'

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
      const result = await call()
      if (!result.ok) setError(result.error)
    })
  }

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

  const total = optimisticTasks.length
  const doneCount = optimisticTasks.filter((task) => task.done).length
  const allDone = total > 0 && doneCount === total
  const percent = total === 0 ? 0 : Math.round((doneCount / total) * 100)

  return (
    <>
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

        {total === 0 ? (
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
        {/*
          <form action={addTaskFromForm}> 이 아니라 onSubmit 입니다. form action 은
          제출할 때마다 폼을 리셋하면서 포커스를 놓고, 낙관적 목록에 새 줄을 넣을
          자리도 없습니다. 여기서는 입력을 비우고 포커스를 유지하는 쪽이 중요합니다.
        */}
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

        {showGroupHint && (
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

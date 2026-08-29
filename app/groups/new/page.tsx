import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createGroupAction } from '@/app/groups/actions'
import {
  Button,
  Card,
  ErrorText,
  Hint,
  LinkButton,
  Input,
  ListRow,
  PageHeader,
} from '@/components/ui'
import { createClient } from '@/lib/supabase/server'

/**
 * /groups/new — 그룹 만들기.
 *
 * Server Component. The only interactive thing on the page is the submit
 * button's pending state, and <Button> already gets that from useFormStatus()
 * inside a Server Action <form> — so nothing here needs to be a Client
 * Component, and the form still submits while the JS chunk is in flight.
 *
 * Errors arrive as `?e=<token>` from createGroupAction (see the comment at the
 * top of app/groups/actions.ts for why that channel and not useActionState).
 * The typed name is deliberately NOT echoed back through the URL — a group
 * name is the user's content, and it does not belong in a query string or in
 * anyone's server logs.
 */

export const metadata: Metadata = { title: '그룹 만들기' }

const MAX_GROUP_NAME = 60

/** Errors that belong on the 그룹 이름 field itself. */
const FIELD_ERRORS: Record<string, string> = {
  empty: '그룹 이름을 입력해 주세요.',
  too_long: `그룹 이름은 ${MAX_GROUP_NAME}자까지 쓸 수 있어요.`,
}

/** Errors about the submission as a whole. */
const FORM_ERRORS: Record<string, string> = {
  confirm:
    '이미 참여 중인 그룹이 있어요. 그래도 새로 만들려면 아래 확인란을 체크해 주세요.',
  schema:
    '서버에 그룹 기능이 아직 적용되지 않았어요. 잠시 후 다시 시도하고, 계속 이러면 알려주세요.',
  unknown: '그룹을 만들지 못했어요. 잠시 후 다시 시도해 주세요.',
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function NewGroupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const supabase = await createClient()

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims()
  const userId = claimsData?.claims.sub
  if (claimsError || typeof userId !== 'string' || !userId) {
    redirect('/login?next=%2Fgroups%2Fnew')
  }

  const errorCode = one((await searchParams).e) ?? ''
  const fieldError = FIELD_ERRORS[errorCode] ?? null
  const formError = FORM_ERRORS[errorCode] ?? null

  // ---- 이미 참여 중인 그룹 --------------------------------------------------
  // Read it so the page can say "you already have one" instead of quietly
  // creating a second. This is UI only: createGroupAction re-checks server-side,
  // so a stale page cannot get around the confirmation.
  const { data: memberships, error: membershipError } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)

  const groupIds = (memberships ?? []).map((row) => row.group_id)

  // NEVER select('*') on public.groups: `authenticated` has no column privilege
  // on invite_code, so '*' fails with "permission denied for column
  // invite_code". Name the four readable columns.
  const { data: groups, error: groupsError } =
    groupIds.length > 0
      ? await supabase
          .from('groups')
          .select('id, name, created_by, created_at')
          .in('id', groupIds)
          .order('created_at', { ascending: true })
      : { data: [], error: null }

  // If either read failed we must not claim "그룹이 없어요" — that would be a
  // lie that leads straight to a duplicate group. Say what happened instead,
  // and let the server action be the one that enforces the confirmation.
  const readFailed = Boolean(membershipError || groupsError)
  const existing = groups ?? []
  const hasExisting = existing.length > 0

  return (
    <main className="screen-safe px-safe mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      <PageHeader
        title="그룹 만들기"
        backHref="/"
        backLabel="홈으로"
        description="같이 할 일을 공유할 친구 그룹을 만들어요. 만들면 초대 코드가 생기고, 그 코드를 받은 친구가 들어올 수 있어요."
      />

      {readFailed && (
        <Card>
          <ErrorText>
            지금 참여 중인 그룹을 확인하지 못했어요. 이미 그룹이 있다면 새로 만들기 전에
            먼저 확인해 주세요.
          </ErrorText>
          <LinkButton href="/groups" variant="secondary">
            내 그룹 보기
          </LinkButton>
        </Card>
      )}

      {hasExisting && (
        <Card title="이미 참여 중인 그룹">
          <Hint>
            그룹은 여러 개 만들 수 있지만, 대부분은 하나면 충분해요. 친구를 부르는
            거라면 새 그룹 대신 아래 그룹의 초대 코드를 보내주세요.
          </Hint>
          <div className="flex flex-col">
            {existing.map((group) => (
              <ListRow key={group.id} leading="👥" title={group.name} />
            ))}
          </div>
          <LinkButton href="/groups" variant="secondary">
            초대 코드 보러 가기
          </LinkButton>
        </Card>
      )}

      <Card title="새 그룹">
        <form action={createGroupAction} className="flex flex-col gap-4">
          {formError && <ErrorText>{formError}</ErrorText>}

          <Input
            name="name"
            label="그룹 이름"
            placeholder="예: 아침형 인간 도전방"
            maxLength={MAX_GROUP_NAME}
            required
            autoComplete="off"
            enterKeyHint="done"
            error={fieldError}
            hint={`${MAX_GROUP_NAME}자까지 쓸 수 있어요. 나중에 바꿀 수 있어요.`}
          />

          {hasExisting && (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                name="confirm"
                className="accent-accent mt-0.5 size-6 shrink-0"
              />
              <span className="text-fg text-sm leading-relaxed [word-break:keep-all]">
                이미 참여 중인 그룹이 있다는 걸 알아요. 그래도 새 그룹을 만들래요.
              </span>
            </label>
          )}

          <Button type="submit" pendingLabel="만드는 중…">
            그룹 만들기
          </Button>
        </form>

        <Hint>
          만든 사람이 그룹의 소유자가 돼요. 소유자만 초대 코드를 보거나 새로 만들 수
          있어요.
        </Hint>
      </Card>

      <p className="text-muted text-center text-sm [word-break:keep-all]">
        초대 코드를 받았나요?{' '}
        <Link href="/groups/join" className="text-accent underline underline-offset-4">
          코드로 참여하기
        </Link>
      </p>
    </main>
  )
}

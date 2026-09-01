import Link from 'next/link'

import { Screen } from '@/components/screen'
import {
  Button,
  Card,
  ErrorText,
  Hint,
  Label,
  LinkButton,
  PageHeader,
  SuccessText,
} from '@/components/ui'
import { requireUserId } from '@/lib/auth'
import { messageFor } from '@/lib/search-params'
import { getMyGroups } from '@/lib/tasks'

import {
  PLEDGE_BODY_MAX,
  amIAppAdmin,
  pledgeLength,
  readGroupPledge,
} from '../group-pledge'
import { savePledgeAction, type PledgeErrCode, type PledgeOkCode } from './actions'

/**
 * /pledge — 그룹 공약 작성·수정.
 *
 * Server Component. 홈의 <GroupPledge> 카드가 여기로 보내고, 저장이 끝나면
 * `?g=<그룹>&ok=…` 를 달고 이 화면으로 되돌아옵니다.
 *
 * ---------------------------------------------------------------------------
 * 어느 그룹의 공약인가 — 이 화면이 가장 조심해야 할 것
 * ---------------------------------------------------------------------------
 * 사람이 그룹을 여러 개 가질 수 있고, 공약은 그룹당 한 줄입니다(group_id
 * UNIQUE). 그래서 "어느 그룹" 이 애매한 상태로는 편집 폼을 절대 그리지
 * 않습니다. 순서는 이렇습니다:
 *
 *   1. `?g=` 가 내가 속한 그룹이면 그 그룹.
 *   2. `?g=` 가 없고 내 그룹이 딱 하나면 그 그룹 (고를 것이 없습니다).
 *   3. 그 밖에는 **고르는 화면**을 그립니다. 폼은 없습니다.
 *
 * 그리고 고른 뒤에도 제목과 폼 안내에 그룹 이름을 계속 적어 둡니다 — 두 그룹의
 * 공약을 헷갈려 덮어쓰면 되돌릴 방법이 없습니다.
 *
 * 목록은 getMyGroups() 로 읽습니다. 그러면 "내가 속한 그룹인가" 를 여기서 따로
 * 판정하지 않아도 되고(RLS 가 이미 걸러 줍니다), 이름도 함께 옵니다.
 *
 * ---------------------------------------------------------------------------
 * ★ 관리자가 아니면 편집 UI 를 렌더하지 않습니다 ★
 * ---------------------------------------------------------------------------
 * set_group_pledge() 는 비관리자의 호출을 예외 없이 **조용히 무시**합니다
 * (0009 ⑤-d). 폼을 보여 주면 "저장했는데 안 바뀐다" 가 됩니다. 그래서
 * public.am_i_admin() 이 false 면 이 화면은 읽기 전용입니다 — 공약은 그대로
 * 보여 주되(같은 그룹 멤버는 읽을 수 있습니다) 입력칸도 저장 버튼도 없습니다.
 *
 * 이건 화면 쪽 예의일 뿐이고 보안 경계가 아닙니다. 경계는 언제나 RPC 안의
 * private.is_app_admin() 입니다.
 *
 * ---------------------------------------------------------------------------
 * 저장 결과를 어떻게 정직하게 말하는가
 * ---------------------------------------------------------------------------
 * set_group_pledge 는 `returns void` 라 반환값으로 성공을 알 수 없습니다.
 * 그래서 (a) 액션이 RPC 직후 다시 읽어 실제 반영 여부를 확인하고,
 * (b) 이 페이지도 매번 group_pledges 를 다시 읽어 **DB 에 있는 문장**을
 * textarea 의 defaultValue 로 씁니다. 화면에 보이는 글자는 항상 저장된 글자
 * 입니다 — 방금 입력한 글자를 되비추지 않습니다.
 */

// ---------------------------------------------------------------------------
// 안내 문구
// ---------------------------------------------------------------------------

const OK_MESSAGES: Record<PledgeOkCode, string> = {
  saved: '공약을 저장했어요. 이제 홈에서 모두에게 보여요.',
  deleted: '공약을 지웠어요. 홈에서 더 이상 보이지 않아요.',
}

const ERR_MESSAGES: Record<PledgeErrCode, string> = {
  badrequest: '어느 그룹의 공약인지 알 수 없었어요. 그룹을 다시 골라 주세요.',
  toolong: `공약이 너무 길어요. ${PLEDGE_BODY_MAX}자까지 쓸 수 있어요.`,
  auth: '로그인이 풀렸어요. 앱을 새로고침한 뒤 다시 시도해 주세요.',
  notdeployed: '공약 기능이 아직 준비되지 않았어요. 잠시 후 다시 시도해 주세요.',
  ignored:
    '저장되지 않았어요. 이 그룹의 공약을 정할 권한이 없거나, 그룹에서 나온 상태예요.',
  unconfirmed:
    '저장했는지 확인하지 못했어요. 아래에 보이는 글이 지금 저장되어 있는 공약이에요.',
  fail: '저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
}

const BACK_LABEL = '홈으로'

// ---------------------------------------------------------------------------
// 화면 조각
// ---------------------------------------------------------------------------

/** 공약 본문을 그대로 보여 주는 문단. 줄바꿈이 의미를 갖습니다. */
function PledgeBody({ body }: { body: string }) {
  return (
    <p className="text-fg text-sm leading-relaxed whitespace-pre-wrap [word-break:keep-all]">
      {body}
    </p>
  )
}

function Notices({ ok, err }: { ok: string | null; err: string | null }) {
  return (
    <>
      <SuccessText>{ok}</SuccessText>
      <ErrorText>{err}</ErrorText>
    </>
  )
}

// ---------------------------------------------------------------------------
// 페이지
// ---------------------------------------------------------------------------

export default async function PledgePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const okMessage = messageFor(OK_MESSAGES, params.ok)
  const errMessage = messageFor(ERR_MESSAGES, params.err)

  // ?g= 는 홈이 쓰는 것과 같은 규약입니다. 로그인이 풀렸으면 /pledge 로 돌아
  // 오게만 합니다 — ?g= 까지 끌고 가 봐야 그룹은 아래에서 다시 고르게 됩니다.
  const { supabase, userId } = await requireUserId('/login?next=%2Fpledge')

  const { groups, error: groupsError } = await getMyGroups(userId)

  if (groupsError) {
    return (
      <Screen>
        <PageHeader title="그룹 공약" backHref="/" backLabel={BACK_LABEL} />
        <Card>
          <ErrorText>{groupsError}</ErrorText>
          {/*
            <Link>/LinkButton 이 아니라 평범한 <a> 입니다. 지금 있는 URL 로의
            클라이언트 이동은 라우터 캐시에서 그대로 서빙될 수 있어서, 다시
            시도가 아무 일도 하지 않는 버튼이 됩니다(app/page.tsx 와 같은 이유).
          */}
          <a
            href="/pledge"
            className="border-line bg-surface text-fg inline-flex h-12 w-full shrink-0 items-center justify-center rounded-xl border px-4 text-base font-medium transition active:scale-[0.99]"
          >
            다시 시도하기
          </a>
        </Card>
      </Screen>
    )
  }

  if (groups.length === 0) {
    return (
      <Screen>
        <PageHeader
          title="그룹 공약"
          backHref="/"
          backLabel={BACK_LABEL}
          description="공약은 그룹마다 하나씩 정할 수 있어요."
        />
        <Card>
          <Hint>아직 속한 그룹이 없어요. 그룹을 먼저 만들거나 초대 코드로 들어가 주세요.</Hint>
          <LinkButton href="/groups">내 그룹 보기</LinkButton>
        </Card>
      </Screen>
    )
  }

  // ── 어느 그룹인가 ────────────────────────────────────────────────────────
  const requestedId = typeof params.g === 'string' ? params.g : null
  const requested = requestedId ? groups.find((group) => group.id === requestedId) : undefined
  const group = requested ?? (groups.length === 1 ? groups[0] : undefined)

  if (!group) {
    return (
      <Screen>
        <PageHeader
          title="그룹 공약"
          backHref="/"
          backLabel={BACK_LABEL}
          description="공약은 그룹마다 하나씩이에요. 어느 그룹의 공약을 볼지 골라 주세요."
        />

        <Notices ok={okMessage} err={errMessage} />

        {/*
          ?g= 가 있었는데 목록에 없다 = 내가 속하지 않은 그룹이거나 사라진 그룹
          입니다. 어느 쪽인지는 알려 주지 않습니다(RLS 가 그 차이를 감추는 것이
          0009 의 의도입니다). 다만 "골라 준 것이 무시됐다" 는 말해 줍니다.
        */}
        {requestedId && (
          <ErrorText>그 그룹을 찾지 못했어요. 아래에서 다시 골라 주세요.</ErrorText>
        )}

        <Card title="내 그룹">
          <ul className="flex flex-col">
            {groups.map((item) => (
              <li key={item.id} className="border-line border-b last:border-b-0">
                <Link
                  href={`/pledge?g=${encodeURIComponent(item.id)}`}
                  className="flex min-h-14 items-center gap-3 py-2"
                >
                  <span className="text-fg min-w-0 flex-1 truncate text-sm font-medium">
                    {item.name}
                  </span>
                  <span aria-hidden="true" className="text-muted shrink-0 text-sm">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </Screen>
    )
  }

  // ── 공약 + 권한 (서로를 기다릴 이유가 없으므로 한 파에) ──────────────────
  const [pledge, isAdmin] = await Promise.all([
    readGroupPledge(supabase, group.id),
    amIAppAdmin(supabase),
  ])

  const header = (
    <PageHeader
      title="그룹 공약"
      backHref={`/?g=${encodeURIComponent(group.id)}`}
      backLabel={BACK_LABEL}
      description={
        <>
          <strong className="text-fg font-medium">{group.name}</strong> 그룹의 공약이에요.
          {groups.length > 1 && ' 그룹마다 따로 정해요.'}
        </>
      }
    />
  )

  if (pledge.state !== 'ok') {
    const message =
      pledge.state === 'undeployed'
        ? '공약 기능이 아직 준비되지 않았어요. 잠시 후 다시 시도해 주세요.'
        : pledge.message

    return (
      <Screen>
        {header}
        <Notices ok={okMessage} err={errMessage} />
        <Card>
          <ErrorText>{message}</ErrorText>
        </Card>
      </Screen>
    )
  }

  const body = pledge.body

  // ── 관리자가 아니면 읽기 전용 ────────────────────────────────────────────
  if (!isAdmin) {
    return (
      <Screen>
        {header}
        <Notices ok={okMessage} err={errMessage} />
        <Card title={`${group.name}의 공약`}>
          {body === null ? (
            <Hint>아직 이 그룹의 공약이 없어요.</Hint>
          ) : (
            <PledgeBody body={body} />
          )}
          <Hint>공약은 운영자만 정하거나 고칠 수 있어요.</Hint>
        </Card>
      </Screen>
    )
  }

  const currentLength = body === null ? 0 : pledgeLength(body)

  return (
    <Screen>
      {header}
      <Notices ok={okMessage} err={errMessage} />

      <Card title={body === null ? '공약 정하기' : '공약 고치기'}>
        <form action={savePledgeAction} className="flex flex-col gap-3">
          {/*
            어느 그룹인지는 URL 이 아니라 이 필드가 실어 나릅니다. 액션은 이 값을
            권한 근거로 쓰지 않습니다 — 관리자 판정도 멤버십 판정도 전부
            set_group_pledge() 안에서 일어납니다(0009 ⑤-d).
          */}
          <input type="hidden" name="groupId" value={group.id} />

          <Label htmlFor="pledge-body">{group.name} 그룹의 공약</Label>

          {/*
            maxLength 를 걸지 않습니다. HTML 의 maxLength 는 UTF-16 코드 유닛을
            세기 때문에 이모지가 섞이면 DB 가 허용하는 길이보다 먼저 입력을
            막습니다. 길이 판정은 코드 포인트를 세는 액션(pledgeLength)이 하고,
            넘치면 정직하게 말합니다.
          */}
          <textarea
            id="pledge-body"
            name="body"
            rows={8}
            defaultValue={body ?? ''}
            placeholder="예) 우리는 매일 밤 11시 전에 오늘 할 일을 체크한다."
            aria-describedby="pledge-body-hint"
            className="border-line bg-surface-2 text-fg placeholder:text-muted w-full resize-y rounded-xl border px-3 py-3 leading-relaxed outline-none disabled:opacity-40"
          />

          <div id="pledge-body-hint" className="flex flex-col gap-1">
            {/*
              0009 의 CHECK 상한 그대로 적습니다:
                check (char_length(btrim(body)) between 1 and 2000)
            */}
            <Hint>
              최대 {PLEDGE_BODY_MAX}자까지 쓸 수 있어요. 지금 저장된 공약은{' '}
              {currentLength}자예요.
            </Hint>
            {/*
              ★ 0009 를 읽고 확인한 사실 ★
              set_group_pledge 는 본문이 NULL 이거나 공백뿐이면 UPDATE 가 아니라
              DELETE 를 합니다. 그러니 "빈 칸 저장 = 초기화" 가 아니라 "삭제"
              라고 정확히 적어야 합니다. 되돌리기는 없습니다.
            */}
            <Hint>
              내용을 모두 지우고 저장하면 이 그룹의 공약이 삭제돼요. 되돌릴 수 없으니
              한 번 더 확인해 주세요.
            </Hint>
          </div>

          <Button type="submit" pendingLabel="저장 중…">
            저장하기
          </Button>
        </form>
      </Card>

      {body !== null && (
        <Card title="지금 홈에 보이는 공약">
          <PledgeBody body={body} />
          <Hint>
            방금 입력한 글이 아니라, 지금 저장되어 있는 글이에요. 저장한 뒤에 바뀝니다.
          </Hint>
        </Card>
      )}
    </Screen>
  )
}

# 셋업 안내

제가 대신 할 수 없는 단계만 모았습니다. 계정 로그인이 필요한 것들입니다.

---

## 1. Supabase 프로젝트 만들기

1. https://supabase.com 접속 → GitHub 계정으로 로그인
2. **New project** 클릭
3. 입력값
   - **Name**: `daily-todo-pwa`
   - **Database Password**: 아무거나 강한 걸로. **어딘가 저장해두세요** — 다시 못 봅니다
   - **Region**: `Northeast Asia (Seoul)` ← 한국에서 쓰니 서울
   - **Plan**: Free
4. 생성에 1~2분 걸립니다

## 2. API 키를 `.env.local`에 복사

프로젝트 대시보드 → 좌측 하단 **Project Settings** → **API**

| 대시보드 항목 | `.env.local` 변수 |
|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` |
| `anon` `public` 키 | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `service_role` `secret` 키 | `SUPABASE_SERVICE_ROLE_KEY` |

> ⚠️ `service_role` 키는 RLS를 전부 우회합니다. 절대 클라이언트 코드에서
> import하지 마세요. `NEXT_PUBLIC_` 접두사를 붙이면 브라우저 번들에 그대로
> 실려서 누구나 전체 DB를 읽고 씁니다.

## 3. 마이그레이션 실행

대시보드 → **SQL Editor** → **New query**

`supabase/migrations/` 안의 파일을 **번호 순서대로** 붙여넣고 각각 실행:

1. `0001_init.sql` — 테이블·인덱스·트리거
2. `0002_rls.sql` — 접근 제어 정책

각 실행 후 `Success. No rows returned`가 나오면 정상입니다.

## 4. 인증 설정 (매직링크)

대시보드 → **Authentication** → **Providers**

- **Email** 켜기
- **Confirm email** 켜두기
- **Secure email change** 켜두기

그다음 **Authentication** → **URL Configuration**

| 항목 | 값 |
|---|---|
| Site URL | `http://localhost:3000` |
| Redirect URLs | `http://localhost:3000/auth/callback` |

배포 후에는 실제 도메인을 **추가**하세요 (기존 것을 지우지 말고 둘 다 두면 로컬 개발이 계속 됩니다).

> Free 티어 메일은 시간당 발송 한도가 낮습니다. 친구 몇 명 테스트에는 충분하지만,
> 매직링크가 안 오면 스팸함부터 확인하세요.

## 5. Vercel 배포 — Phase 4 이후에

지금은 안 하셔도 됩니다. 로컬에서 `npm run dev`로 충분해요.

배포할 때가 되면:

1. 이 폴더를 GitHub 저장소로 push
2. https://vercel.com → **Add New Project** → 저장소 선택
3. **Environment Variables**에 `.env.local` 내용을 전부 등록
   (`NEXT_PUBLIC_SITE_URL`만 실제 도메인으로 바꿔서)
4. Deploy

> **푸시 알림은 HTTPS에서만 동작합니다.** `localhost`는 예외로 허용되지만,
> 폰에서 로컬 개발서버(`192.168.x.x`)로 접속하면 푸시가 막힙니다.
> 실기기 푸시 테스트는 Vercel 배포 후에 하세요.

## 6. 아이폰에서 알림 받기 — 친구들에게 공유할 안내

아이폰은 **홈 화면에 추가해야만** 알림이 옵니다. 사파리에서 그냥 보면 안 옵니다.

1. **사파리로** 사이트 접속 (크롬 말고 사파리)
2. 하단 **공유 버튼** (□↑) 탭
3. **홈 화면에 추가** 탭
4. **홈 화면의 아이콘으로** 앱 실행
5. 앱 안에서 **알림 켜기** 탭 → 허용

iOS 16.4 이상이 필요합니다. 설정 → 일반 → 정보에서 버전 확인.

> 한 번 **거부**하면 앱 안에서 다시 물어볼 수 없습니다.
> 설정 → 알림에서 직접 켜야 하니, 친구들에게 미리 알려주세요.

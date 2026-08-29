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

## 4. 인증 설정 (구글 로그인)

이메일 매직링크는 없앴습니다. 이제 **구글 계정으로만** 로그인합니다.

구글 **클라이언트 ID / 시크릿은 앱 코드에도 `.env.local`에도 넣지 않습니다.**
Supabase 대시보드에만 저장됩니다. 그래서 이 섹션에서 추가되는 환경변수는 없습니다.

전체 흐름은 이렇게 생겼습니다. 어느 주소를 어디에 넣는지 헷갈릴 때 돌아와서 보세요.

```
우리 앱 (/login)
  → accounts.google.com                       (구글 로그인 화면)
  → https://<REF>.supabase.co/auth/v1/callback ← 4-A-7 "승인된 리디렉션 URI"에 넣는 값
  → https://내도메인.com/auth/callback          ← 4-C-2 "Redirect URLs"에 넣는 값
  → 우리 앱 (/)
```

---

### 4-A. Google Cloud Console

프로젝트가 없으면 먼저 새 프로젝트를 하나 만듭니다.

1. **동의 화면 (OAuth Consent Screen)**
   - https://console.cloud.google.com/apis/credentials/consent
   - 앱 이름 / 사용자 지원 이메일 / 개발자 연락처 이메일을 채웁니다.

2. **대상 (Audience)**
   - https://console.cloud.google.com/auth/audience
   - 친구들끼리 쓰는 앱이라 **External(외부)** 로 두고 **게시(Publish)는 하지 않습니다.**
   - 대신 **테스트 사용자**에 친구들 구글 계정을 **전부** 추가합니다.
     테스트 모드에서는 여기 없는 계정은 로그인이 막힙니다 (`access_denied`).
   - 사람이 추가될 때마다 여기에 계정을 넣어야 한다는 걸 기억해두세요.

3. **데이터 액세스 (Scopes)**
   - https://console.cloud.google.com/auth/scopes
   - 아래 3개만 있으면 됩니다.
     - `openid` ← 직접 추가해야 합니다
     - `.../auth/userinfo.email` ← 기본 포함
     - `.../auth/userinfo.profile` ← 기본 포함
   - **더 넣지 마세요.** 민감(sensitive) 범위를 넣는 순간 구글 검수 대상이 됩니다.

4. **브랜딩 (Branding)** — 선택
   - https://console.cloud.google.com/auth/branding
   - 여기에 앱 이름과 로고를 넣으면 동의 화면에 Supabase 프로젝트 ID
     (`abcdefgh.supabase.co`) 대신 앱 이름이 보입니다. 검수에 며칠 걸리니
     급하면 나중에 해도 됩니다.

5. **OAuth 클라이언트 만들기**
   - https://console.cloud.google.com/auth/clients/create
   - 애플리케이션 유형: **웹 애플리케이션 (Web application)**
   - 이름: 아무거나 (`daily-todo-web`)

6. **승인된 자바스크립트 원본 (Authorized JavaScript origins)**
   - 여기는 **우리 앱 주소**입니다. 경로(`/`) 없이 origin만 넣습니다.

   | 언제 | 값 |
   |---|---|
   | 로컬 개발 | `http://localhost:3000` |
   | 배포 | `https://내도메인.com` |

   - 둘 다 넣어두면 로컬과 배포가 같이 됩니다.
   - 배포가 끝나고 로컬 개발을 안 하게 되면 `localhost` 항목은 지우세요.

7. **승인된 리디렉션 URI (Authorized redirect URIs)** ⚠️ **여기가 제일 많이 틀립니다**
   - 여기 넣는 건 **우리 앱 주소가 아니라 Supabase 주소**입니다.

   | 언제 | 값 |
   |---|---|
   | 원격 Supabase (로컬 개발·배포 **공통**) | `https://<프로젝트-REF>.supabase.co/auth/v1/callback` |
   | 로컬 Supabase(`supabase start`)를 쓸 때만 | `http://127.0.0.1:54321/auth/v1/callback` |

   - `<프로젝트-REF>`는 2번에서 복사한 Project URL의 그 문자열입니다
     (`https://abcdefghijklm.supabase.co` → `abcdefghijklm`).
   - 정확한 값은 Supabase 대시보드 → **Authentication → Providers → Google**
     페이지 맨 아래 **"Callback URL (for OAuth)"** 에 그대로 적혀 있습니다.
     **손으로 치지 말고 복사해서 붙여넣으세요.**
   - ❌ `https://내도메인.com/auth/callback` 은 여기 넣는 게 **아닙니다.**
     그건 아래 4-C-2 (Supabase의 Redirect URLs)에 넣습니다.
     둘이 이름이 비슷해서 계속 헷갈립니다. 위의 흐름도를 보세요.
   - ❌ `http://localhost:3000/auth/callback` 도 여기 넣는 게 아닙니다.
     로컬 개발이어도 구글은 **항상 Supabase로 먼저** 돌아옵니다.

8. **만들기**를 누르고 **클라이언트 ID**와 **클라이언트 보안 비밀번호(Client Secret)**
   를 복사합니다. (시크릿은 나중에 다시 볼 수 있지만, 지금 복사해두는 게 편합니다.)

---

### 4-B. Supabase 대시보드 — Google 공급자 켜기

**Authentication → Providers → Google**

1. **Enable Sign in with Google** 켜기
2. **Client ID** 붙여넣기 (4-A-8)
3. **Client Secret** 붙여넣기 (4-A-8)
4. **Save**

같은 페이지 아래쪽의 **Callback URL (for OAuth)** 가 4-A-7에 넣은 값과
글자 하나까지 같은지 여기서 한 번 더 확인하세요.

**Email 공급자는 꺼도 됩니다.** (Authentication → Providers → Email)
앱이 더 이상 `signInWithOtp`를 호출하지 않습니다. 켜둬도 해는 없지만,
안 쓰는 로그인 경로는 닫아두는 쪽이 낫습니다.

---

### 4-C. Supabase 대시보드 — URL 설정 ⚠️ 빠뜨리면 로그인 후 안 돌아옵니다

**Authentication → URL Configuration**

1. **Site URL** — 하나만 넣습니다.

   | 언제 | 값 |
   |---|---|
   | 배포 전 | `http://localhost:3000` |
   | 배포 후 | `https://내도메인.com` |

   배포 후에는 **반드시 실제 도메인으로 바꾸세요.** `localhost`로 남겨두면
   허용 목록에 없는 주소로 튕겼을 때 사용자가 로컬호스트로 보내집니다.

2. **Redirect URLs** — 아래를 **전부** 추가합니다 (여러 줄, 다 넣어도 됩니다).

   ```
   http://localhost:3000/auth/callback
   http://localhost:3000/auth/callback?**
   https://내도메인.com/auth/callback
   https://내도메인.com/auth/callback?**
   ```

   - **`?**` 항목이 왜 따로 필요한가**: Supabase는 `redirect_to` 값을 이 목록과
     **문자열 전체로 glob 매칭**합니다. 로그인이 필요한 페이지로 바로 들어가면
     앱이 `/auth/callback?next=/settings` 를 보내는데, `?**` 항목이 없으면
     매칭에 실패해서 Site URL로 튕깁니다. 로그인은 되는데 원래 보던 화면으로
     안 돌아가는 증상이 나오면 십중팔구 이겁니다.
   - 와일드카드 규칙: `*` 는 `.` 과 `/` 를 뺀 문자열, `**` 는 모든 문자열.
   - 로컬 항목은 배포 후에도 남겨두면 로컬 개발이 계속 됩니다.

---

### 4-D. 배포 도메인은 하나로 고정하세요 ⚠️ 아이폰에서 터집니다

`.env.local` / Vercel 환경변수의

```
NEXT_PUBLIC_SITE_URL=https://내도메인.com
```

이 값은 **사용자가 홈 화면에 앱을 설치할 때 쓴 주소와 글자 하나까지 같아야 합니다.**

- apex(`내도메인.com`)와 `www.내도메인.com` 중 **하나만** 쓰고 나머지는 301로 넘기세요.
- 미리보기(preview) 주소(`*-git-*.vercel.app`)에서는 아무도 설치하지 않게 하세요.

이유는 바로 아래 4-E에 있습니다.

---

### 4-E. 아이폰 홈 화면 앱에서의 로그인 ⚠️ 이 섹션이 제일 중요합니다

푸시 알림은 **홈 화면에 설치한 앱 안에서만** 동작합니다 (iOS 16.4+).
그래서 로그인이 앱 밖으로 새어나가면 알림 기능 전체가 죽습니다.

**지금 어떻게 동작하냐면**

iOS 12부터, 설치된 앱에서 manifest의 `scope` 바깥 주소로 이동하면 Safari 앱으로
튕기는 게 아니라 **앱 안에서 인앱 브라우저 시트**가 열립니다. 구글 로그인이 그
시트 안에서 진행되고, 마지막 주소가 다시 `scope` 안으로 들어오면 시트가 닫히면서
원래 앱 창으로 돌아옵니다. 그래서 정상 동작합니다.

**돌아오지 못하는 경우는 전부 "주소 불일치"가 원인입니다**

- `public/manifest.json` 의 `"scope": "/"` 가 없을 때
  → 지금 들어 있습니다. **절대 지우지 마세요.**
- 로그인이 끝난 주소가 설치한 주소와 다를 때 (apex vs www, 미리보기 도메인 등)
  → 4-D를 지키세요.

**친구들에게 알려줄 순서 — 이 순서를 꼭 지켜야 합니다**

1. **사파리로** `https://내도메인.com` 열기 (크롬 말고 사파리)
2. 하단 **공유 버튼** (□↑) → **홈 화면에 추가**
3. **홈 화면 아이콘으로 앱을 연 다음**, 그 안에서 구글 로그인
4. 앱 안에서 알림 켜기 → 허용

> ❗ **사파리에서 먼저 로그인해도 소용없습니다.** iOS는 사파리와 설치된 앱의
> 쿠키·저장소·서비스워커를 **공유하지 않습니다.** 설치된 앱 안에서 한 번 더
> 로그인해야 합니다. 로그인 화면이 아이폰 사파리를 감지하면 이 안내를 직접
> 띄워주긴 하지만, 공유할 때 미리 알려주는 편이 낫습니다.

**개발자가 하면 안 되는 것**

- `window.open()` / `target="_blank"` 로 로그인 창 열기 → iOS PWA에서 조용히 막힙니다
- `skipBrowserRedirect: true` 후 직접 이동시키기 → 같은 이유로 안 됩니다
- `redirectTo` 를 `NEXT_PUBLIC_SITE_URL` 로 만들기 → 설치 주소와 다르면 시트에 갇힙니다.
  코드는 `window.location.origin` 을 씁니다. 바꾸지 마세요.
- iOS에서만 `<link rel="manifest">` 를 떼는 옛날 우회법 → 설치가 안 되고,
  설치가 안 되면 푸시가 영영 안 옵니다

**확인은 시뮬레이터 말고 실기기로** 하세요. 시뮬레이터는 동작이 다릅니다.

---

### 4-F. 동작 확인 체크리스트

- [ ] 데스크톱 크롬 `localhost:3000` → **구글로 로그인** → `/` 로 복귀
- [ ] 로그인 안 한 상태로 `/settings` 접근 → `/login?next=/settings` →
      로그인 후 **`/settings` 로 복귀** (4-C-2의 `?**` 항목 검증)
- [ ] 구글 동의 화면에서 **취소** → `구글 로그인을 취소했어요` 문구가 뜨는지
- [ ] 테스트 사용자에 없는 구글 계정으로 시도 → 막히는지 (4-A-2 검증)
- [ ] 실제 아이폰: 홈 화면 설치 → **앱 안에서** 로그인 → **앱 창으로 복귀**
- [ ] 로그인 후 알림 허용 → 테스트 푸시 수신

**자주 나오는 에러**

| 증상 | 원인 |
|---|---|
| 구글이 `redirect_uri_mismatch` 를 띄움 | 4-A-7. Supabase의 `/auth/v1/callback` 이 안 들어갔거나 오타 |
| 로그인은 되는데 항상 `/` 로만 감 | 4-C-2 의 `?**` 항목 누락 |
| `access_denied` | 4-A-2 테스트 사용자에 그 계정이 없음 |
| 아이폰에서 브라우저 시트에 갇힘 | 4-D. 설치 주소와 최종 주소가 다름 |
| `로그인을 시작한 창과 끝낸 창이 달라요` | 사파리에서 시작해 앱에서 끝냈거나 그 반대 (4-E) |

## 5. Vercel 배포 — Phase 4 이후에

지금은 안 하셔도 됩니다. 로컬에서 `npm run dev`로 충분해요.

배포할 때가 되면:

1. 이 폴더를 GitHub 저장소로 push
2. https://vercel.com → **Add New Project** → 저장소 선택
3. **Environment Variables**에 `.env.local` 내용을 전부 등록
   (`NEXT_PUBLIC_SITE_URL`만 실제 도메인으로 바꿔서 — 4-D 참고)
4. Deploy
5. 배포 주소가 정해지면 **4번 섹션으로 돌아가서** 아래 3곳에 도메인을 추가:
   - 4-A-6 Google Cloud → 승인된 자바스크립트 원본
   - 4-C-1 Supabase → Site URL (localhost에서 실제 도메인으로 **교체**)
   - 4-C-2 Supabase → Redirect URLs (`/auth/callback` 과 `/auth/callback?**` 둘 다 **추가**)

   4-A-7(구글의 승인된 리디렉션 URI)은 **건드리지 않습니다.** 거기는 Supabase
   주소라서 우리 도메인이 뭐가 되든 그대로입니다.

> **푸시 알림은 HTTPS에서만 동작합니다.** `localhost`는 예외로 허용되지만,
> 폰에서 로컬 개발서버(`192.168.x.x`)로 접속하면 푸시가 막힙니다.
> 실기기 푸시 테스트는 Vercel 배포 후에 하세요.

## 6. 자동 리마인더 스케줄러 — Vercel 배포 후에

각자 정한 시각(예: 21:00)에 "오늘 할 일 아직 남았어요" 알림을 보내는 부분입니다.
**설정 화면에서 켠 사람에게만** 갑니다. 기본값은 꺼짐이에요.

### 왜 Vercel Cron을 안 쓰나

Vercel 무료(Hobby) 플랜의 cron은 **하루 1회**만 되고, 실행 시각도 **±59분** 오차가
있습니다. 게다가 `*/5 * * * *` 같은 표현식은 배포 자체가 실패합니다.
"21시에 알려줘"에는 쓸 수 없어서 Supabase의 `pg_cron`을 씁니다. 무료 티어에서
플랜 제한 없이 됩니다.

### 6-A. 확장 켜기

대시보드 → **Database** → **Extensions** 에서 검색해 켜세요.

| 확장 | 스키마 | 역할 |
|---|---|---|
| `pg_cron` | `pg_catalog` | 5분마다 깨우기 |
| `pg_net` | `extensions` | Vercel 라우트로 HTTP 요청 |

### 6-B. 비밀값 저장

이 엔드포인트는 인터넷에 열려 있으므로 공유 비밀로 보호합니다.
`.env.local`의 `CRON_SECRET` 값을 두 군데에 넣으세요.

1. **Vercel** → 프로젝트 → Settings → Environment Variables →
   `CRON_SECRET` (Production)
2. **Supabase** → SQL Editor에서 Vault에 저장:

```sql
select vault.create_secret(
  '여기에_CRON_SECRET_값',
  'cron_secret',
  '/api/cron/auto-nudge 용 Bearer 토큰');
```

> Vault를 쓰는 이유는 `cron.schedule`의 명령 문자열에 비밀값을 그대로 박으면
> `cron.job` 테이블을 읽을 수 있는 사람에게 전부 노출되기 때문입니다.

### 6-C. 스케줄 등록

`supabase/migrations/0003_auto_nudge.sql` **맨 아래 주석 블록**에 필요한 SQL이
전부 들어 있습니다. `<내앱주소>`를 실제 Vercel 도메인으로 바꿔서 주석을 풀고
SQL Editor에서 실행하세요.

핵심은 이렇게 생겼습니다:

```sql
select cron.schedule(
  'auto-nudges',
  '*/5 * * * *',
  $cron$select private.dispatch_auto_nudges()$cron$);
```

또 하나, `cron.job_run_details` 는 자동으로 지워지지 않습니다. 5분마다 도는
job 이면 연 10만 행이 넘어 무료 500MB 를 갉아먹으니, 마이그레이션 주석의
`cron-log-prune` job 도 같이 등록하세요.

5분마다 도는 이유는 설정 화면의 시각 선택이 5분 단위이기 때문입니다.
한국은 UTC+9 정각 오프셋이고 서머타임이 없어서, UTC 5분 경계가 한국시간
5분 경계와 정확히 일치합니다. 오차가 생기지 않아요.

### 6-D. 동작 확인

```sql
-- 최근 실행 이력
select * from cron.job_run_details order by start_time desc limit 10;

-- pg_net 응답 (6시간 후 자동 삭제됨)
select id, status_code, created from net._http_response order by created desc limit 10;
```

`status_code`가 **200**이면 정상입니다.

| 코드 | 원인 |
|---|---|
| 401 | `CRON_SECRET`이 Vercel과 Vault에서 서로 다름 |
| 404 | 앱 주소 오타, 또는 아직 배포 안 됨 |
| 없음 | `timeout_milliseconds`가 너무 짧음 (30000 권장 — Vercel 콜드 스타트) |

> 하루에 288번 돌지만 보낼 사람이 없으면 인덱스 조회 한 번으로 끝나고 HTTP는
> 아예 나가지 않습니다. 무료 티어에서 부담되는 양이 아닙니다.

> 알림이 중복 발송되지 않는 이유는 `auto_nudge_last_on` 컬럼 때문입니다.
> 하루에 한 번 보내면 그날치는 다시 안 갑니다. 반대로 5분 틱을 한 번 놓쳐도
> 다음 틱이 이어받아서, 늦게 갈지언정 안 가지는 않습니다.

## 7. 아이폰에서 알림 받기 — 친구들에게 공유할 안내

아이폰은 **홈 화면에 추가해야만** 알림이 옵니다. 사파리에서 그냥 보면 안 옵니다.

1. **사파리로** 사이트 접속 (크롬 말고 사파리)
2. 하단 **공유 버튼** (□↑) 탭
3. **홈 화면에 추가** 탭
4. **홈 화면의 아이콘으로** 앱 실행
5. **앱 안에서** 구글 로그인 ← 사파리에서 미리 로그인해도 소용없습니다 (4-E)
6. 앱 안에서 **알림 켜기** 탭 → 허용

iOS 16.4 이상이 필요합니다. 설정 → 일반 → 정보에서 버전 확인.

> 한 번 **거부**하면 앱 안에서 다시 물어볼 수 없습니다.
> 설정 → 알림에서 직접 켜야 하니, 친구들에게 미리 알려주세요.

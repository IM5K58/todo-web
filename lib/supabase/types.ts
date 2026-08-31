/**
 * Hand-written database types for "매일 할거 적기".
 *
 * Mirrors the shape `supabase gen types typescript` produces (Tables / Views /
 * Functions / Enums / CompositeTypes, each table with Row / Insert / Update /
 * Relationships) so it stays drop-in compatible if this project ever switches
 * to codegen. Derived from supabase/migrations/0001_init.sql + 0002_rls.sql.
 *
 * `Relationships` is not decoration: postgrest-js reads it to type nested
 * selects such as `.select('*, profiles(display_name)')`. Keep it accurate.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES THIS FILE ENCODES, both learned the hard way:
 *
 * 1. Insert/Update are narrowed to the columns the client actually holds a
 *    grant on. A type that is broader than the grant produces code that
 *    type-checks and then fails at runtime with `42501 permission denied for
 *    column ...`. Anything the client cannot write is simply absent here.
 *
 * 2. Helpers that live in the `private` schema (`is_group_member`,
 *    `shares_group_with`, ...) are deliberately NOT listed under Functions.
 *    They are RLS internals, `private` is not exposed over the Data API, and
 *    calling them via `supabase.rpc()` returns PGRST202 at runtime. Declaring
 *    them would advertise a call that cannot work.
 * ---------------------------------------------------------------------------
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

/**
 * `group_members.role` and `nudges.source` are `text` columns constrained by
 * CHECK, not Postgres enums, so they do not appear under `Enums`. Typing them
 * as unions is one of the advantages of writing these types by hand.
 */
export type GroupRole = 'owner' | 'member'
export type NudgeSource = 'manual' | 'auto'

/**
 * [0004] `task_templates.weekdays` 한 칸.
 *
 * ★ 0 = 일요일, 6 = 토요일 ★ — PostgreSQL 의 `date_part('dow', ...)` 규약과
 * 같습니다("dow -- The day of the week as Sunday (0) to Saturday (6)").
 * `apply_today_templates` 가 변환 없이 `v_dow = any (tt.weekdays)` 로 바로
 * 비교하므로, 클라이언트에서 isodow(월=1..일=7)로 만들어 보내면 일요일
 * 템플릿이 통째로 사라지고 나머지가 하루씩 밀립니다.
 *
 * JS 에서 이 값을 만들 때는 `new Date(Date.UTC(y, m - 1, d)).getUTCDay()` 를
 * 쓰세요 — 이것도 0=일요일이라 규약이 같습니다. `new Date()` 로 "오늘"을
 * 만드는 것은 여전히 금지입니다(01:30 KST 에 어제가 됩니다).
 *
 * 배열은 DB 의 BEFORE 트리거(`normalize_task_template_weekdays`)가 정렬 +
 * 중복 제거로 정규화하므로, 읽어 온 값은 항상 오름차순·중복 없음입니다.
 * 보낼 때는 순서가 뒤죽박죽이어도 됩니다. 다만 **빈 배열은 22023 으로
 * 거부됩니다** — "요일을 전부 끄기"는 존재하지 않는 상태이고, 잠시 쉬려면
 * `active = false` 를 쓰라는 뜻입니다.
 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Why `send_nudge` refused. Maps 1:1 to the reasons the function returns. */
export type NudgeFailureReason =
  | 'not_member'
  | 'rate_limited_hour'
  | 'rate_limited_day'
  | 'self_nudge'

/**
 * Hoisted so `create_group` and `join_group_by_invite_code` can name the row
 * they return without a circular reference into `Database`.
 *
 * `created_by` is nullable: the FK is `on delete set null`, so the row
 * outlives the founder's account. Never write `group.created_by.slice(...)`.
 */
export type GroupsRow = {
  id: string
  name: string
  invite_code: string
  created_by: string | null
  created_at: string
}

export type Database = {
  public: {
    Tables: {
      profiles: {
        /**
         * ★ 0003 NARROWED THE SELECT GRANT TO COLUMNS ★
         *
         * `grant select (id, display_name, avatar_emoji, timezone, created_at)`
         * — exactly the same trap `groups.invite_code` already sets:
         *
         *   .from('profiles').select('*')                       -> 42501
         *   .from('profiles').select('id, display_name, ...')    -> fine
         *
         * The three `auto_nudge_*` columns below are listed because they exist
         * on the row and the SERVICE ROLE reads them. A signed-in client cannot
         * select them at all; its only read path is `rpc('get_auto_nudge')`.
         */
        Row: {
          /** Same value as auth.users.id. */
          id: string
          /** NOT NULL, DEFAULT '친구'. `handle_new_user()` always writes a
           *  non-empty value at signup, so this is never null. */
          display_name: string
          /** NOT NULL, DEFAULT '🙂'. */
          avatar_emoji: string
          /** NOT NULL, DEFAULT 'Asia/Seoul'. IANA zone name. */
          timezone: string
          created_at: string
          /**
           * [0003] Auto-reminder opt-in. NOT NULL, DEFAULT false.
           * SERVICE ROLE ONLY over the Data API — see the note above.
           */
          auto_nudge_enabled: boolean
          /**
           * [0003] NOT NULL, DEFAULT '21:00'. SQL type `time` (no zone), so it
           * serialises as 'HH:MM:SS' and is interpreted in `timezone` above —
           * never in UTC and never in the browser's zone. Constrained to
           * 5-minute boundaries with seconds = 0 by
           * `profiles_auto_nudge_at_5min_chk`.
           * SERVICE ROLE ONLY over the Data API.
           */
          auto_nudge_at: string
          /**
           * [0003] DATE ('YYYY-MM-DD') of the last auto reminder, in THAT
           * USER'S local timezone. NULL = never sent. This is the entire
           * once-per-local-day idempotency guard.
           * SERVICE ROLE ONLY over the Data API.
           */
          auto_nudge_last_on: string | null
        }
        /** Rows are created by the `handle_new_user` trigger, not by clients. */
        Insert: {
          id: string
          display_name?: string
          avatar_emoji?: string
          timezone?: string
        }
        /**
         * Column grant is `update (display_name, avatar_emoji, timezone)` —
         * 0003 deliberately did NOT extend it.
         *
         * ★ Do not add `auto_nudge_*` here. ★ Leaving them out of the grant is
         * what makes `rpc('set_auto_nudge')` the structurally only write path,
         * and that RPC is the one place the "already passed today?" recompute
         * for `auto_nudge_last_on` lives. A direct UPDATE would skip it and
         * either fire an unexpected push seconds after the toggle or swallow a
         * whole day's reminder.
         */
        Update: {
          display_name?: string
          avatar_emoji?: string
          timezone?: string
        }
        /** The FK id -> auth.users.id lives outside `public`, so codegen emits
         *  nothing for it. */
        Relationships: []
      }
      groups: {
        Row: GroupsRow
        /** No client INSERT grant. Use `rpc('create_group', { p_name })`. */
        Insert: never
        /** Column grant is `update (name)` only. Rotating the invite code goes
         *  through `rpc('rotate_invite_code')`. */
        Update: {
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: 'groups_created_by_fkey'
            columns: ['created_by']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      group_members: {
        Row: {
          group_id: string
          user_id: string
          role: GroupRole
          joined_at: string
        }
        /** No client INSERT grant -- joining an arbitrary group by writing this
         *  table directly would let anyone walk into any group. Use
         *  `rpc('join_group_by_invite_code', { p_invite_code })`. */
        Insert: never
        /** Column grant is `update (role)` only. */
        Update: {
          role?: GroupRole
        }
        Relationships: [
          {
            foreignKeyName: 'group_members_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'group_members_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      tasks: {
        Row: {
          id: string
          user_id: string
          group_id: string
          /** DATE, serialised as 'YYYY-MM-DD'. */
          task_date: string
          title: string
          sort_order: number
          /** NULL while the task is open; set to now() when checked off. */
          done_at: string | null
          created_at: string
          updated_at: string
          /**
           * [0004] The template this task was generated from, or NULL for a
           * hand-typed one. FK is `on delete set null`, so deleting a template
           * leaves today's task in place with the link cut.
           *
           * ★ READ-ONLY FROM A CLIENT ★ 0002's column grants were deliberately
           * NOT extended, so `template_id` is absent from `Insert` and `Update`
           * below. `public.apply_today_templates()` is the only write path.
           * Adding it here would type-check and then fail at runtime with
           * `42501 permission denied for column template_id` — and if the grant
           * were ever opened to match, a client could squat an arbitrary
           * template id in `tasks_user_date_template_uidx` and permanently
           * block its own template from ever applying again.
           *
           * SELECT *is* granted, so rendering a "반복" badge is fine.
           */
          template_id: string | null
        }
        Insert: {
          id?: string
          user_id: string
          group_id: string
          /**
           * OPTIONAL ON PURPOSE. The column defaults to
           * `public.current_user_local_date()`, which resolves today in the
           * caller's *profile timezone*. Omit it and let the database decide.
           *
           * Sending `new Date().toISOString().slice(0, 10)` files a task
           * created at 01:30 KST under yesterday's date, because an explicit
           * column value always beats the default. Only pass `task_date` to
           * backfill or edit a specific past day, and derive it with
           * `Intl.DateTimeFormat('en-CA', { timeZone: profile.timezone })`,
           * never from `toISOString()`.
           */
          task_date?: string
          title: string
          /** DEFAULT 0. */
          sort_order?: number
          done_at?: string | null
        }
        /** Column grant is
         *  `update (group_id, task_date, title, sort_order, done_at)`.
         *  `updated_at` is stamped by the `set_updated_at()` trigger -- do not
         *  send it. `id` and `user_id` are immutable from the client. */
        Update: {
          group_id?: string
          task_date?: string
          title?: string
          sort_order?: number
          done_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'tasks_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'tasks_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'tasks_template_id_fkey'
            columns: ['template_id']
            isOneToOne: false
            referencedRelation: 'task_templates'
            referencedColumns: ['id']
          },
        ]
      }
      /**
       * [0004] 반복 할 일 템플릿.
       *
       * ★ 개인 설정입니다 ★ `task_templates_select_own` 은 `user_id =
       * auth.uid()` 라, tasks 와 달리 같은 그룹 멤버도 남의 템플릿을 한 줄도
       * 볼 수 없습니다. "그룹 전원이 서로의 오늘을 본다"는 tasks 의 규칙을
       * 이 테이블에 옮겨 오지 마세요.
       *
       * SELECT 는 테이블 전체 grant 라 `select('*')` 가 기술적으로는 통과하지만
       * (profiles / groups 와 다른 점), 다른 조회 계층과 일관되게 컬럼을
       * 나열하세요 — 나중에 컬럼이 늘고 grant 가 좁아지면 그때 42501 이 납니다.
       */
      task_templates: {
        Row: {
          id: string
          user_id: string
          /** 이 템플릿이 할 일을 만들어 넣을 그룹. */
          group_id: string
          title: string
          /** DEFAULT 0. tasks 와 같은 범위(-100000..100000). */
          sort_order: number
          /**
           * 0=일요일 .. 6=토요일. 읽어 온 값은 DB 트리거가 정규화해서 항상
           * 오름차순·중복 없음이고, 길이는 1~7 입니다(빈 배열은 저장 불가).
           */
          weekdays: Weekday[]
          /** false = 잠시 끔. 행을 지우는 것과 다릅니다 — 아래 주석 참고. */
          active: boolean
          created_at: string
          updated_at: string
        }
        /**
         * Column grant is
         * `insert (id, user_id, group_id, title, sort_order, weekdays, active)`.
         * `created_at`/`updated_at` are absent on purpose (백데이팅 방지).
         *
         * `user_id` is required rather than defaulted: the INSERT policy's
         * WITH CHECK compares it to `auth.uid()`, so sending someone else's id
         * is refused at the policy rather than silently accepted.
         */
        Insert: {
          id?: string
          user_id: string
          group_id: string
          title: string
          sort_order?: number
          /** 생략하면 DEFAULT '{0,1,2,3,4,5,6}' = 매일. `[]` 는 22023. */
          weekdays?: Weekday[]
          /** DEFAULT true. */
          active?: boolean
        }
        /**
         * Column grant is `update (group_id, title, sort_order, weekdays, active)`.
         * `user_id` is immutable from the client, and `updated_at` is stamped by
         * the `task_templates_set_updated_at` trigger — do not send it.
         *
         * ★ 템플릿을 "쉬게" 할 때는 weekdays 를 비우지 말고 active 를 false 로 ★
         * 빈 배열은 트리거가 22023 으로 거부하고, 설령 통과하더라도 어느 요일에도
         * 걸리지 않는 유령 템플릿이 됩니다. 그리고 행을 삭제하지도 마세요:
         * `tasks.template_id` 가 ON DELETE SET NULL 이라 오늘 이미 만들어진 할
         * 일의 연결이 끊기고, 같은 템플릿을 다시 만들면 부분 유니크 인덱스가
         * 중복을 못 막습니다.
         */
        Update: {
          group_id?: string
          title?: string
          sort_order?: number
          weekdays?: Weekday[]
          active?: boolean
        }
        Relationships: [
          {
            foreignKeyName: 'task_templates_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'task_templates_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
        ]
      }
      push_subscriptions: {
        Row: {
          id: string
          user_id: string
          /** UNIQUE. The endpoint URL from the browser's PushSubscription. */
          endpoint: string
          p256dh: string
          auth: string
          /** SQL type is `bigint`, so this is a NUMBER of milliseconds since
           *  the epoch -- `PushSubscription.expirationTime` verbatim, not a
           *  timestamptz. Null on every browser that does not implement
           *  subscription expiry, which is almost all of them. */
          expiration_time: number | null
          user_agent: string | null
          created_at: string
          updated_at: string
          /** NULL until the first push is actually delivered to this endpoint.
           *  Never `new Date(row.last_used_at)` without checking. */
          last_used_at: string | null
        }
        /**
         * `endpoint` alone is UNIQUE (not `(user_id, endpoint)`), because a
         * Web Push endpoint identifies one browser instance globally. When a
         * second account signs in on the same device, UPSERT on the
         * `endpoint` conflict target and let `user_id` change owners -- do not
         * insert a second row, or the previous account keeps receiving that
         * device's notifications.
         */
        Insert: {
          id?: string
          user_id: string
          endpoint: string
          p256dh: string
          auth: string
          expiration_time?: number | null
          user_agent?: string | null
          /**
           * Writable on purpose, unlike every other `updated_at` in this
           * schema. `push_subscriptions_set_updated_at` is guarded by
           * `when (old.* is distinct from new.*)`, so a device re-subscribing
           * with byte-identical keys would leave the timestamp stale and look
           * abandoned to the pruning job. The subscribe route sets it
           * explicitly. Only the service-role client writes this table.
           */
          updated_at?: string
        }
        /** `created_at` is DB-managed. Ownership transfer goes through the
         *  upsert above, so `user_id` is intentionally absent here. */
        Update: {
          endpoint?: string
          p256dh?: string
          auth?: string
          expiration_time?: number | null
          user_agent?: string | null
          updated_at?: string
          /** NULL until a push is actually delivered. lib/push owns this. */
          last_used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'push_subscriptions_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      nudges: {
        Row: {
          id: string
          /**
           * The sender. NOT `sender_id`.
           *
           * ★ NULLABLE SINCE 0003 ★ NULL means "the system" — an automatic
           * self-reminder (`source: 'auto'`). The invariant is locked in by
           * `nudges_source_sender_chk`:
           *   source='auto'   <-> from_user_id IS NULL
           *   source='manual' <-> from_user_id IS NOT NULL
           *
           * Same hazard as `groups.created_by`: TypeScript will happily compile
           * `nudge.from_user_id.slice(0, 8)` and
           * `profilesById[nudge.from_user_id]` — the first throws at runtime,
           * the second silently yields `undefined`. Branch on `source` (or on
           * `=== null`) and render the auto case as 자동 알림, never as a person.
           */
          from_user_id: string | null
          /** The recipient. NOT `recipient_id`. */
          to_user_id: string
          group_id: string
          task_id: string | null
          message: string | null
          source: NudgeSource
          created_at: string
        }
        /**
         * SERVICE-ROLE ONLY. There is no INSERT policy for `authenticated`:
         * a signed-in client must go through `rpc('send_nudge')`, which is
         * where the 1/hour and 3/day limits are enforced atomically. A direct
         * INSERT would sidestep them entirely.
         *
         * In practice nothing in this app inserts here directly any more —
         * automatic reminders are written by `public.run_auto_nudges()` inside
         * the same transaction that stamps `auto_nudge_last_on`, which is what
         * makes the batch idempotent. Splitting the insert out into TypeScript
         * would break that.
         *
         * If you ever do write a row by hand, `nudges_source_sender_chk`
         * requires `source: 'auto'` to carry `from_user_id: null` and
         * `source: 'manual'` to carry a real one. `nudges_no_self_nudge_chk`
         * still rejects `from_user_id = to_user_id` for manual rows (it passes
         * vacuously for auto rows, because `NULL <> x` is NULL).
         */
        Insert: {
          id?: string
          /** NULL = the system (an automatic reminder). Required to be null
           *  when `source` is 'auto', and non-null when it is 'manual'. */
          from_user_id?: string | null
          to_user_id: string
          group_id: string
          task_id?: string | null
          message?: string | null
          /** DEFAULT 'manual'. The scheduler writes 'auto'. */
          source?: NudgeSource
          created_at?: string
        }
        /** Nudges are an append-only log. Nothing updates them. */
        Update: never
        Relationships: [
          {
            foreignKeyName: 'nudges_from_user_id_fkey'
            columns: ['from_user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'nudges_to_user_id_fkey'
            columns: ['to_user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'nudges_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'nudges_task_id_fkey'
            columns: ['task_id']
            isOneToOne: false
            referencedRelation: 'tasks'
            referencedColumns: ['id']
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      /**
       * SECURITY DEFINER. Creates the group and the caller's 'owner'
       * membership atomically, and generates the invite code.
       * Returns the full groups ROW.
       */
      create_group: {
        Args: { p_name: string }
        Returns: GroupsRow
      }
      /**
       * SECURITY DEFINER. The only way a client joins a group. Looks the code
       * up with RLS bypassed and inserts the caller as 'member'.
       * Returns the full groups ROW -- not the id, not a string.
       */
      join_group_by_invite_code: {
        Args: { p_invite_code: string }
        Returns: GroupsRow
      }
      /**
       * SECURITY DEFINER, owner only. Reads the current invite code.
       * Exists because non-owners can SELECT the groups row but must not see
       * `invite_code`; raises 42501 for anyone else.
       */
      get_invite_code: {
        Args: { p_group_id: string }
        Returns: string
      }
      /** SECURITY DEFINER, owner only. Returns the NEW invite code. */
      rotate_invite_code: {
        Args: { p_group_id: string }
        Returns: string
      }
      /**
       * SECURITY DEFINER, owner only. Removes the member AND rotates the
       * invite code, so a removed member cannot rejoin with the code they
       * already know.
       */
      remove_member: {
        Args: { p_group_id: string; p_user_id: string }
        Returns: undefined
      }
      /**
       * SECURITY DEFINER. Sends a nudge from `auth.uid()` to `p_to_user_id`.
       *
       * Returns a one-row TABLE rather than raising, so the route handler can
       * map `reason` onto Korean copy. postgrest-js types a set-returning
       * function as an array, hence `Returns:` is an array of the row shape.
       *
       * Rate limits (1/hour and 3/day per target) are enforced atomically
       * behind `pg_advisory_xact_lock`, so two taps in the same millisecond
       * cannot both slip through.
       */
      send_nudge: {
        Args: {
          p_to_user_id: string
          p_group_id: string
          p_task_id?: string | null
          p_message?: string | null
        }
        Returns: {
          ok: boolean
          /** Null when `ok` is true. */
          reason: NudgeFailureReason | null
          /** The new nudge's id when `ok` is true, otherwise null. */
          nudge_id: string | null
        }[]
      }
      /**
       * `date`, serialised as 'YYYY-MM-DD'. Today in the caller's *profile*
       * timezone, falling back to Asia/Seoul. This is the default for
       * `tasks.task_date`, which is why `TaskInsert.task_date` is optional.
       */
      current_user_local_date: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      /**
       * [0003] SECURITY DEFINER. Saves the CALLER'S OWN auto-reminder setting.
       *
       * ★ INVARIANT: there is no user-identifying parameter, ever. ★ The target
       * is always `auth.uid()`. Adding a `p_user_id` "for admin convenience"
       * turns this RPC into a primitive for scheduling notifications at other
       * people in exactly one line. The database comment says the same thing.
       *
       * `p_at` is a SQL `time` — send 'HH:MM:SS'. It must sit on a 5-minute
       * boundary with seconds = 0 (the scheduler ticks every 5 minutes in UTC,
       * and every IANA offset is a multiple of 15 minutes, so a 5-minute UTC
       * boundary is a 5-minute local boundary everywhere). It is interpreted in
       * `profiles.timezone`, never in UTC.
       *
       * Raises, rather than returning a reason code:
       *   42501 — no session reached Postgres
       *   22023 — `p_at` is not a 5-minute boundary, or `p_enabled` is null
       *   P0002 — the caller has no `profiles` row
       *
       * Also recomputes `auto_nudge_last_on` ("has this time already passed
       * today?"), which is what stops a toggle flipped at 22:00 from firing a
       * push immediately, and stops a same-day time change from double-sending.
       */
      set_auto_nudge: {
        Args: { p_enabled: boolean; p_at: string }
        Returns: undefined
      }
      /**
       * [0003] SECURITY DEFINER. Reads the CALLER'S OWN setting. No parameters,
       * for the same reason `set_auto_nudge` has none.
       *
       * This is the ONLY read path: 0003 narrowed the `profiles` SELECT grant
       * to columns and `auto_nudge_*` is not among them, so a groupmate cannot
       * learn whether you use reminders or at what time.
       *
       * Always exactly one row (the function LEFT JOINs, so a missing profile
       * yields defaults rather than an empty set). The column is `at_local`,
       * not `at` — `AT` sits one token away from the `AT TIME ZONE` production
       * and reads as a bug.
       *
       * Raises 42501 when there is no session.
       */
      get_auto_nudge: {
        Args: Record<PropertyKey, never>
        Returns: {
          enabled: boolean
          /** 'HH:MM:SS', interpreted in `profiles.timezone`. */
          at_local: string
          /** 'YYYY-MM-DD' in the user's local zone, or null if never sent. */
          last_on: string | null
        }[]
      }
      /**
       * [0003] ★ SERVICE ROLE ONLY. NEVER CALL THIS FROM A BROWSER CLIENT. ★
       *
       * It is listed here only so app/api/cron/auto-nudge/route.ts — which runs
       * with `createAdminClient()` — can be type-checked. Two independent things
       * stop anyone else:
       *   1. `revoke all ... from public, anon, authenticated` in 0003, and
       *   2. a runtime guard that raises 42501 the moment `auth.uid()` is
       *      non-null, so even a GRANT that accidentally comes back is closed.
       * The return set is a roster of user ids plus activity metadata; exposing
       * it would be a user-enumeration leak on top of a "notify everyone now"
       * button.
       *
       * Selects everyone whose local time has reached their `auto_nudge_at`,
       * who has not been reminded yet on their local date, and who still has an
       * unfinished task today; inserts one `source='auto'` nudge each and
       * stamps `auto_nudge_last_on`. Idempotent per user per local day, and
       * serialised across concurrent runs with an advisory lock.
       *
       * Delivery is AT-MOST-ONCE: the claim commits here, the push fan-out
       * happens afterwards in Node. If the route dies in between, that user
       * loses today's reminder rather than getting two.
       *
       * `out_pending_count` counts unfinished tasks in the ONE group the
       * function picked, not across all of the user's groups.
       */
      run_auto_nudges: {
        Args: Record<PropertyKey, never>
        Returns: {
          out_to_user_id: string
          out_group_id: string
          out_pending_count: number
        }[]
      }
      /**
       * [0004] SECURITY DEFINER. 오늘 요일에 해당하는 CALLER'S OWN active
       * 템플릿을 오늘 할 일로 만듭니다.
       *
       * ★ INVARIANT: there is no user-identifying parameter, ever. ★ The target
       * is always `auth.uid()`, exactly like `set_auto_nudge`. Adding a
       * `p_user_id` turns this into a one-line primitive for stuffing tasks
       * into somebody else's day. The database comment says the same thing.
       *
       * `p_group_id` is a FILTER, not a target: NULL (the default) means "every
       * group I am still a member of". A template pointing at a group the
       * caller has since left is skipped silently — it is not counted in either
       * `created` or `skipped`.
       *
       * ★ RETURNS TABLE → PostgREST hands back an ARRAY. Read `data[0]`. ★
       * `created` = rows actually inserted. `skipped` = candidates that were
       * already there today, caught by `tasks_user_date_template_uidx` via
       * `on conflict do nothing`. So a second tap is `created: 0, skipped: N` —
       * idempotent by index, not by an application-level count-then-insert.
       * Show `skipped` to the user: "아무 일도 안 일어난 것처럼" 보이는 성공은
       * 고장으로 오해받습니다.
       *
       * "오늘"과 "오늘의 요일"은 둘 다 `current_user_local_date()` 기준입니다
       * (서버 UTC 아님), and `task_date` is left to the column DEFAULT.
       *
       * Raises 42501 when no session reached Postgres.
       */
      apply_today_templates: {
        Args: { p_group_id?: string | null }
        Returns: {
          created: number
          skipped: number
        }[]
      }
      /**
       * [0004] SECURITY DEFINER. `p_date` 의 CALLER'S OWN 할 일 제목들을 오늘로
       * 복사합니다. 대상은 언제나 `auth.uid()` — 인자를 추가하지 마세요.
       *
       * ★ RETURNS TABLE → 배열입니다. `data[0]` 을 보세요. ★
       *
       * 거부는 예외가 아니라 값입니다: `p_date` 가 NULL 이거나 오늘 이후(오늘
       * 포함)면 `created: 0, skipped: 0` 이 돌아옵니다. reason 같은 필드는
       * 없으므로, 0/0 을 "복사할 게 없었다"로 렌더링하세요.
       *
       * 중복 판정 단위는 btrim 한 제목이고 대소문자는 접지 않습니다. 복사본의
       * `template_id` 는 언제나 NULL 입니다(원본의 값을 옮기면 오늘 이미 적용된
       * 템플릿과 유니크 인덱스에서 충돌해 조용히 사라집니다).
       *
       * Raises 42501 when no session reached Postgres.
       */
      copy_tasks_from: {
        Args: { p_date: string }
        Returns: {
          created: number
          skipped: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

/* -------------------------------------------------------------------------
 * Row helper types
 * ---------------------------------------------------------------------- */

type PublicSchema = Database['public']

export type Tables<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Row']

export type TablesInsert<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Insert']

export type TablesUpdate<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T]['Update']

export type DbFunctions = PublicSchema['Functions']

export type FunctionArgs<T extends keyof DbFunctions> = DbFunctions[T]['Args']
export type FunctionReturns<T extends keyof DbFunctions> = DbFunctions[T]['Returns']

export type Profile = Tables<'profiles'>
export type Group = Tables<'groups'>
export type GroupMember = Tables<'group_members'>
export type Task = Tables<'tasks'>
export type TaskTemplate = Tables<'task_templates'>
export type PushSubscriptionRow = Tables<'push_subscriptions'>
export type Nudge = Tables<'nudges'>

export type ProfileUpdate = TablesUpdate<'profiles'>
export type TaskInsert = TablesInsert<'tasks'>
export type TaskUpdate = TablesUpdate<'tasks'>
export type TaskTemplateInsert = TablesInsert<'task_templates'>
export type TaskTemplateUpdate = TablesUpdate<'task_templates'>
export type PushSubscriptionInsert = TablesInsert<'push_subscriptions'>
export type PushSubscriptionUpdate = TablesUpdate<'push_subscriptions'>

/** The single row `send_nudge` returns, unwrapped from its array. */
export type SendNudgeResult = FunctionReturns<'send_nudge'>[number]

/** The single row `get_auto_nudge` returns, unwrapped from its array. */
export type AutoNudgeSettings = FunctionReturns<'get_auto_nudge'>[number]

/** One reminded user from `run_auto_nudges`. Service-role code only. */
export type AutoNudgeRunRow = FunctionReturns<'run_auto_nudges'>[number]

/**
 * The single row `apply_today_templates` / `copy_tasks_from` return, unwrapped
 * from their array. Both RPCs share this shape on purpose, so one piece of
 * "N개 불러왔어요 (M개는 건너뜀)" copy can render either outcome.
 *
 * ★ `data` from those calls is an ARRAY (RETURNS TABLE). Use `data[0]`. ★
 */
export type BulkFillResult = FunctionReturns<'apply_today_templates'>[number]

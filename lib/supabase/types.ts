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
export type PushSubscriptionRow = Tables<'push_subscriptions'>
export type Nudge = Tables<'nudges'>

export type ProfileUpdate = TablesUpdate<'profiles'>
export type TaskInsert = TablesInsert<'tasks'>
export type TaskUpdate = TablesUpdate<'tasks'>
export type PushSubscriptionInsert = TablesInsert<'push_subscriptions'>
export type PushSubscriptionUpdate = TablesUpdate<'push_subscriptions'>

/** The single row `send_nudge` returns, unwrapped from its array. */
export type SendNudgeResult = FunctionReturns<'send_nudge'>[number]

/** The single row `get_auto_nudge` returns, unwrapped from its array. */
export type AutoNudgeSettings = FunctionReturns<'get_auto_nudge'>[number]

/** One reminded user from `run_auto_nudges`. Service-role code only. */
export type AutoNudgeRunRow = FunctionReturns<'run_auto_nudges'>[number]

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
        }
        /** Rows are created by the `handle_new_user` trigger, not by clients. */
        Insert: {
          id: string
          display_name?: string
          avatar_emoji?: string
          timezone?: string
        }
        /** Column grant is `update (display_name, avatar_emoji, timezone)`. */
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
          /** The sender. NOT `sender_id`. */
          from_user_id: string
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
         * This shape exists for the auto-nudge cron, which runs with
         * `createAdminClient()` and writes `source: 'auto'` on nobody's behalf.
         * A CHECK constraint rejects `from_user_id = to_user_id`.
         */
        Insert: {
          id?: string
          from_user_id: string
          to_user_id: string
          group_id: string
          task_id?: string | null
          message?: string | null
          /** DEFAULT 'manual'. The cron passes 'auto'. */
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

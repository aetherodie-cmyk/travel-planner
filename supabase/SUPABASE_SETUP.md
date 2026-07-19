# Travel Planner Supabase Setup

這是新版 `/supabase/` 共編站台需要先在 Supabase 執行的資料庫設定。

目前資料會拆成多張表：

- `trips`：旅程主檔
- `days`：每天的清單
- `places`：景點
- `route_segments`：景點之間的交通段
- `trip_members`：未來權限控管用
- `trip_logs`：操作紀錄

## 1. 建立或升級資料表

到 Supabase Dashboard：

1. 開啟你的 project。
2. 進入 SQL Editor。
3. 貼上並執行下方 SQL。

```sql
create table if not exists public.trips (
  id text primary key,
  title text not null default '未命名旅程',
  payload jsonb not null default '{}',
  active_day integer not null default 0,
  ors_api_key text not null default '',
  use_api_key boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text,
  schema text not null default 'split-trip-v1',
  created_at timestamptz not null default now(),
  archived boolean not null default false,
  edit_token_hash text,
  admin_token_hash text
);

alter table public.trips add column if not exists active_day integer not null default 0;
alter table public.trips add column if not exists ors_api_key text not null default '';
alter table public.trips add column if not exists use_api_key boolean not null default false;
alter table public.trips add column if not exists created_at timestamptz not null default now();
alter table public.trips add column if not exists archived boolean not null default false;
alter table public.trips add column if not exists edit_token_hash text;
alter table public.trips add column if not exists admin_token_hash text;
alter table public.trips alter column payload set default '{}';

create table if not exists public.days (
  id text primary key,
  trip_id text not null references public.trips(id) on delete cascade,
  day_index integer not null default 0,
  name text not null default '未命名日期',
  date_label text,
  meta jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists days_trip_idx on public.days(trip_id, day_index);

create table if not exists public.places (
  id text primary key,
  trip_id text not null references public.trips(id) on delete cascade,
  day_id text not null references public.days(id) on delete cascade,
  place_order integer not null default 0,
  name text not null default '未命名景點',
  addr text not null default '',
  lat double precision,
  lng double precision,
  category text not null default 'spot',
  notes jsonb not null default '{}',
  arrival_time text,
  leave_time text,
  stay_minutes integer,
  time_auto_arrival boolean not null default false,
  time_auto_leave boolean not null default false,
  osm_type text,
  osm_id text,
  meta jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists places_trip_day_idx on public.places(trip_id, day_id, place_order);

create table if not exists public.route_segments (
  id text primary key,
  trip_id text not null references public.trips(id) on delete cascade,
  day_id text not null references public.days(id) on delete cascade,
  segment_order integer not null default 0,
  from_place_id text not null references public.places(id) on delete cascade,
  to_place_id text not null references public.places(id) on delete cascade,
  mode text not null default 'foot-walking',
  manual_duration_min numeric,
  manual_distance_km numeric,
  result jsonb,
  meta jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists route_segments_trip_day_idx on public.route_segments(trip_id, day_id, segment_order);

create table if not exists public.trip_members (
  id uuid primary key default gen_random_uuid(),
  trip_id text not null references public.trips(id) on delete cascade,
  member_label text,
  user_id uuid,
  role text not null default 'viewer' check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now()
);

create index if not exists trip_members_trip_idx on public.trip_members(trip_id);

create table if not exists public.trip_logs (
  id text primary key,
  trip_id text not null references public.trips(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor text,
  action text not null,
  detail jsonb not null default '{}'
);

create index if not exists trip_logs_trip_idx on public.trip_logs(trip_id, occurred_at desc);
```

## 2. 啟用測試版讀寫權限

目前這一版先讓「知道連結的人」可以共同測試。正式版會再改成登入制與成員權限。

```sql
do $$
declare
  table_name text;
begin
  foreach table_name in array array['trips','days','places','route_segments','trip_members','trip_logs']
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists "travel planner beta all" on public.%I', table_name);
    execute format('create policy "travel planner beta all" on public.%I for all using (true) with check (true)', table_name);
  end loop;
end $$;
```

## 3. 啟用即時同步

```sql
do $$
begin
  begin alter publication supabase_realtime add table public.trips; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.days; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.places; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.route_segments; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.trip_logs; exception when duplicate_object then null; end;
end $$;
```

若出現 `already a member` 類似訊息，表示已經啟用過，可以忽略。

## 4. 從舊 JSON 轉成多表

如果 `trips.payload` 裡已經有舊版整包旅程 JSON：

1. 開啟 `/supabase/` 站台。
2. 在旅程管理中按「啟用 / 重新連線 Supabase」。
3. 確認畫面有載入舊旅程。
4. 按「用目前行程建立雲端正本」。

完成後，新的資料來源會是 `days`、`places`、`route_segments`、`trip_logs`。`trips.payload` 只會保留很小的備援標記，不再存整包 8MB JSON。

## 5. 簡單編輯密碼與封存

目前 `/supabase/` 站台支援第一版簡單控管：

- 檢視連結：拿到連結即可查看。
- 編輯連結：若旅程有設定編輯密碼，需要輸入密碼才會開啟編輯。
- 管理者密碼：可設定/更換編輯密碼，並封存或取消封存旅程。
- 封存旅程：預設不顯示在雲端旅程清單，管理者可切換顯示封存。

密碼不以明文保存，會以 hash 存入 `trips.edit_token_hash` 與 `trips.admin_token_hash`。

## 6. 權限提醒

目前這是「簡單控管」版本，適合小範圍旅伴使用。若要真正防止懂技術的人繞過前端直接呼叫 Supabase API，需要下一階段把寫入改成資料庫 RPC / Edge Function，讓資料庫端檢查 token 後才允許寫入。

正式版建議改成 Supabase Auth + `trip_members`：

- owner：可管理旅程與成員
- editor：可修改行程
- viewer：只能查看

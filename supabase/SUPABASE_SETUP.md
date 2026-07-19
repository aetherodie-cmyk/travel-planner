# Travel Planner Supabase Beta Setup

這是新版 `/supabase/` 共編站台需要先在 Supabase 執行的資料庫設定。

## 1. 建立資料表與即時同步

到 Supabase Dashboard：

1. 開啟你的 project。
2. 進入 SQL Editor。
3. 貼上並執行下方 SQL。

```sql
create table if not exists public.trips (
  id text primary key,
  title text not null default '未命名旅程',
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text,
  schema text not null default 'whole-trip-v1'
);

alter table public.trips enable row level security;

drop policy if exists "travel planner public read trips" on public.trips;
drop policy if exists "travel planner public insert trips" on public.trips;
drop policy if exists "travel planner public update trips" on public.trips;

create policy "travel planner public read trips"
on public.trips for select
using (true);

create policy "travel planner public insert trips"
on public.trips for insert
with check (true);

create policy "travel planner public update trips"
on public.trips for update
using (true)
with check (true);

alter publication supabase_realtime add table public.trips;
```

若最後一行出現 `already a member` 類似訊息，表示已經啟用即時同步，可以忽略。

## 2. 第一階段資料格式

第一階段為了先讓旅行規劃開始共編，先把整趟旅程存成一筆：

```txt
public.trips.id = trip id
public.trips.payload = 完整旅程 JSON
```

這比 Google Drive 單一 JSON 更容易即時同步，但還不是最終型態。

下一階段建議拆成：

- `trips`
- `trip_members`
- `days`
- `places`
- `route_segments`
- `trip_logs`

## 3. 權限提醒

目前 beta 規則是「知道站台與行程 ID 的人可以讀寫」，適合小範圍旅伴先試用。

正式版應改成 Supabase Auth + `trip_members`，做到：

- owner：可管理旅程與成員
- editor：可修改行程
- viewer：只能查看


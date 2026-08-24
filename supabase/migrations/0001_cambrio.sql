create extension if not exists citext;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle citext unique,
  display_name text check (char_length(display_name) between 2 and 20),
  avatar_url text,
  is_anonymous boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.player_stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  games integer not null default 0 check (games >= 0),
  wins integer not null default 0 check (wins >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.matches (
  id uuid primary key,
  room_code text not null,
  completed_at timestamptz not null default now()
);

create table if not exists public.match_participants (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  seat integer not null,
  score integer,
  winner boolean not null,
  forfeited boolean not null,
  primary key (match_id, user_id)
);

create table if not exists public.active_rooms (
  code text primary key,
  snapshot jsonb not null,
  state_version integer not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.player_stats enable row level security;
alter table public.matches enable row level security;
alter table public.match_participants enable row level security;
alter table public.active_rooms enable row level security;

create policy "public permanent profiles" on public.profiles
  for select using (handle is not null and is_anonymous = false);
create policy "public profile statistics" on public.player_stats
  for select using (
    exists (select 1 from public.profiles where profiles.id = player_stats.user_id and profiles.handle is not null and profiles.is_anonymous = false)
  );
create policy "owners update profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

create or replace function public.record_cambrio_match(
  match_id_input uuid,
  room_code_input text,
  participants_input jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare participant jsonb;
begin
  insert into matches(id, room_code) values (match_id_input, room_code_input)
  on conflict (id) do nothing;
  if not found then return false; end if;

  for participant in select * from jsonb_array_elements(participants_input)
  loop
    insert into match_participants(match_id, user_id, display_name, seat, score, winner, forfeited)
    values (
      match_id_input,
      (participant->>'userId')::uuid,
      participant->>'displayName',
      (participant->>'seat')::integer,
      case when participant->>'score' is null then null else (participant->>'score')::integer end,
      (participant->>'winner')::boolean,
      (participant->>'forfeited')::boolean
    );
    insert into player_stats(user_id, games, wins)
    values ((participant->>'userId')::uuid, 1, case when (participant->>'winner')::boolean then 1 else 0 end)
    on conflict (user_id) do update
      set games = player_stats.games + 1,
          wins = player_stats.wins + excluded.wins,
          updated_at = now();
  end loop;
  return true;
end;
$$;

revoke all on function public.record_cambrio_match(uuid, text, jsonb) from public, anon, authenticated;

create index if not exists active_rooms_expiry_idx on public.active_rooms(expires_at);
create index if not exists match_participants_user_idx on public.match_participants(user_id);


-- ============================================================================
--  Unlucky: друзья. Выполняется ОДИН раз: Supabase → SQL Editor → New query → вставить → Run.
--  Скрипт можно запускать повторно: уже созданное он не ломает и не стирает.
--
--  Как это устроено и почему безопасно:
--   * каждый лаунчер входит в Supabase как «анонимный пользователь» (у него свой auth.uid());
--   * таблицы закрыты полностью (RLS включён, политик нет): напрямую из лаунчера в них не прочитать
--     и не записать ничего — даже имея публичный ключ проекта;
--   * вся работа идёт через функции friends_* ниже; каждая действует только от имени вошедшего
--     пользователя и отдаёт только то, что ему можно видеть (себя, друзей и заявки к нему).
-- ============================================================================

-- ------------------------------------------------------------------ таблицы

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  code       text not null unique,            -- код друга, 8 символов (показывается как UNL-XXXX-XXXX)
  name       text not null,                   -- ник как в игре; не проверяется (оффлайн-ники никто не проверяет)
  avatar     text,                            -- PNG 8×8 в base64: голова из скина
  playing    text,                            -- «Minecraft 1.20.1 · Fabric» или пусто
  hidden     boolean not null default false,  -- «не показывать мой статус»
  last_seen  timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint profiles_name_ck    check (name ~ '^[A-Za-z0-9_.-]{3,16}$'),
  constraint profiles_code_ck    check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  constraint profiles_avatar_ck  check (avatar is null or (length(avatar) <= 2000 and avatar ~ '^[A-Za-z0-9+/=]+$')),
  constraint profiles_playing_ck check (playing is null or length(playing) <= 64)
);

create table if not exists public.friendships (
  requester  uuid not null references public.profiles (id) on delete cascade,
  addressee  uuid not null references public.profiles (id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);
-- одна пара игроков — одна запись, в каком бы направлении ни шла заявка
create unique index if not exists friendships_pair_uq on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_addressee_idx on public.friendships (addressee);

-- неудачные попытки ввести чужой код (защита от перебора)
create table if not exists public.friend_lookups (
  user_id uuid not null references public.profiles (id) on delete cascade,
  at      timestamptz not null default now()
);
create index if not exists friend_lookups_idx on public.friend_lookups (user_id, at);

alter table public.profiles       enable row level security;
alter table public.friendships    enable row level security;
alter table public.friend_lookups enable row level security;
-- Политик нет намеренно: прямой доступ закрыт всем. Ниже — полный отзыв прав на всякий случай.
revoke all on table public.profiles, public.friendships, public.friend_lookups from public, anon, authenticated;

-- ------------------------------------------------------------------ служебные функции (клиентам недоступны)

create or replace function public.friends_gen_code() returns text
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 символа, без похожих I, O, 0, 1
  raw bytea;
  res text;
  i int;
begin
  loop
    raw := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');  -- случайные байты; берём те, что целиком случайны
    res := '';
    foreach i in array array[0, 1, 2, 3, 4, 5, 10, 11] loop
      res := res || substr(alphabet, (get_byte(raw, i) % 32) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.profiles where code = res);
  end loop;
  return res;
end $$;

create or replace function public.friends_norm_code(p text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare s text := regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g');
begin
  if length(s) = 11 and left(s, 3) = 'UNL' then s := substr(s, 4); end if;  -- «UNL-K7M2-9QX4» → «K7M29QX4»
  return s;
end $$;

-- Всё, что видит пользователь: свой код, друзья, входящие и исходящие заявки.
create or replace function public.friends_state(p_uid uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'me', jsonb_build_object('code', me.code, 'name', me.name),
    'friends', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id, 'name', o.name, 'avatar', o.avatar,
               'online', (not o.hidden) and o.last_seen > now() - interval '150 seconds',
               'playing', case when o.hidden then null else o.playing end
             ) order by lower(o.name), o.id)
      from public.friendships f
      join public.profiles o on o.id = case when f.requester = p_uid then f.addressee else f.requester end
      where f.status = 'accepted' and p_uid in (f.requester, f.addressee)
    ), '[]'::jsonb),
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'avatar', o.avatar) order by f.created_at, o.id)
      from public.friendships f join public.profiles o on o.id = f.requester
      where f.addressee = p_uid and f.status = 'pending'
    ), '[]'::jsonb),
    -- отклонённая заявка выглядит для отправителя как обычная ожидающая: он не узнаёт об отказе и не может спамить
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'avatar', o.avatar) order by f.created_at, o.id)
      from public.friendships f join public.profiles o on o.id = f.addressee
      where f.requester = p_uid and f.status in ('pending', 'declined')
    ), '[]'::jsonb)
  )
  from public.profiles me where me.id = p_uid
$$;

-- ------------------------------------------------------------------ функции для лаунчера

-- Раз в ~45 секунд: «я здесь», обновить ник, аватар и статус; в ответ — всё, что нужно показать.
--   p_avatar: null — не менять, '' — убрать, иначе PNG в base64.
create or replace function public.friends_sync(p_name text, p_avatar text, p_playing text, p_hidden boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_playing text := nullif(left(regexp_replace(coalesce(p_playing, ''), '[[:cntrl:]]', '', 'g'), 64), '');
begin
  if v_uid is null then raise exception 'Нужно войти'; end if;
  if p_name is null or p_name !~ '^[A-Za-z0-9_.-]{3,16}$' then raise exception 'Ник: 3–16 символов, латиница, цифры и _ . -'; end if;
  if p_avatar is not null and p_avatar <> '' and (length(p_avatar) > 2000 or p_avatar !~ '^[A-Za-z0-9+/=]+$') then
    raise exception 'Аватар не подходит';
  end if;

  if not exists (select 1 from public.profiles where id = v_uid) then
    insert into public.profiles (id, code, name) values (v_uid, public.friends_gen_code(), p_name) on conflict (id) do nothing;
  end if;
  update public.profiles set
    name = p_name,
    avatar = case when p_avatar is null then avatar when p_avatar = '' then null else p_avatar end,
    playing = v_playing,
    hidden = coalesce(p_hidden, false),
    last_seen = now()
  where id = v_uid;

  return public.friends_state(v_uid);
end $$;

-- Лаунчер закрывается: сразу показаться друзьям «не в сети».
create or replace function public.friends_bye() returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  update public.profiles set playing = null, last_seen = now() - interval '1 day' where id = auth.uid();
end $$;

-- Отправить заявку по коду друга. Ожидаемые отказы приходят как {"error": "..."}, а не исключением:
-- исключение откатило бы запись о неудачной попытке, и защита от перебора не работала бы.
create or replace function public.friends_request(p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_code text := public.friends_norm_code(p_code);
  v_other public.profiles;
  v_row public.friendships;
  v_note text := 'sent';
  c_max constant int := 200;   -- предел друзей и исходящих заявок
  c_inbox constant int := 50;  -- предел входящих заявок у одного игрока
begin
  if v_uid is null then raise exception 'Нужно войти'; end if;
  if not exists (select 1 from public.profiles where id = v_uid) then raise exception 'Сначала подключите друзей'; end if;
  if v_code !~ '^[A-HJ-NP-Z2-9]{8}$' then
    return jsonb_build_object('error', 'Код выглядит так: UNL-K7M2-9QX4');
  end if;

  delete from public.friend_lookups where user_id = v_uid and at < now() - interval '1 hour';
  if (select count(*) from public.friend_lookups where user_id = v_uid) >= 10 then
    return jsonb_build_object('error', 'Слишком много неверных кодов. Попробуйте через час.');
  end if;

  select * into v_other from public.profiles where code = v_code;
  if not found then
    insert into public.friend_lookups (user_id) values (v_uid);
    return jsonb_build_object('error', 'Такого кода нет. Проверьте, что он введён правильно.');
  end if;
  if v_other.id = v_uid then return jsonb_build_object('error', 'Это ваш собственный код.'); end if;

  select * into v_row from public.friendships
   where (requester = v_uid and addressee = v_other.id) or (requester = v_other.id and addressee = v_uid);

  if found then
    if v_row.status = 'accepted' then
      v_note := 'already';
    elsif v_row.requester = v_other.id then
      if v_row.status = 'pending' then                       -- он уже звал меня: считаем это согласием
        update public.friendships set status = 'accepted' where requester = v_other.id and addressee = v_uid;
        v_note := 'accepted';
      else                                                   -- я его когда-то отклонил, теперь зову сам
        delete from public.friendships where requester = v_other.id and addressee = v_uid;
        insert into public.friendships (requester, addressee) values (v_uid, v_other.id);
      end if;
    else
      v_note := case when v_row.status = 'pending' then 'already_sent' else 'sent' end;  -- «declined» скрываем от отправителя
    end if;
  else
    if (select count(*) from public.friendships where status = 'accepted' and v_uid in (requester, addressee))
     + (select count(*) from public.friendships where status = 'pending' and requester = v_uid) >= c_max then
      return jsonb_build_object('error', 'Список друзей заполнен (' || c_max || ').');
    end if;
    if (select count(*) from public.friendships where addressee = v_other.id and status = 'pending') >= c_inbox then
      return jsonb_build_object('error', 'У этого игрока сейчас слишком много заявок. Попробуйте позже.');
    end if;
    insert into public.friendships (requester, addressee) values (v_uid, v_other.id);
  end if;

  return jsonb_build_object('note', v_note, 'target', v_other.name, 'state', public.friends_state(v_uid));
exception when unique_violation then
  -- обе стороны отправили заявку одновременно
  return jsonb_build_object('note', 'already_sent', 'target', v_other.name, 'state', public.friends_state(v_uid));
end $$;

create or replace function public.friends_accept(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Нужно войти'; end if;
  if (select count(*) from public.friendships where status = 'accepted' and v_uid in (requester, addressee)) >= 200 then
    raise exception 'Список друзей заполнен (200).';
  end if;
  update public.friendships set status = 'accepted' where requester = p_id and addressee = v_uid and status = 'pending';
  if not found then raise exception 'Заявка не найдена. Возможно, её уже отозвали.'; end if;
  return public.friends_state(v_uid);
end $$;

-- Отказ запоминается: отправитель не сможет присылать заявки снова.
create or replace function public.friends_decline(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Нужно войти'; end if;
  update public.friendships set status = 'declined' where requester = p_id and addressee = v_uid and status = 'pending';
  return public.friends_state(v_uid);
end $$;

-- Убрать друга или отозвать свою ожидающую заявку. Запись об отказе так не стереть.
create or replace function public.friends_remove(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Нужно войти'; end if;
  delete from public.friendships
   where (status = 'accepted' and ((requester = v_uid and addressee = p_id) or (requester = p_id and addressee = v_uid)))
      or (status = 'pending' and requester = v_uid and addressee = p_id);
  return public.friends_state(v_uid);
end $$;

-- Новый код друга (если прежний попал не в те руки). Друзья остаются.
create or replace function public.friends_new_code() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Нужно войти'; end if;
  update public.profiles set code = public.friends_gen_code() where id = v_uid;
  if not found then raise exception 'Сначала подключите друзей'; end if;
  return public.friends_state(v_uid);
end $$;

-- Удалить меня с сервера: профиль, друзья, заявки.
create or replace function public.friends_delete_me() returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  delete from public.profiles where id = auth.uid();
end $$;

-- Ручная уборка (не для клиентов): профили, в которых не появлялись полгода.
create or replace function public.friends_cleanup() returns int
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n int;
begin
  delete from public.profiles where last_seen < now() - interval '180 days';
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------------ права на функции

do $$
declare f text;
begin
  -- всё закрываем, потом открываем нужное: по умолчанию Supabase выдаёт права на новые функции всем
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'friends\_%'
  loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
  end loop;
end $$;

grant execute on function public.friends_sync(text, text, text, boolean) to authenticated;
grant execute on function public.friends_bye() to authenticated;
grant execute on function public.friends_request(text) to authenticated;
grant execute on function public.friends_accept(uuid) to authenticated;
grant execute on function public.friends_decline(uuid) to authenticated;
grant execute on function public.friends_remove(uuid) to authenticated;
grant execute on function public.friends_new_code() to authenticated;
grant execute on function public.friends_delete_me() to authenticated;
-- friends_gen_code, friends_norm_code, friends_state и friends_cleanup клиентам недоступны.

-- Чтобы API увидел новые функции сразу, а не через минуту:
notify pgrst, 'reload schema';

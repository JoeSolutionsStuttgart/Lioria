-- ============================================================
-- LIORIA — Update 40: Geheime Auslosung (Spiele auf der Gästeseite)
-- Bei „geheim“ gelosten Teams oder Ketten sieht das Ergebnis nur,
-- wer das Ereignis erstellt hat. Jede teilnehmende Person sieht auf
-- der Gästeseite mit Name + Passwort nur ihre eigene Zuteilung.
-- Einmal im Supabase-SQL-Editor ausführen (nach Update 39).
-- Mehrfach ausführen schadet nicht.
-- ============================================================

create table if not exists public.spiel_geheim (
  event_id uuid not null references public.events on delete cascade,
  frage    text not null,
  name_key text not null,
  pw_hash  text not null default '',
  ziel     jsonb not null default '{}'::jsonb,
  created  timestamptz not null default now(),
  primary key (event_id, frage, name_key)
);
alter table public.spiel_geheim enable row level security;
revoke all on public.spiel_geheim from anon, authenticated;

-- Nur wer das Ereignis erstellt hat, schreibt die Auslosung (ersetzt eine frühere).
create or replace function public.spiel_geheim_setzen(p_event uuid, p_frage text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null or not exists (select 1 from public.events where id = p_event and owner = auth.uid()) then raise exception 'D-30'; end if;
  if length(coalesce(p_frage, '')) < 1 or length(p_frage) > 20 or jsonb_typeof(p_rows) <> 'array' or length(p_rows::text) > 60000 then raise exception 'D-08'; end if;
  delete from public.spiel_geheim where event_id = p_event and frage = p_frage;
  insert into public.spiel_geheim (event_id, frage, name_key, pw_hash, ziel)
  select p_event, p_frage, lower(trim(r->>'name')), coalesce(r->>'pw', ''), coalesce(r->'ziel', '{}'::jsonb)
  from (select value as r from jsonb_array_elements(p_rows) limit 300) x
  where length(trim(coalesce(r->>'name', ''))) between 1 and 60
  on conflict (event_id, frage, name_key) do update set pw_hash = excluded.pw_hash, ziel = excluded.ziel;
  get diagnostics n = row_count;
  return n;
end; $$;
grant execute on function public.spiel_geheim_setzen(uuid, text, jsonb) to authenticated;

-- Nur wer das Ereignis erstellt hat, liest die ganze Auslosung.
create or replace function public.spiel_geheim_lesen(p_event uuid, p_frage text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from public.events where id = p_event and owner = auth.uid()) then raise exception 'D-30'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('name', name_key, 'ziel', ziel, 'pw', pw_hash <> '') order by name_key)
    from public.spiel_geheim where event_id = p_event and frage = p_frage), '[]'::jsonb);
end; $$;
grant execute on function public.spiel_geheim_lesen(uuid, text) to authenticated;

-- Gast fragt mit Name + Passwort nach der eigenen Zuteilung.
-- Das Passwort liegt nur als Prüfsumme vor: sha256(Ereignis|name|PASSWORT).
create or replace function public.spiel_meins(p_event uuid, p_token text, p_frage text, p_name text, p_pw text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare k text; z jsonb;
begin
  if public.guest_cfg(p_event, p_token) is null then raise exception 'D-26'; end if;
  if not exists (select 1 from public.spiel_geheim where event_id = p_event and frage = p_frage) then
    return jsonb_build_object('status', 'offen');
  end if;
  k := lower(trim(coalesce(p_name, '')));
  select ziel into z from public.spiel_geheim
   where event_id = p_event and frage = p_frage and name_key = k and pw_hash <> ''
     and pw_hash = encode(sha256(convert_to(p_event::text || '|' || k || '|' || upper(trim(coalesce(p_pw, ''))), 'UTF8')), 'hex');
  if z is null then
    perform pg_sleep(0.6);  -- Raten bremsen
    return jsonb_build_object('status', 'falsch');
  end if;
  return jsonb_build_object('status', 'ok', 'ziel', z);
end; $$;
grant execute on function public.spiel_meins(uuid, text, text, text, text) to anon, authenticated;

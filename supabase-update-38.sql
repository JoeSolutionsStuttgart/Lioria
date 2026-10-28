-- ============================================================
-- CHRONIK — Update 38: Blockaden („Alles von … nicht mehr zeigen“)
-- auch auf dem Server, damit blockierte Personen keine Info-Karte
-- mehr über einen sehen. Einmal im Supabase-SQL-Editor ausführen
-- (nach Update 37). Mehrfach ausführen schadet nicht.
-- ============================================================

create table if not exists public.blockaden (
  von     uuid not null references auth.users on delete cascade,
  an      uuid not null references auth.users on delete cascade,
  created timestamptz not null default now(),
  primary key (von, an)
);
alter table public.blockaden enable row level security;
revoke all on public.blockaden from anon, authenticated;

-- Die eigene Liste ersetzen (nur über diese Funktion).
create or replace function public.blockaden_setzen(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'D-30'; end if;
  delete from public.blockaden where von = auth.uid();
  insert into public.blockaden (von, an)
  select distinct auth.uid(), x from unnest(coalesce(p_ids, '{}'::uuid[])) x
  where x is not null and x <> auth.uid() and exists (select 1 from auth.users u where u.id = x)
  limit 500;
end; $$;
grant execute on function public.blockaden_setzen(uuid[]) to authenticated;

-- Wer hat mich blockiert? Mehr erfährt man nicht.
create or replace function public.blockiert_mich() returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(von), '{}'::uuid[]) from public.blockaden where an = auth.uid();
$$;
grant execute on function public.blockiert_mich() to authenticated;

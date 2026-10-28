-- ============================================================
-- CHRONIK — Update 37: Finanzplaner im Ereignis (statt Gästeseite).
-- Wer ein Ereignis sehen darf (mit Konto), sieht und pflegt dessen
-- Finanzen. Einmal im Supabase-SQL-Editor ausführen (nach Update 36).
-- Mehrfach ausführen schadet nicht.
-- ============================================================

-- Die Gästelink-Zugänge aus Update 36 werden nicht mehr gebraucht.
drop function if exists public.fin_view(uuid, text);
drop function if exists public.fin_setzen(uuid, text, uuid, jsonb);
drop function if exists public.fin_weg(uuid, text, uuid);
drop function if exists public.fin_abschluss(uuid, text, boolean);
drop function if exists public.fin_ok(uuid, text);

-- Tabellen aus Update 36 (falls es übersprungen wurde).
create table if not exists public.fin_eintraege (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events on delete cascade,
  von      uuid references auth.users on delete set null,
  von_name text not null default '',
  data     jsonb not null default '{}'::jsonb,
  created  timestamptz not null default now()
);
create index if not exists fin_eintraege_event_idx on public.fin_eintraege (event_id, created);
alter table public.fin_eintraege enable row level security;

create table if not exists public.fin_status (
  event_id uuid primary key references public.events on delete cascade,
  zu       boolean not null default false,
  wer      text not null default '',
  wer_id   uuid,
  wann     timestamptz not null default now()
);
alter table public.fin_status enable row level security;

-- Darf alles (fremde Einträge ändern/löschen, wieder öffnen): Inhaber, Admin, Mitbearbeitende.
create or replace function public.fin_chef(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.events e where e.id = p_event
    and (e.owner = auth.uid() or public.is_owner() or public.event_edit_ok(e.owner, e.vis, e.who, e.gwho, e.share, e.perms)));
$$;
grant execute on function public.fin_chef(uuid) to authenticated;

create or replace function public.fin_zu(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select zu from public.fin_status where event_id = p_event), false);
$$;
grant execute on function public.fin_zu(uuid) to authenticated;

create or replace function public.fin_anzahl(p_event uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.fin_eintraege where event_id = p_event;
$$;
grant execute on function public.fin_anzahl(uuid) to authenticated;

revoke all on public.fin_eintraege from anon;
revoke all on public.fin_status from anon;
grant select, insert, update, delete on public.fin_eintraege to authenticated;
grant select, insert, update on public.fin_status to authenticated;

-- Sichtbar ist, was zu einem Ereignis gehört, das man selbst sehen darf
-- (die Abfrage auf events gilt mit den Rechten der angemeldeten Person).
drop policy if exists "fin sehen" on public.fin_eintraege;
create policy "fin sehen" on public.fin_eintraege for select to authenticated using (
  exists (select 1 from public.events e where e.id = event_id)
);
drop policy if exists "fin anlegen" on public.fin_eintraege;
create policy "fin anlegen" on public.fin_eintraege for insert to authenticated with check (
  von = auth.uid() and not public.is_blocked() and not public.fin_zu(event_id)
  and length(data::text) <= 8000
  and exists (select 1 from public.events e where e.id = event_id)
  and public.fin_anzahl(event_id) < 500
);
drop policy if exists "fin aendern" on public.fin_eintraege;
create policy "fin aendern" on public.fin_eintraege for update to authenticated
  using ((von = auth.uid() or public.fin_chef(event_id)) and not public.fin_zu(event_id))
  with check (length(data::text) <= 8000 and not public.fin_zu(event_id));
drop policy if exists "fin loeschen" on public.fin_eintraege;
create policy "fin loeschen" on public.fin_eintraege for delete to authenticated
  using ((von = auth.uid() or public.fin_chef(event_id)) and not public.fin_zu(event_id));

-- Inhaber und Ereignis dürfen sich bei einer Änderung nicht verschieben.
create or replace function public.fin_schutz() returns trigger
language plpgsql set search_path = public as $$
begin
  new.event_id := old.event_id; new.von := old.von; new.von_name := old.von_name; new.created := old.created;
  return new;
end; $$;
drop trigger if exists fin_schutz on public.fin_eintraege;
create trigger fin_schutz before update on public.fin_eintraege for each row execute function public.fin_schutz();

-- Abschließen darf jede/r, die/der das Ereignis sieht; wieder öffnen nur,
-- wer abgeschlossen hat, oder Inhaber/Mitbearbeitende.
drop policy if exists "fin status sehen" on public.fin_status;
create policy "fin status sehen" on public.fin_status for select to authenticated using (
  exists (select 1 from public.events e where e.id = event_id)
);
drop policy if exists "fin status anlegen" on public.fin_status;
create policy "fin status anlegen" on public.fin_status for insert to authenticated with check (
  wer_id = auth.uid() and not public.is_blocked() and exists (select 1 from public.events e where e.id = event_id)
);
drop policy if exists "fin status aendern" on public.fin_status;
create policy "fin status aendern" on public.fin_status for update to authenticated
  using (exists (select 1 from public.events e where e.id = event_id)
         and (not zu or wer_id = auth.uid() or public.fin_chef(event_id)))
  with check (wer_id = auth.uid() and not public.is_blocked());

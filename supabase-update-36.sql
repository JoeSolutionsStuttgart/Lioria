-- ============================================================
-- CHRONIK — Update 36
--  1. Vorschläge auf der Gästeseite (mit Kommentaren).
--  2. Finanzplaner: nur für Angemeldete mit Gästelink.
-- Einmal im Supabase-SQL-Editor ausführen (nach Update 35).
-- Ändert nichts Bestehendes; mehrfach ausführen schadet nicht.
-- ============================================================

-- ---------- 1. Vorschläge ----------
alter table public.guest_entries drop constraint if exists guest_entries_kind_check;
alter table public.guest_entries add constraint guest_entries_kind_check check (kind in ('foto', 'buch', 'rsvp', 'kom', 'vor'));

-- Kommentare verschwinden mit ihrem Foto oder Vorschlag.
create or replace function public.guest_kom_weg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.kind in ('foto', 'vor') then delete from public.guest_entries where event_id = old.event_id and kind = 'kom' and data->>'zu' = old.id::text; end if;
  return old;
end; $$;
drop trigger if exists guest_kom_weg on public.guest_entries;
create trigger guest_kom_weg after delete on public.guest_entries for each row execute function public.guest_kom_weg();

create or replace function public.guest_add(p_event uuid, p_token text, p_kind text, p_name text, p_text text, p_data jsonb, p_img text)
returns uuid language plpgsql security definer set search_path = public as $$
declare o jsonb; n int; nid uuid; erlaubt boolean; bel jsonb; fq jsonb; opt text; mx int; zk text;
begin
  o := public.guest_cfg(p_event, p_token);
  if o is null then raise exception 'D-26'; end if;
  if p_kind = 'kom' then
    select kind into zk from public.guest_entries where event_id = p_event and id::text = coalesce(p_data->>'zu', '') and kind in ('foto', 'vor');
  end if;
  erlaubt := case p_kind
    when 'foto' then coalesce((o->>'foto')::boolean, false) and not public.guest_zu(o, 'foto')
    when 'kom'  then coalesce(zk, '') <> '' and coalesce((o->>zk)::boolean, false) and not public.guest_zu(o, zk)
    when 'buch' then coalesce((o->>'buch')::boolean, false) and not public.guest_zu(o, 'buch')
    when 'vor'  then coalesce((o->>'vor')::boolean, false) and not public.guest_zu(o, 'vor')
    when 'rsvp' then coalesce((o->>'rsvp')::boolean, false) or (jsonb_typeof(o->'fragen') = 'array' and jsonb_array_length(o->'fragen') > 0)
    else false end;
  if not erlaubt then raise exception 'D-26'; end if;
  if length(trim(coalesce(p_name, ''))) < 1 or length(p_name) > 60 or length(coalesce(p_text, '')) > 1500
     or length(coalesce(p_data::text, '')) > 8000 then raise exception 'D-08'; end if;
  if p_kind = 'foto' and (p_img is null or p_img not like p_event::text || '/gast-%') then raise exception 'D-08'; end if;
  if p_kind in ('kom', 'vor') and length(trim(coalesce(p_text, ''))) < 1 then raise exception 'D-08'; end if;
  -- Höchstmengen je Antwort: andere Gäste zählen, die eigene frühere Antwort nicht.
  if p_kind = 'rsvp' and coalesce(p_data->>'kommt', '') <> 'nein' and jsonb_typeof(p_data->'antw') = 'object' then
    bel := public.guest_belegt(p_event, p_name);
    for fq in select value from jsonb_array_elements(case when jsonb_typeof(o->'fragen') = 'array' then o->'fragen' else '[]'::jsonb end) loop
      if jsonb_typeof(fq->'max') = 'object' and jsonb_typeof(p_data->'antw'->(fq->>'i')) = 'array' then
        for opt in select jsonb_array_elements_text(p_data->'antw'->(fq->>'i')) loop
          mx := case when coalesce(fq->'max'->>opt, '') ~ '^[0-9]{1,6}$' then (fq->'max'->>opt)::int else 0 end;
          if mx > 0 and coalesce((bel->(fq->>'i')->>opt)::int, 0) >= mx then raise exception 'D-29'; end if;
        end loop;
      end if;
    end loop;
  end if;
  select count(*) into n from public.guest_entries where event_id = p_event;
  if n >= 3000 then raise exception 'D-27'; end if;
  insert into public.guest_entries (event_id, kind, name, text, data, img)
  values (p_event, p_kind, trim(p_name), coalesce(p_text, ''), coalesce(p_data, '{}'::jsonb), case when p_kind = 'foto' then p_img else null end)
  returning id into nid;
  return nid;
end; $$;
grant execute on function public.guest_add(uuid, text, text, text, text, jsonb, text) to anon, authenticated;

create or replace function public.guest_view(p_event uuid, p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e public.events; o jsonb; w jsonb; x jsonb; f boolean; b boolean; v boolean;
begin
  -- Passwort gesetzt, aber falsch oder fehlend: nur Name und Design für die Abfrage.
  select * into e from public.events where id = p_event;
  if found then
    w := e.data->'extras'->'offen';
    if coalesce(length(split_part(p_token, '~', 1)), 0) >= 16 and w->>'token' = split_part(p_token, '~', 1)
       and coalesce((w->>'an')::boolean, false) and not public.guest_pw_ok(w, p_token) then
      return jsonb_build_object('pwNoetig', true, 'name', e.name,
        'cfg', jsonb_build_object('look', w->'look', 'titel', coalesce(w->>'titel', '')), 'eintraege', '[]'::jsonb, 'tische', '[]'::jsonb);
    end if;
  end if;
  o := public.guest_cfg(p_event, p_token);
  if o is null then
    -- Link stimmt, ist aber erst später freigeschaltet: nur Name, Datum und Öffnungszeit.
    select * into e from public.events where id = p_event;
    if not found then return null; end if;
    w := e.data->'extras'->'offen';
    if coalesce(length(split_part(p_token, '~', 1)), 0) >= 16 and w->>'token' = split_part(p_token, '~', 1) and coalesce((w->>'an')::boolean, false) and public.guest_zu(w, 'an') then
      return jsonb_build_object('name', e.name, 'date', e.date, 'place', e.place, 'kicker', e.kicker,
        'wartet', (w->'freiMs'->>'an')::numeric,
        'cfg', jsonb_build_object('look', w->'look', 'titel', coalesce(w->>'titel', ''), 'gruss', coalesce(w->>'gruss', '')),
        'eintraege', '[]'::jsonb, 'tische', '[]'::jsonb);
    end if;
    return null;
  end if;
  select * into e from public.events where id = p_event;
  x := coalesce(e.data->'extras', '{}'::jsonb);
  f := coalesce((o->>'foto')::boolean, false) and not public.guest_zu(o, 'foto');
  b := coalesce((o->>'buch')::boolean, false) and not public.guest_zu(o, 'buch');
  v := coalesce((o->>'vor')::boolean, false) and not public.guest_zu(o, 'vor');
  return jsonb_build_object(
    'name', e.name, 'date', e.date, 'start', coalesce(x->>'cdZeit', ''), 'place', e.place, 'kicker', e.kicker,
    'countdown', case when coalesce((x->>'countdown')::boolean, false) then jsonb_build_object('zeit', coalesce(x->>'cdZeit', '')) else null end,
    'notfall', case when coalesce((x->'notfall'->>'an')::boolean, false) then x->'notfall' else null end,
    'lage', case when public.guest_zu(o, 'lage') then null else x->'lage' end,
    'zeitplan', case when coalesce((o->>'zp')::boolean, false) and not public.guest_zu(o, 'zp') and jsonb_typeof(o->'zeitplan') = 'array' then o->'zeitplan' else '[]'::jsonb end,
    'cfg', jsonb_build_object(
      'zp', coalesce((o->>'zp')::boolean, false),
      'foto', coalesce((o->>'foto')::boolean, false), 'buch', coalesce((o->>'buch')::boolean, false),
      'vor', coalesce((o->>'vor')::boolean, false), 'fin', coalesce((o->>'fin')::boolean, false),
      'sitz', coalesce((o->>'sitz')::boolean, false), 'rsvp', coalesce((o->>'rsvp')::boolean, false),
      'essen', coalesce(o->>'essen', ''), 'essenPflicht', coalesce((o->>'essenPflicht')::boolean, true), 'look', o->'look', 'titel', coalesce(o->>'titel', ''), 'gruss', coalesce(o->>'gruss', ''),
      'frei', coalesce(o->'frei', '{}'::jsonb), 'freiMs', coalesce(o->'freiMs', '{}'::jsonb),
      'fragen', case when jsonb_typeof(o->'fragen') = 'array' then o->'fragen' else '[]'::jsonb end),
    'belegt', public.guest_belegt(p_event, ''),
    'tische', case when coalesce((o->>'sitz')::boolean, false) and not public.guest_zu(o, 'sitz') then coalesce(o->'tische', '[]'::jsonb) else '[]'::jsonb end,
    'eintraege', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'kind', g.kind, 'name', g.name, 'text', g.text, 'img', g.img, 'zu', g.data->>'zu', 'created', g.created) order by g.created desc)
      from (select * from public.guest_entries ge
            where ge.event_id = p_event
              and ((ge.kind = 'foto' and f) or (ge.kind = 'buch' and b) or (ge.kind = 'vor' and v)
                or (ge.kind = 'kom' and exists (select 1 from public.guest_entries t where t.event_id = p_event and t.id::text = ge.data->>'zu'
                      and ((t.kind = 'foto' and f) or (t.kind = 'vor' and v)))))
            order by created desc limit 800) g
    ), '[]'::jsonb)
  );
end; $$;
grant execute on function public.guest_view(uuid, text) to anon, authenticated;

-- ---------- 2. Finanzplaner ----------
-- Nur über die Funktionen unten erreichbar (keine direkten Rechte).
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

-- Zugang: angemeldet, nicht gesperrt, gültiger Gästelink, Finanzplaner eingeschaltet und freigegeben.
create or replace function public.fin_ok(p_event uuid, p_token text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare o jsonb;
begin
  if auth.uid() is null or public.is_blocked() then return false; end if;
  o := public.guest_cfg(p_event, p_token);
  return o is not null and coalesce((o->>'fin')::boolean, false) and not public.guest_zu(o, 'fin');
end; $$;

-- Darf alles (fremde Einträge löschen, wieder öffnen): Inhaber, Admin, Mitbearbeitende.
create or replace function public.fin_chef(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.events e where e.id = p_event
    and (e.owner = auth.uid() or public.is_owner() or public.event_edit_ok(e.owner, e.vis, e.who, e.gwho, e.share, e.perms)));
$$;

create or replace function public.fin_view(p_event uuid, p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e public.events; ich text;
begin
  if not public.fin_ok(p_event, p_token) then raise exception 'D-31'; end if;
  select * into e from public.events where id = p_event;
  select coalesce(username, '') into ich from public.profiles where id = auth.uid();
  return jsonb_build_object(
    'ich', coalesce(ich, ''),
    'chef', public.fin_chef(p_event),
    'status', coalesce((select jsonb_build_object('zu', s.zu, 'wer', s.wer, 'meins', s.wer_id = auth.uid(), 'wann', s.wann) from public.fin_status s where s.event_id = p_event),
                       jsonb_build_object('zu', false)),
    'eintraege', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'von', f.von_name, 'meins', f.von = auth.uid(), 'data', f.data, 'created', f.created) order by f.created)
                           from public.fin_eintraege f where f.event_id = p_event), '[]'::jsonb),
    -- Wer zur Auswahl steht: Personen am Ereignis, Zusagen samt Begleitung.
    'personen', coalesce((select jsonb_agg(distinct n) from (
        select trim(p->>'name') as n from jsonb_array_elements(case when jsonb_typeof(e.data->'people') = 'array' then e.data->'people' else '[]'::jsonb end) p
        union
        select trim(l.name) from (
          select distinct on (lower(trim(name))) name, data from public.guest_entries
          where event_id = p_event and kind = 'rsvp' order by lower(trim(name)), created desc) l
        where coalesce(l.data->>'kommt', '') = 'ja'
        union
        select trim(pl->>'name') from (
          select distinct on (lower(trim(name))) name, data from public.guest_entries
          where event_id = p_event and kind = 'rsvp' order by lower(trim(name)), created desc) l2
          cross join lateral jsonb_array_elements(case when jsonb_typeof(l2.data->'plusListe') = 'array' then l2.data->'plusListe' else '[]'::jsonb end) pl
        where coalesce(l2.data->>'kommt', '') = 'ja'
      ) q where coalesce(n, '') <> ''), '[]'::jsonb)
  );
end; $$;
grant execute on function public.fin_view(uuid, text) to authenticated;

-- Neu anlegen (p_id leer) oder eigenen Eintrag ändern.
create or replace function public.fin_setzen(p_event uuid, p_token text, p_id uuid, p_data jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare n int; nid uuid; ich text;
begin
  if not public.fin_ok(p_event, p_token) then raise exception 'D-31'; end if;
  if exists (select 1 from public.fin_status where event_id = p_event and zu) then raise exception 'D-32'; end if;
  if jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 8000 then raise exception 'D-08'; end if;
  select coalesce(username, '') into ich from public.profiles where id = auth.uid();
  if p_id is null then
    select count(*) into n from public.fin_eintraege where event_id = p_event;
    if n >= 500 then raise exception 'D-27'; end if;
    insert into public.fin_eintraege (event_id, von, von_name, data) values (p_event, auth.uid(), coalesce(ich, ''), p_data) returning id into nid;
    return nid;
  end if;
  update public.fin_eintraege set data = p_data
   where id = p_id and event_id = p_event and (von = auth.uid() or public.fin_chef(p_event))
  returning id into nid;
  if nid is null then raise exception 'D-30'; end if;
  return nid;
end; $$;
grant execute on function public.fin_setzen(uuid, text, uuid, jsonb) to authenticated;

create or replace function public.fin_weg(p_event uuid, p_token text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.fin_ok(p_event, p_token) then raise exception 'D-31'; end if;
  if exists (select 1 from public.fin_status where event_id = p_event and zu) then raise exception 'D-32'; end if;
  delete from public.fin_eintraege where id = p_id and event_id = p_event and (von = auth.uid() or public.fin_chef(p_event));
  if not found then raise exception 'D-30'; end if;
end; $$;
grant execute on function public.fin_weg(uuid, text, uuid) to authenticated;

-- Abschließen darf jede/r mit Zugang; wieder öffnen nur, wer abgeschlossen hat, oder Inhaber/Mitbearbeitende.
create or replace function public.fin_abschluss(p_event uuid, p_token text, p_zu boolean) returns void
language plpgsql security definer set search_path = public as $$
declare ich text;
begin
  if not public.fin_ok(p_event, p_token) then raise exception 'D-31'; end if;
  select coalesce(username, '') into ich from public.profiles where id = auth.uid();
  if not p_zu and not public.fin_chef(p_event)
     and not exists (select 1 from public.fin_status where event_id = p_event and wer_id = auth.uid()) then raise exception 'D-30'; end if;
  insert into public.fin_status (event_id, zu, wer, wer_id, wann) values (p_event, p_zu, coalesce(ich, ''), auth.uid(), now())
  on conflict (event_id) do update set zu = excluded.zu, wer = excluded.wer, wer_id = excluded.wer_id, wann = excluded.wann;
end; $$;
grant execute on function public.fin_abschluss(uuid, text, boolean) to authenticated;

-- ============================================================
-- CHRONIK — Update 39: Gäste als Personen im Ereignis.
-- Ist es im Gästebereich eingeschaltet, wird ein Gast beim Eintragen
-- seines Namens als Besuch vermerkt und erscheint im Ereignis.
-- Einmal im Supabase-SQL-Editor ausführen (nach Update 38).
-- Mehrfach ausführen schadet nicht.
-- ============================================================

alter table public.guest_entries drop constraint if exists guest_entries_kind_check;
alter table public.guest_entries add constraint guest_entries_kind_check check (kind in ('foto', 'buch', 'rsvp', 'kom', 'vor', 'besuch'));

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
    when 'besuch' then coalesce((o->>'gaestePersonen')::boolean, false)
    when 'rsvp' then coalesce((o->>'rsvp')::boolean, false) or (jsonb_typeof(o->'fragen') = 'array' and jsonb_array_length(o->'fragen') > 0)
    else false end;
  if not erlaubt then raise exception 'D-26'; end if;
  if length(trim(coalesce(p_name, ''))) < 1 or length(p_name) > 60 or length(coalesce(p_text, '')) > 1500
     or length(coalesce(p_data::text, '')) > 8000 then raise exception 'D-08'; end if;
  if p_kind = 'foto' and (p_img is null or p_img not like p_event::text || '/gast-%') then raise exception 'D-08'; end if;
  if p_kind in ('kom', 'vor') and length(trim(coalesce(p_text, ''))) < 1 then raise exception 'D-08'; end if;
  -- Besuch: je Name nur einmal.
  if p_kind = 'besuch' then
    select id into nid from public.guest_entries where event_id = p_event and kind = 'besuch' and lower(trim(name)) = lower(trim(p_name)) limit 1;
    if nid is not null then return nid; end if;
  end if;
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
      'gaestePersonen', coalesce((o->>'gaestePersonen')::boolean, false),
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

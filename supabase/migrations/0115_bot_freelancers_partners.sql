-- 0115: freelancers and partner companies, as their own kinds.
--   partner: someone iklipse works with who is neither on the team nor a
--     client: a freelancer (one person) or a partner company (a contractor,
--     an agency we team up with). Kept by name, even before iklipse has a
--     number for them. Nobody is deleted: one we stop working with is turned
--     off (is_active false), like the team's inactive people, so what was
--     said with them stays in the archive.
--   wa_other.partner_id: whose person a "not a client" number is (0101): the
--     freelancer themselves, or someone at a partner company.
--   wa_group.partner_id: a group with a freelancer or a partner company. It
--     stays kind 'client' (watched for alerts like any group with people from
--     outside), but the bot notes the people there who aren't on the team as
--     that partner's, never as clients (whatsapp-bot people.ts). A client
--     someone added by hand, or one on a project, stays a client.
-- The bot lists the team, the freelancers and the partner companies apart,
-- and writes to the partners' people privately like it writes to clients.

create table if not exists public.partner (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> ''),
  kind       text not null check (kind in ('freelancer', 'company')),
  note       text,
  is_active  boolean not null default true,
  created_by uuid references public.profile(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists partner_name_idx on public.partner (lower(btrim(name)));
alter table public.partner enable row level security;
-- Read and written by the whatsapp-bot function (service role) only, like wa_other.
revoke all on public.partner from anon, authenticated;

alter table public.wa_other add column if not exists partner_id uuid references public.partner(id) on delete set null;
create index if not exists wa_other_partner_idx on public.wa_other (partner_id) where partner_id is not null;

alter table public.wa_group add column if not exists partner_id uuid references public.partner(id) on delete set null;
create index if not exists wa_group_partner_idx on public.wa_group (partner_id) where partner_id is not null;

notify pgrst, 'reload schema';

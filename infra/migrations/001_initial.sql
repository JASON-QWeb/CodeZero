create table if not exists tasks (
  id text primary key,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists task_events (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  type text not null,
  level text not null,
  message text not null,
  metadata jsonb,
  created_at timestamptz not null
);

create table if not exists artifacts (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  type text not null,
  path text,
  url text,
  metadata jsonb,
  created_at timestamptz not null
);


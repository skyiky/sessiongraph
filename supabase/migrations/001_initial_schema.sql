-- Enable pgvector extension
create extension if not exists vector with schema extensions;

-- Enable pgcrypto for gen_random_bytes
create extension if not exists pgcrypto with schema extensions;

-- User profiles (linked to Supabase Auth)
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  api_key text unique not null default encode(extensions.gen_random_bytes(32), 'hex'),
  settings jsonb default '{}',
  created_at timestamptz default now()
);

-- Sessions (one per AI agent conversation)
create table sessions (
  id text primary key,
  user_id uuid references profiles(id) on delete cascade not null,
  tool text not null,
  project text,
  started_at timestamptz not null,
  ended_at timestamptz,
  summary text,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

-- Reasoning chains (extracted decisions, explorations, rejections, solutions, insights)
create table reasoning_chains (
  id uuid primary key default gen_random_uuid(),
  session_id text references sessions(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade not null,
  type text not null check (type in ('decision', 'exploration', 'rejection', 'solution', 'insight')),
  title text not null,
  content text not null,
  context text,
  tags text[] default '{}',
  embedding extensions.vector(384),
  created_at timestamptz default now()
);

-- Raw session chunks (conversation turns for reference/replay)
create table session_chunks (
  id uuid primary key default gen_random_uuid(),
  session_id text references sessions(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  chunk_index integer not null,
  created_at timestamptz default now()
);

-- Indexes
create index idx_reasoning_embedding on reasoning_chains using hnsw (embedding extensions.vector_cosine_ops);
create index idx_sessions_user_time on sessions (user_id, started_at desc);
create index idx_reasoning_user_time on reasoning_chains (user_id, created_at desc);
create index idx_reasoning_session on reasoning_chains (session_id);
create index idx_chunks_session on session_chunks (session_id, chunk_index);

-- Row Level Security
alter table profiles enable row level security;
alter table sessions enable row level security;
alter table reasoning_chains enable row level security;
alter table session_chunks enable row level security;

-- RLS Policies (users can only access their own data)
create policy "users_own_profiles" on profiles for all using (auth.uid() = id);
create policy "users_own_sessions" on sessions for all using (auth.uid() = user_id);
create policy "users_own_reasoning" on reasoning_chains for all using (auth.uid() = user_id);
create policy "users_own_chunks" on session_chunks for all using (auth.uid() = user_id);

-- Auto-create profile on signup
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into profiles (id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Similarity search function
create or replace function search_reasoning(
  query_embedding extensions.vector(384),
  match_threshold float default 0.7,
  match_count int default 10,
  filter_user_id uuid default null,
  filter_project text default null
)
returns table (
  id uuid,
  session_id text,
  type text,
  title text,
  content text,
  context text,
  tags text[],
  similarity float,
  created_at timestamptz
)
language plpgsql as $$
begin
  return query
  select
    rc.id,
    rc.session_id,
    rc.type,
    rc.title,
    rc.content,
    rc.context,
    rc.tags,
    1 - (rc.embedding <=> query_embedding) as similarity,
    rc.created_at
  from reasoning_chains rc
  where rc.user_id = filter_user_id
    and (filter_project is null or rc.session_id in (
      select s.id from sessions s where s.project = filter_project
    ))
    and rc.embedding is not null
    and 1 - (rc.embedding <=> query_embedding) > match_threshold
  order by rc.embedding <=> query_embedding
  limit match_count;
end;
$$;

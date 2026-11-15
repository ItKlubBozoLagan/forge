create table users (
    id bigserial primary key,
    -- subject at the identity provider (the kontestis user id); null for dev-login users
    external_id text unique,
    name text not null,
    email text,
    picture text,
    created_at timestamptz not null default now()
);

create table sessions (
    token_hash text primary key,
    user_id bigint not null references users on delete cascade,
    expires_at timestamptz not null
);

create table tokens (
    id bigserial primary key,
    user_id bigint not null references users on delete cascade,
    name text not null,
    token_hash text not null unique,
    created_at timestamptz not null default now(),
    last_used_at timestamptz
);

create table workspaces (
    id bigserial primary key,
    name text not null,
    -- the kontestis organisation this workspace mirrors; the hook for linking the two systems
    kontestis_org_id text unique,
    -- hardware class the contests of this workspace are judged on; calibration trusts only it
    reference_class text,
    created_at timestamptz not null default now()
);

create table memberships (
    workspace_id bigint not null references workspaces on delete cascade,
    user_id bigint not null references users on delete cascade,
    role text not null check (role in ('owner', 'member')),
    primary key (workspace_id, user_id)
);

create table problems (
    id bigserial primary key,
    workspace_id bigint not null references workspaces on delete cascade,
    name text not null,
    title text not null,
    -- working copy: path -> { hash, size }
    draft_tree jsonb not null default '{}',
    draft_version integer not null default 1,
    created_by bigint not null references users,
    created_at timestamptz not null default now(),
    unique (workspace_id, name)
);

create table problem_access (
    problem_id bigint not null references problems on delete cascade,
    user_id bigint not null references users on delete cascade,
    role text not null check (role in ('owner', 'author', 'viewer', 'tester')),
    primary key (problem_id, user_id)
);

-- Blobs are content addressed, but a hash is only readable through a workspace that
-- references it, so one tenant cannot probe for another tenant's data by hash.
create table blobs (
    workspace_id bigint not null references workspaces on delete cascade,
    hash text not null,
    size bigint not null,
    created_at timestamptz not null default now(),
    primary key (workspace_id, hash)
);

create table revisions (
    id bigserial primary key,
    problem_id bigint not null references problems on delete cascade,
    number integer not null,
    parent_id bigint references revisions,
    tree jsonb not null,
    message text not null,
    author_id bigint not null references users,
    created_at timestamptz not null default now(),
    unique (problem_id, number)
);

create table builds (
    id bigserial primary key,
    problem_id bigint not null references problems on delete cascade,
    revision_id bigint references revisions on delete cascade,
    kind text not null check (kind in ('build', 'invocation', 'stress')),
    tree jsonb not null,
    params jsonb not null default '{}',
    status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
    result text check (result in ('green', 'red')),
    progress jsonb not null default '{}',
    report jsonb,
    error text,
    created_by bigint not null references users,
    created_at timestamptz not null default now(),
    started_at timestamptz,
    finished_at timestamptz
);
create index builds_problem on builds (problem_id, id desc);
create index builds_queue on builds (id) where status = 'queued';

-- The build cache: every step is a pure function of its inputs, keyed by their hash.
create table build_nodes (
    workspace_id bigint not null references workspaces on delete cascade,
    key text not null,
    kind text not null,
    result jsonb not null,
    created_at timestamptz not null default now(),
    primary key (workspace_id, key)
);

-- Run time is a measurement, not a pure function: each run adds a sample tagged with where
-- it ran, so calibration can restrict itself to the judging hardware.
create table timing_samples (
    id bigserial primary key,
    workspace_id bigint not null references workspaces on delete cascade,
    node_key text not null,
    runner_pool text not null,
    hardware_class text not null,
    time_ms integer not null,
    memory_kb integer not null,
    measured_at timestamptz not null default now()
);
create index timing_samples_node on timing_samples (workspace_id, node_key);

create table threads (
    id bigserial primary key,
    problem_id bigint not null references problems on delete cascade,
    revision_id bigint references revisions on delete set null,
    path text,
    line integer,
    resolved boolean not null default false,
    created_by bigint not null references users,
    created_at timestamptz not null default now()
);

create table comments (
    id bigserial primary key,
    thread_id bigint not null references threads on delete cascade,
    author_id bigint not null references users,
    body text not null,
    created_at timestamptz not null default now()
);

create table audit_log (
    id bigserial primary key,
    workspace_id bigint not null references workspaces on delete cascade,
    problem_id bigint,
    user_id bigint references users,
    action text not null,
    detail jsonb not null default '{}',
    at timestamptz not null default now()
);
create index audit_workspace on audit_log (workspace_id, id desc);

create table problem_sets (
    id bigserial primary key,
    workspace_id bigint not null references workspaces on delete cascade,
    name text not null,
    created_by bigint not null references users,
    created_at timestamptz not null default now()
);

create table problem_set_entries (
    set_id bigint not null references problem_sets on delete cascade,
    label text not null,
    problem_id bigint not null references problems on delete cascade,
    revision_id bigint not null references revisions,
    position integer not null,
    primary key (set_id, label)
);

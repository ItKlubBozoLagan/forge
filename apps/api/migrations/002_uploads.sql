-- Content uploaded for a problem before a sync refers to it. Together with the problem's trees
-- and build reports this decides which blobs a problem's members may read: blobs are stored
-- per workspace, but a problem only gives access to its own.
create table problem_uploads (
    problem_id bigint not null references problems(id) on delete cascade,
    hash text not null,
    created_at timestamptz not null default now(),
    primary key (problem_id, hash)
);

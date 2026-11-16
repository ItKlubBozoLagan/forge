import { useQuery } from "@tanstack/react-query";

import { api, q } from "./api";
import type {
    AuthConfig,
    BuildDetail,
    BuildKind,
    BuildSummary,
    Me,
    Member,
    Problem,
    ProblemSummary,
    Revision,
    Tree,
} from "./types";

export const keys = {
    me: ["me"] as const,
    authConfig: ["auth-config"] as const,
    problems: (workspaceId: string) => ["problems", workspaceId] as const,
    problem: (id: string) => ["problem", id] as const,
    tree: (id: string) => ["tree", id] as const,
    file: (id: string, path: string) => ["file", id, path] as const,
    builds: (id: string, kind: BuildKind) => ["builds", id, kind] as const,
    build: (id: string) => ["build", id] as const,
    timing: (id: string) => ["timing", id] as const,
    revisions: (id: string) => ["revisions", id] as const,
    statement: (id: string, lang?: string) => ["statement", id, lang ?? ""] as const,
    threads: (id: string) => ["threads", id] as const,
    access: (id: string) => ["access", id] as const,
    members: (workspaceId: string) => ["members", workspaceId] as const,
    audit: (workspaceId: string) => ["audit", workspaceId] as const,
    sets: (workspaceId: string) => ["sets", workspaceId] as const,
    set: (id: string) => ["set", id] as const,
    tokens: ["tokens"] as const,
};

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api.get<Me>("/me") });

export const useAuthConfig = () =>
    useQuery({ queryKey: keys.authConfig, queryFn: () => api.get<AuthConfig>("/auth/config") });

export const useProblems = (workspaceId: string) =>
    useQuery({
        queryKey: keys.problems(workspaceId),
        queryFn: () => api.get<ProblemSummary[]>(`/workspaces/${workspaceId}/problems`),
        enabled: !!workspaceId,
    });

export const useProblem = (id: string) =>
    useQuery({ queryKey: keys.problem(id), queryFn: () => api.get<Problem>(`/problems/${id}`) });

export const useTree = (id: string, enabled = true) =>
    useQuery({
        queryKey: keys.tree(id),
        queryFn: () => api.get<Tree>(`/problems/${id}/tree`),
        enabled,
    });

export const useRevisions = (id: string, enabled = true) =>
    useQuery({
        queryKey: keys.revisions(id),
        queryFn: () => api.get<Revision[]>(`/problems/${id}/revisions`),
        enabled: enabled && !!id,
        // a revision is built as soon as it is committed: keep its status moving
        refetchInterval: (query) =>
            query.state.data?.some((revision) => active(revision.build?.status)) ? 2000 : false,
    });

function active(status: string | undefined) {
    return status === "queued" || status === "running";
}

export const useBuilds = (id: string, kind: BuildKind) =>
    useQuery({
        queryKey: keys.builds(id, kind),
        queryFn: () => api.get<BuildSummary[]>(`/problems/${id}/builds${q({ kind })}`),
        refetchInterval: (query) =>
            query.state.data?.some((build) => active(build.status)) ? 2000 : false,
    });

/** A build's detail, polled about once a second while it is queued or running. */
export const useBuild = <O>(buildId: string | undefined) =>
    useQuery({
        queryKey: keys.build(buildId ?? ""),
        queryFn: () => api.get<BuildDetail<O>>(`/builds/${buildId}`),
        enabled: !!buildId,
        refetchInterval: (query) => (active(query.state.data?.status) ? 1000 : false),
    });

export const useMembers = (workspaceId: string | undefined) =>
    useQuery({
        queryKey: keys.members(workspaceId ?? ""),
        queryFn: () => api.get<Member[]>(`/workspaces/${workspaceId}/members`),
        enabled: !!workspaceId,
    });

export const isActive = active;

/** Problem roles and what they may do (mirrors the API's capabilities). */
export const can = (role: string | undefined, capability: "read" | "write" | "manage") => {
    if (!role) return false;
    if (capability === "read") return role === "owner" || role === "author" || role === "viewer";
    if (capability === "write") return role === "owner" || role === "author";
    return role === "owner";
};

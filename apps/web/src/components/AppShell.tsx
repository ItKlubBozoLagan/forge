import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Hammer, KeyRound, LogOut, Plus } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";

import { api, ApiError } from "../lib/api";
import { keys, useMe } from "../lib/queries";
import type { Workspace } from "../lib/types";
import { useWorkspaceState } from "../lib/workspace";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { Dialog } from "../ui/Dialog";
import { Field, Input } from "../ui/Field";
import { ErrorNotice, Loading } from "../ui/misc";
import { useToast } from "../ui/Toast";

/** Gate for every signed-in page: a 401 from /me sends the user to /login and back. */
export const RequireAuth = () => {
    const me = useMe();
    const location = useLocation();
    if (me.isPending) return <Loading label="Signing in" />;
    if (me.error) {
        if (me.error instanceof ApiError && me.error.status === 401) {
            const redirect = `${location.pathname}${location.search}`;
            return <Navigate to={`/login?redirect=${encodeURIComponent(redirect)}`} replace />;
        }
        return (
            <div className="mx-auto max-w-lg p-6">
                <ErrorNotice error={me.error} />
                <Button className="mt-3" onClick={() => me.refetch()}>
                    Retry
                </Button>
            </div>
        );
    }
    return <Outlet />;
};

/** `/`: go to the last used workspace, or the first one. */
export const HomeRedirect = () => {
    const me = useMe();
    const { current } = useWorkspaceState();
    const workspaces = me.data?.workspaces ?? [];
    const target = workspaces.find((workspace) => workspace.id === current) ?? workspaces[0];
    if (!target)
        return (
            <div className="mx-auto flex max-w-lg flex-col items-center gap-3 p-6 text-center text-muted">
                You are not a member of any workspace yet. Ask a workspace owner to add you, or
                create your own.
                <NewWorkspaceButton />
            </div>
        );
    return <Navigate to={`/w/${target.id}`} replace />;
};

/** A button that opens a small dialog to create a workspace, then goes to it. */
const NewWorkspaceButton = ({ compact }: { compact?: boolean }) => {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const { setCurrent } = useWorkspaceState();

    const close = () => {
        setOpen(false);
        setName("");
        setError(undefined);
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        setError(undefined);
        try {
            const created = await api.post<Pick<Workspace, "id" | "name" | "role">>("/workspaces", {
                name: name.trim(),
            });
            await queryClient.invalidateQueries({ queryKey: keys.me });
            setCurrent(created.id);
            close();
            navigate(`/w/${created.id}`);
        } catch (caught) {
            setError(caught);
        } finally {
            setPending(false);
        }
    };

    return (
        <>
            <Button
                size="sm"
                variant={compact ? "ghost" : "secondary"}
                icon={<Plus className="size-3.5" />}
                aria-label={compact ? "New workspace" : undefined}
                title="Create a workspace"
                onClick={() => setOpen(true)}
            >
                {compact ? undefined : "New workspace"}
            </Button>
            <Dialog
                open={open}
                onClose={close}
                title="New workspace"
                description="A workspace holds problems, problem sets and their members. You become its owner."
            >
                <form onSubmit={submit} className="flex flex-col gap-3">
                    <Field label="Workspace name">
                        {(id) => (
                            <Input
                                id={id}
                                value={name}
                                required
                                maxLength={80}
                                autoFocus
                                placeholder="Regional olympiad 2027"
                                onChange={(event) => setName(event.target.value)}
                            />
                        )}
                    </Field>
                    {error !== undefined && <ErrorNotice error={error} />}
                    <div className="flex justify-end gap-2 pt-1">
                        <Button onClick={close}>Cancel</Button>
                        <Button
                            type="submit"
                            variant="primary"
                            pending={pending}
                            disabled={!name.trim()}
                        >
                            Create workspace
                        </Button>
                    </div>
                </form>
            </Dialog>
        </>
    );
};

const UserMenu = () => {
    const me = useMe();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const toast = useToast();
    const [pending, setPending] = useState(false);

    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (!ref.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const user = me.data?.user;
    if (!user) return null;
    const signOut = async () => {
        setPending(true);
        try {
            await api.post("/auth/logout");
            queryClient.clear();
            navigate("/login");
        } catch (error) {
            toast.error(error);
        } finally {
            setPending(false);
        }
    };
    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm hover:bg-surface-2"
            >
                {user.picture ? (
                    <img src={user.picture} alt="" className="size-6 rounded-full" />
                ) : (
                    <span
                        aria-hidden
                        className="flex size-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
                    >
                        {user.name.slice(0, 1).toUpperCase()}
                    </span>
                )}
                <span className="hidden max-w-32 truncate sm:inline">{user.name}</span>
                <ChevronDown className="size-3.5 text-muted" aria-hidden />
            </button>
            {open && (
                <div
                    role="menu"
                    aria-label="User menu"
                    className="absolute right-0 top-9 z-50 w-56 rounded-lg border border-line bg-surface p-1 shadow-[var(--shadow)]"
                >
                    <div className="border-b border-line px-2 py-1.5">
                        <div className="truncate text-sm font-medium">{user.name}</div>
                        {user.email && (
                            <div className="truncate text-xs text-muted">{user.email}</div>
                        )}
                    </div>
                    <Link
                        role="menuitem"
                        to="/tokens"
                        onClick={() => setOpen(false)}
                        className="mt-1 flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-2"
                    >
                        <KeyRound className="size-4 text-muted" aria-hidden />
                        Access tokens
                    </Link>
                    <button
                        role="menuitem"
                        type="button"
                        disabled={pending}
                        onClick={signOut}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                    >
                        <LogOut className="size-4 text-muted" aria-hidden />
                        Sign out
                    </button>
                </div>
            )}
        </div>
    );
};

const navClass = ({ isActive }: { isActive: boolean }) =>
    cx(
        "inline-flex h-8 items-center rounded-md px-2.5 text-sm whitespace-nowrap",
        isActive
            ? "bg-surface-2 text-fg font-medium"
            : "text-muted hover:text-fg hover:bg-surface-2",
    );

export const AppShell = () => {
    const me = useMe();
    const { current, setCurrent } = useWorkspaceState();
    const navigate = useNavigate();
    const workspaces = me.data?.workspaces ?? [];
    const workspace = workspaces.find((item) => item.id === current) ?? workspaces[0];

    return (
        <div className="flex min-h-dvh flex-col">
            <header className="sticky top-0 z-40 border-b border-line bg-surface">
                <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
                    <Link
                        to={workspace ? `/w/${workspace.id}` : "/"}
                        className="flex items-center gap-1.5 font-semibold tracking-tight"
                    >
                        <Hammer className="size-4 text-accent" aria-hidden />
                        Forge
                    </Link>
                    {workspaces.length > 0 && (
                        <>
                            <label htmlFor="workspace-switcher" className="sr-only">
                                Workspace
                            </label>
                            <select
                                id="workspace-switcher"
                                value={workspace?.id}
                                onChange={(event) => {
                                    setCurrent(event.target.value);
                                    navigate(`/w/${event.target.value}`);
                                }}
                                className="h-8 max-w-48 cursor-pointer truncate rounded-md border border-line bg-surface px-2 text-sm hover:border-line-strong"
                            >
                                {workspaces.map((item) => (
                                    <option key={item.id} value={item.id}>
                                        {item.name}
                                    </option>
                                ))}
                            </select>
                        </>
                    )}
                    <NewWorkspaceButton compact={workspaces.length > 0} />
                    <nav
                        aria-label="Main"
                        className="order-last flex w-full gap-1 overflow-x-auto md:order-none md:w-auto"
                    >
                        {workspace && (
                            <>
                                <NavLink to={`/w/${workspace.id}`} end className={navClass}>
                                    Problems
                                </NavLink>
                                <NavLink to={`/w/${workspace.id}/sets`} className={navClass}>
                                    Problem sets
                                </NavLink>
                                <NavLink to={`/w/${workspace.id}/settings`} className={navClass}>
                                    Settings
                                </NavLink>
                            </>
                        )}
                    </nav>
                    <div className="ml-auto">
                        <UserMenu />
                    </div>
                </div>
            </header>
            <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-4">
                <Outlet />
            </main>
        </div>
    );
};

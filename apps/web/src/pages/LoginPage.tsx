import { useQueryClient } from "@tanstack/react-query";
import { Hammer, LogIn } from "lucide-react";
import { FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { api } from "../lib/api";
import { keys, useAuthConfig } from "../lib/queries";
import { Button, buttonClass } from "../ui/Button";
import { cx } from "../ui/cx";
import { Field, Input } from "../ui/Field";
import { ErrorNotice, Loading } from "../ui/misc";

/** Only same-site paths are accepted as a post-login destination. */
export const safeRedirect = (value: string | null) =>
    value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
        ? value
        : "/";

export const LoginPage = () => {
    const [params] = useSearchParams();
    const redirect = safeRedirect(params.get("redirect"));
    const callbackError = params.get("error");
    const config = useAuthConfig();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [name, setName] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();

    const devLogin = async (event: FormEvent) => {
        event.preventDefault();
        setPending(true);
        setError(undefined);
        try {
            await api.post("/auth/dev-login", { name: name.trim() });
            await queryClient.resetQueries({ queryKey: keys.me });
            navigate(redirect, { replace: true });
        } catch (caught) {
            setError(caught);
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="flex min-h-dvh items-center justify-center px-4">
            <div className="w-full max-w-sm">
                <div className="mb-6 flex items-center justify-center gap-2 text-xl font-semibold">
                    <Hammer className="size-5 text-accent" aria-hidden />
                    Forge
                </div>
                <div className="rounded-lg border border-line bg-surface p-5 shadow-[var(--shadow)]">
                    <h1 className="text-base font-semibold">Sign in</h1>
                    <p className="mb-4 text-sm text-muted">
                        Prepare, test and calibrate contest problems.
                    </p>
                    {callbackError && (
                        <ErrorNotice className="mb-4" error={new Error(callbackError)} />
                    )}
                    {config.isPending && <Loading />}
                    {config.error && <ErrorNotice error={config.error} />}
                    {config.data?.oauth && (
                        <a
                            href={`/api/auth/login?redirect=${encodeURIComponent(redirect)}`}
                            className={cx(buttonClass("primary"), "w-full")}
                        >
                            <LogIn className="size-4" aria-hidden />
                            Sign in with Kontestis
                        </a>
                    )}
                    {config.data?.devLogin && (
                        <form
                            onSubmit={devLogin}
                            className={cx(
                                "flex flex-col gap-3",
                                config.data.oauth && "mt-5 border-t border-line pt-4",
                            )}
                        >
                            <h2 className="text-[13px] font-medium text-muted">
                                Development login
                            </h2>
                            <Field label="Name">
                                {(id) => (
                                    <Input
                                        id={id}
                                        value={name}
                                        required
                                        autoFocus={!config.data.oauth}
                                        autoComplete="username"
                                        onChange={(event) => setName(event.target.value)}
                                    />
                                )}
                            </Field>
                            {error !== undefined && <ErrorNotice error={error} />}
                            <Button
                                type="submit"
                                variant={config.data.oauth ? "secondary" : "primary"}
                                pending={pending}
                                disabled={!name.trim()}
                            >
                                Sign in
                            </Button>
                        </form>
                    )}
                    {config.data && !config.data.oauth && !config.data.devLogin && (
                        <p className="text-sm text-muted">
                            No sign-in method is configured on this server.
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

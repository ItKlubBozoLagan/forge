import { Terminal } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";

import { api } from "../lib/api";
import { useMe } from "../lib/queries";
import { Button, ButtonLink } from "../ui/Button";
import { ErrorNotice, Notice } from "../ui/misc";

const parsePort = (value: string | null) => {
    if (!value || !/^\d+$/.test(value)) return undefined;
    const port = Number(value);
    return port >= 1024 && port <= 65535 ? port : undefined;
};

export const CliLoginPage = () => {
    const [params] = useSearchParams();
    const port = parsePort(params.get("port"));
    const state = params.get("state");
    const me = useMe();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    const [done, setDone] = useState(false);

    const authorize = async () => {
        if (!port || !state) return;
        setPending(true);
        setError(undefined);
        try {
            const date = new Date().toISOString().slice(0, 10);
            const created = await api.post<{ id: string; token: string }>("/tokens", {
                name: `CLI ${date}`,
            });
            setDone(true);
            const target = new URL(`http://127.0.0.1:${port}/callback`);
            target.searchParams.set("token", created.token);
            target.searchParams.set("state", state);
            window.location.assign(target.toString());
        } catch (caught) {
            setError(caught);
            setPending(false);
        }
    };

    return (
        <div className="mx-auto max-w-md py-8">
            <div className="rounded-lg border border-line bg-surface p-5">
                <div className="mb-3 flex items-center gap-2">
                    <Terminal className="size-5 text-accent" aria-hidden />
                    <h1 className="text-base font-semibold">Authorize the Forge CLI</h1>
                </div>
                {!port || !state ? (
                    <ErrorNotice
                        error={
                            new Error(
                                !port
                                    ? "This link is invalid: the port must be a number between 1024 and 65535. Run the login command again."
                                    : "This link is invalid: it has no state. Run the login command again.",
                            )
                        }
                    />
                ) : (
                    <>
                        <p className="text-sm">
                            The Forge CLI on this computer is asking for access to your account
                            {me.data ? (
                                <>
                                    {" "}
                                    (<strong>{me.data.user.name}</strong>)
                                </>
                            ) : null}
                            . Authorizing creates a personal access token and hands it to the CLI
                            listening on port <span className="font-mono">{port}</span>.
                        </p>
                        <p className="mt-2 text-sm text-muted">
                            Only continue if you just started the login from your terminal. You can
                            revoke the token at any time under Access tokens.
                        </p>
                        {error !== undefined && <ErrorNotice className="mt-3" error={error} />}
                        {done && (
                            <Notice tone="success" className="mt-3">
                                Authorized. Returning to the CLI...
                            </Notice>
                        )}
                        <div className="mt-4 flex gap-2">
                            <Button variant="primary" pending={pending} onClick={authorize}>
                                Authorize
                            </Button>
                            <ButtonLink to="/">Cancel</ButtonLink>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

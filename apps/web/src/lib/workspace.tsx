import { createContext, ReactNode, useContext, useEffect, useState } from "react";

const STORAGE_KEY = "forge.workspace";

const readStored = () => {
    try {
        return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
    } catch {
        return undefined;
    }
};

type WorkspaceState = { current?: string; setCurrent: (id: string) => void };
const WorkspaceContext = createContext<WorkspaceState>({ setCurrent: () => {} });

/** Tracks the workspace the user is working in; the last one is remembered across visits. */
export const WorkspaceProvider = ({ children }: { children: ReactNode }) => {
    const [current, setState] = useState<string | undefined>(readStored);
    const setCurrent = (id: string) => {
        setState(id);
        try {
            window.localStorage.setItem(STORAGE_KEY, id);
        } catch {
            // storage unavailable: still works for this visit
        }
    };
    return (
        <WorkspaceContext.Provider value={{ current, setCurrent }}>
            {children}
        </WorkspaceContext.Provider>
    );
};

export const useWorkspaceState = () => useContext(WorkspaceContext);

/** Pages scoped to a workspace call this so the shell's switcher and nav follow them. */
export const useSyncWorkspace = (id: string | undefined) => {
    const { current, setCurrent } = useWorkspaceState();
    useEffect(() => {
        if (id && id !== current) setCurrent(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);
};

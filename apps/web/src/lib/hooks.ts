import { useEffect, useState } from "react";

const query = "(prefers-color-scheme: dark)";

export const useDarkMode = () => {
    const [dark, setDark] = useState(() => window.matchMedia?.(query).matches ?? false);
    useEffect(() => {
        const media = window.matchMedia?.(query);
        if (!media) return;
        const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, []);
    return dark;
};

/** Re-renders every `ms` while `enabled`, for "x seconds ago" style labels. */
export const useTicker = (enabled: boolean, ms = 1000) => {
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!enabled) return;
        const id = window.setInterval(() => setTick((tick) => tick + 1), ms);
        return () => window.clearInterval(id);
    }, [enabled, ms]);
};

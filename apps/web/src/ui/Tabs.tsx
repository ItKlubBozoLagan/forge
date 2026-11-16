import { KeyboardEvent, ReactNode, useRef } from "react";
import { NavLink } from "react-router";

import { cx } from "./cx";

const tabClass = (active: boolean) =>
    cx(
        "relative inline-flex h-9 items-center gap-1.5 px-3 text-sm whitespace-nowrap transition-colors",
        "border-b-2 -mb-px",
        active
            ? "border-accent text-fg font-medium"
            : "border-transparent text-muted hover:text-fg hover:border-line-strong",
    );

/** In-page tabs with real tab semantics and arrow-key navigation. */
export const Tabs = <T extends string>({
    tabs,
    value,
    onChange,
    label,
    className,
}: {
    tabs: Array<{ value: T; label: ReactNode }>;
    value: T;
    onChange: (value: T) => void;
    label: string;
    className?: string;
}) => {
    const refs = useRef<Array<HTMLButtonElement | null>>([]);
    const onKeyDown = (event: KeyboardEvent, index: number) => {
        let next = -1;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        if (next < 0) return;
        event.preventDefault();
        refs.current[next]?.focus();
        onChange(tabs[next]!.value);
    };
    return (
        <div
            role="tablist"
            aria-label={label}
            className={cx("flex overflow-x-auto border-b border-line", className)}
        >
            {tabs.map((tab, index) => (
                <button
                    key={tab.value}
                    ref={(element) => {
                        refs.current[index] = element;
                    }}
                    type="button"
                    role="tab"
                    aria-selected={tab.value === value}
                    tabIndex={tab.value === value ? 0 : -1}
                    className={tabClass(tab.value === value)}
                    onClick={() => onChange(tab.value)}
                    onKeyDown={(event) => onKeyDown(event, index)}
                >
                    {tab.label}
                </button>
            ))}
        </div>
    );
};

/** Route-backed tabs: navigation links styled as tabs, aria-current marks the active one. */
export const NavTabs = ({
    links,
    label,
}: {
    links: Array<{ to: string; label: ReactNode; end?: boolean }>;
    label: string;
}) => (
    <nav aria-label={label} className="flex overflow-x-auto border-b border-line">
        {links.map((link) => (
            <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) => tabClass(isActive)}
            >
                {link.label}
            </NavLink>
        ))}
    </nav>
);

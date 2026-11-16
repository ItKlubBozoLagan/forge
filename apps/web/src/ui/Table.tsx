import { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

import { cx } from "./cx";

export const TableWrap = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
    <div
        className={cx("relative overflow-x-auto rounded-lg border border-line bg-surface", className)}
        {...rest}
    />
);

export const Table = ({ className, ...rest }: HTMLAttributes<HTMLTableElement>) => (
    <table className={cx("w-full border-collapse text-sm", className)} {...rest} />
);

export const Th = ({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) => (
    <th
        className={cx(
            "border-b border-line bg-surface-2 px-3 py-1.5 text-left text-xs font-medium text-muted whitespace-nowrap",
            className,
        )}
        {...rest}
    />
);

export const Td = ({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className={cx("border-b border-line px-3 py-1.5 align-middle", className)} {...rest} />
);

export const Tr = ({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) => (
    <tr className={cx("last:[&>td]:border-b-0 hover:bg-surface-2/50", className)} {...rest} />
);

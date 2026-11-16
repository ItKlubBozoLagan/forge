import { HEADROOM_TARGET, SEPARATION_TARGET } from "@forge/core";
import type { ReactNode } from "react";
import type { Calibration } from "@forge/core";

import { basename, formatMs } from "../../../lib/format";
import { Badge } from "../../../ui/Badge";
import { Card } from "../../../ui/misc";

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1">
        <dt className="text-[13px] text-muted">{label}</dt>
        <dd className="text-right text-[13px]">{children}</dd>
    </div>
);

const Ratio = ({ value, target, label }: { value?: number; target: number; label: string }) => {
    if (value === undefined) return <span className="text-subtle">-</span>;
    const ok = value >= target;
    return (
        <span className="inline-flex items-center gap-1.5">
            <span className="font-mono">{value}×</span>
            <Badge
                tone={ok ? "success" : "warning"}
                title={`${label}: aim for at least ${target}×`}
            >
                {ok ? "ok" : `below ${target}×`}
            </Badge>
        </span>
    );
};

/** Horizontal scale showing where the measured times fall relative to the limit. */
const Scale = ({ calibration }: { calibration: Calibration }) => {
    const { timeLimitMs, slowestAcceptedMs, fastestRejectedMs, suggestedMs } = calibration;
    const max =
        Math.max(timeLimitMs, slowestAcceptedMs ?? 0, fastestRejectedMs ?? 0, suggestedMs ?? 0) *
        1.12;
    const at = (ms: number) => `${Math.min(100, (ms / max) * 100)}%`;
    const markers = [
        slowestAcceptedMs !== undefined && {
            ms: slowestAcceptedMs,
            label: "slowest accepted",
            className: "bg-success",
        },
        fastestRejectedMs !== undefined && {
            ms: fastestRejectedMs,
            label: "fastest rejected",
            className: "bg-warning",
        },
    ].filter(Boolean) as Array<{ ms: number; label: string; className: string }>;
    return (
        <figure className="mt-3" aria-label="Time scale">
            <div className="relative h-7">
                {/* accepted zone up to the limit */}
                <div
                    className="absolute inset-y-2.5 left-0 rounded-l-full bg-success-soft"
                    style={{ width: at(timeLimitMs) }}
                />
                <div
                    className="absolute inset-y-2.5 right-0 rounded-r-full bg-danger-soft"
                    style={{ left: at(timeLimitMs) }}
                />
                <div
                    className="absolute inset-y-0 w-0.5 bg-fg"
                    style={{ left: at(timeLimitMs) }}
                    title={`limit ${timeLimitMs} ms`}
                />
                {suggestedMs !== undefined && suggestedMs !== timeLimitMs && (
                    <div
                        className="absolute inset-y-0 border-l-2 border-dashed border-accent"
                        style={{ left: at(suggestedMs) }}
                        title={`suggested ${suggestedMs} ms`}
                    />
                )}
                {markers.map((marker) => (
                    <div
                        key={marker.label}
                        className={`absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface ${marker.className}`}
                        style={{ left: at(marker.ms) }}
                        title={`${marker.label} ${marker.ms} ms`}
                    />
                ))}
            </div>
            <figcaption className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
                <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-3 w-0.5 bg-fg" aria-hidden /> limit{" "}
                    {timeLimitMs} ms
                </span>
                {slowestAcceptedMs !== undefined && (
                    <span className="inline-flex items-center gap-1">
                        <span className="inline-block size-2 rounded-full bg-success" aria-hidden />{" "}
                        slowest accepted {slowestAcceptedMs} ms
                    </span>
                )}
                {fastestRejectedMs !== undefined && (
                    <span className="inline-flex items-center gap-1">
                        <span className="inline-block size-2 rounded-full bg-warning" aria-hidden />{" "}
                        fastest rejected {fastestRejectedMs} ms
                    </span>
                )}
                {suggestedMs !== undefined && suggestedMs !== timeLimitMs && (
                    <span className="inline-flex items-center gap-1">
                        <span
                            className="inline-block h-3 border-l-2 border-dashed border-accent"
                            aria-hidden
                        />{" "}
                        suggested {suggestedMs} ms
                    </span>
                )}
            </figcaption>
        </figure>
    );
};

export const CalibrationCard = ({
    calibration,
    hardwareClass,
    referenceClass,
}: {
    calibration: Calibration;
    hardwareClass?: string;
    referenceClass?: string | null;
}) => (
    <Card title="Time limit calibration">
        <dl className="divide-y divide-line">
            <Row label="Time limit">
                <span className="font-mono">{formatMs(calibration.timeLimitMs)}</span>
            </Row>
            <Row label="Slowest accepted run">
                {calibration.slowestAcceptedMs !== undefined ? (
                    <>
                        <span className="font-mono">{formatMs(calibration.slowestAcceptedMs)}</span>{" "}
                        <span
                            className="font-mono text-xs text-muted"
                            title={calibration.slowestAccepted}
                        >
                            {basename(calibration.slowestAccepted ?? "")}
                        </span>
                    </>
                ) : (
                    <span className="text-subtle">no accepted runs</span>
                )}
            </Row>
            <Row label="Fastest rejected run">
                {calibration.fastestRejectedMs !== undefined ? (
                    <>
                        <span className="font-mono">{formatMs(calibration.fastestRejectedMs)}</span>{" "}
                        <span
                            className="font-mono text-xs text-muted"
                            title={calibration.fastestRejected}
                        >
                            {basename(calibration.fastestRejected ?? "")}
                        </span>
                    </>
                ) : (
                    <span className="text-subtle">no solution is expected to TLE</span>
                )}
            </Row>
            <Row label="Headroom (limit / slowest accepted)">
                <Ratio value={calibration.headroom} target={HEADROOM_TARGET} label="Headroom" />
            </Row>
            <Row label="Separation (fastest rejected / limit)">
                <Ratio
                    value={calibration.separation}
                    target={SEPARATION_TARGET}
                    label="Separation"
                />
            </Row>
            <Row label="Suggested limit">
                {calibration.suggestedMs !== undefined ? (
                    <span className="font-mono">{formatMs(calibration.suggestedMs)}</span>
                ) : (
                    <span className="text-subtle">none</span>
                )}
            </Row>
        </dl>
        <Scale calibration={calibration} />
        {referenceClass && hardwareClass && referenceClass !== hardwareClass && (
            <p className="mt-2 text-xs text-warning">
                Measured on <span className="font-mono">{hardwareClass}</span>, but the contest is
                judged on <span className="font-mono">{referenceClass}</span>: times may differ.
            </p>
        )}
    </Card>
);

import { Language } from "@forge/core";

import { BlobStore, Tree } from "../blobs";
import { Sql } from "../db";
import { Scheduler } from "../runner/scheduler";
import { Runner } from "../runner/types";
import { Engine } from "./engine";
import { runStress, StressParams } from "./stress";

type BuildRow = {
    id: string;
    workspace_id: string;
    kind: "build" | "invocation" | "stress";
    tree: Tree;
    params: Record<string, unknown>;
    reference_class: string | null;
};

/** Picks queued builds out of the database and runs them. */
export class Worker {
    private active = 0;
    private stopped = false;
    private idleWaiters: Array<() => void> = [];
    private pumping = false;
    private again = false;
    private running = new Map<string, AbortController>();

    constructor(
        private sql: Sql,
        private blobs: BlobStore,
        private runner: Runner,
        private scheduler: Scheduler,
        private parallelBuilds = 8,
    ) {}

    /** Builds interrupted by a restart go back to the queue. */
    async recover() {
        await this.sql`update builds set status = 'queued', started_at = null where status = 'running'`;
        this.kick();
    }

    stop() {
        this.stopped = true;
    }

    /** Resolves once no build is queued or running; used by tests. */
    async idle(): Promise<void> {
        if (this.active === 0) {
            const queued = await this.sql`select 1 from builds where status = 'queued' limit 1`;
            if (queued.length === 0) return;
        }
        await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
        return this.idle();
    }

    kick() {
        if (this.stopped) return;
        void this.pump();
    }

    /** Stops a build that is queued or running. Returns false when it already finished. */
    async cancel(id: string, reason: string): Promise<boolean> {
        const rows = await this.sql`
            update builds set status = 'failed', error = ${reason}, finished_at = now()
            where id = ${id} and status in ('queued', 'running') returning id`;
        this.running.get(id)?.abort();
        return rows.length > 0;
    }

    private async pump() {
        // one loop at a time: concurrent kicks would otherwise start more builds than allowed
        if (this.pumping) {
            this.again = true;
            return;
        }
        this.pumping = true;
        try {
            do {
                this.again = false;
                await this.claim();
            } while (this.again);
        } finally {
            this.pumping = false;
        }
    }

    private async claim() {
        while (!this.stopped && this.active < this.parallelBuilds) {
            const rows = await this.sql<BuildRow[]>`
                update builds set status = 'running', started_at = now()
                where id = (
                    select id from builds where status = 'queued' order by id limit 1 for update skip locked
                )
                returning id, kind, tree, params,
                    (select workspace_id from problems where problems.id = builds.problem_id) as workspace_id,
                    (select reference_class from workspaces join problems on problems.workspace_id = workspaces.id
                        where problems.id = builds.problem_id) as reference_class`;
            const row = rows[0];
            if (!row) break;
            this.active += 1;
            void this.execute(row).finally(() => {
                this.active -= 1;
                for (const waiter of this.idleWaiters.splice(0)) waiter();
                this.kick();
            });
        }
    }

    private async execute(row: BuildRow) {
        let lastWrite = 0;
        const controller = new AbortController();
        this.running.set(row.id, controller);
        const engine = new Engine({
            signal: controller.signal,
            workspaceId: row.workspace_id,
            tree: row.tree,
            blobs: this.blobs,
            sql: this.sql,
            runner: this.runner,
            scheduler: this.scheduler,
            referenceClass: row.reference_class,
            onProgress: (progress) => {
                const now = Date.now();
                if (now - lastWrite < 300) return;
                lastWrite = now;
                void this.sql`update builds set progress = ${this.sql.json(progress)} where id = ${row.id} and status = 'running'`.catch(() => {});
            },
        });
        try {
            if (row.kind === "stress") {
                const report = await runStress(engine, row.params as StressParams);
                await this.finish(row.id, report, report.errors.length === 0 && report.failures.length === 0 ? "green" : "red");
                return;
            }
            const adhoc = row.kind === "invocation" ? (row.params.adhoc as { name: string; language: Language; source: string }) : undefined;
            const output = await engine.build({ remeasure: row.params.remeasure === true, clean: row.params.clean === true, adhoc });
            await this.finish(row.id, output, output.report.status);
        } catch (error) {
            // a cancelled build already carries its reason
            await this.sql`
                update builds set status = 'failed', error = ${(error as Error).stack ?? String(error)}, finished_at = now()
                where id = ${row.id} and status = 'running'`;
        } finally {
            this.running.delete(row.id);
        }
    }

    private async finish(id: string, report: unknown, result: "green" | "red") {
        await this.sql`
            update builds set status = 'done', result = ${result}, report = ${this.sql.json(report as never)}, finished_at = now()
            where id = ${id} and status = 'running'`;
    }
}

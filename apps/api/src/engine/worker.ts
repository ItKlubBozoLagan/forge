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

    private async pump() {
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
        const engine = new Engine({
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
            const output = await engine.build({ remeasure: row.params.remeasure === true, adhoc });
            await this.finish(row.id, output, output.report.status);
        } catch (error) {
            await this.sql`
                update builds set status = 'failed', error = ${(error as Error).stack ?? String(error)}, finished_at = now()
                where id = ${row.id}`;
        }
    }

    private async finish(id: string, report: unknown, result: "green" | "red") {
        await this.sql`
            update builds set status = 'done', result = ${result}, report = ${this.sql.json(report as never)}, finished_at = now()
            where id = ${id}`;
    }
}

import { BlobStore } from "./blobs";
import { Config } from "./config";
import { connect, migrate, Sql } from "./db";
import { Worker } from "./engine/worker";
import { EvaluatorRunner } from "./runner/evaluator";
import { LocalRunner } from "./runner/local";
import { Scheduler } from "./runner/scheduler";
import { Runner } from "./runner/types";

export type App = {
    config: Config;
    sql: Sql;
    blobs: BlobStore;
    runner: Runner;
    scheduler: Scheduler;
    worker: Worker;
    close(): Promise<void>;
};

export const createApp = async (config: Config, runnerOverride?: Runner): Promise<App> => {
    const sql = connect(config.databaseUrl, config.databaseCaFile);
    await migrate(sql);
    const blobs = new BlobStore(config.s3, sql);
    await blobs.init();
    let runner = runnerOverride;
    if (!runner) {
        if (config.runner.kind === "local") runner = new LocalRunner();
        else {
            const evaluator = new EvaluatorRunner(config);
            await evaluator.init();
            runner = evaluator;
        }
    }
    const scheduler = new Scheduler(config.runner.concurrency, config.runner.workspaceConcurrency);
    const worker = new Worker(sql, blobs, runner, scheduler);
    await worker.recover();
    return {
        config,
        sql,
        blobs,
        runner,
        scheduler,
        worker,
        close: async () => {
            worker.stop();
            await runner!.close();
            await sql.end({ timeout: 5 });
        },
    };
};

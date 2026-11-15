type Task = { run: () => Promise<void> };

/**
 * Keeps one tenant from starving the others on shared runner instances: jobs in flight are
 * capped in total and per workspace, and waiting workspaces are served round-robin.
 */
export class Scheduler {
    private queues = new Map<string, Task[]>();
    private order: string[] = [];
    private running = new Map<string, number>();
    private total = 0;

    constructor(private limit: number, private workspaceLimit: number) {}

    submit<T>(workspaceId: string, job: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const queue = this.queues.get(workspaceId) ?? [];
            if (!this.queues.has(workspaceId)) {
                this.queues.set(workspaceId, queue);
                this.order.push(workspaceId);
            }
            queue.push({
                run: async () => {
                    try {
                        resolve(await job());
                    } catch (error) {
                        reject(error);
                    }
                },
            });
            this.pump();
        });
    }

    private pump() {
        while (this.total < this.limit) {
            const index = this.order.findIndex(
                (id) => (this.queues.get(id)?.length ?? 0) > 0 && (this.running.get(id) ?? 0) < this.workspaceLimit,
            );
            if (index < 0) return;
            const [workspaceId] = this.order.splice(index, 1) as [string];
            const queue = this.queues.get(workspaceId)!;
            const task = queue.shift()!;
            // served workspaces go to the back of the line
            if (queue.length > 0) this.order.push(workspaceId);
            else this.queues.delete(workspaceId);
            this.total += 1;
            this.running.set(workspaceId, (this.running.get(workspaceId) ?? 0) + 1);
            void task.run().finally(() => {
                this.total -= 1;
                this.running.set(workspaceId, (this.running.get(workspaceId) ?? 1) - 1);
                this.pump();
            });
        }
    }
}

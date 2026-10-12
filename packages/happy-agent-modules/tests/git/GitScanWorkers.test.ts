import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

interface FakeWorker {
    cwd: string;
    keepAlive: () => boolean;
    warmed: number;
}

const created: FakeWorker[] = [];

vi.mock("@slopus/happy-agent-compute", () => ({
    computePermissions: (mode: string) => ({ mode, network: { egress: false } }),
    createHostCommandWorker: (options: { cwd: string; keepAlive: () => boolean }) => {
        const worker: FakeWorker = { cwd: options.cwd, keepAlive: options.keepAlive, warmed: 0 };
        created.push(worker);
        return {
            dispose: async () => undefined,
            run: async () => ({
                exitCode: 0,
                stderr: "",
                stdout: Buffer.alloc(0),
                timedOut: false,
                truncated: false,
            }),
            warm: () => {
                worker.warmed += 1;
            },
        };
    },
}));

const { GitScanWorkers } = await import("../../sources/git/impl/GitScanWorkers.js");

describe("GitScanWorkers", () => {
    it("keeps a worker while an agent run holds it or the tracker follows it", async () => {
        created.length = 0;
        const root = createRootContext();
        let tracked: string[] = [];
        const workers = new GitScanWorkers(
            () => root,
            () => tracked,
        );
        const folder = process.platform === "win32" ? "C:\\Work\\Repo" : "/work/repo";

        // An agent run starts its folder's worker ahead of the first scan.
        const release = workers.hold(folder, undefined);
        expect(created).toHaveLength(1);
        expect(created[0]!.warmed).toBe(1);
        expect(created[0]!.keepAlive()).toBe(true);

        // Once the run settles, nothing keeps it.
        release();
        release();
        expect(created[0]!.keepAlive()).toBe(false);

        // The tracker following the same folder keeps it, however the path is spelled.
        tracked = [process.platform === "win32" ? "c:\\work\\repo\\" : "/work/repo/"];
        expect(created[0]!.keepAlive()).toBe(true);
        tracked = [];
        expect(created[0]!.keepAlive()).toBe(false);

        // Scans of the folder reuse the warmed worker instead of starting another.
        await workers.scanner(() => undefined)({ args: ["status"], cwd: folder });
        expect(created).toHaveLength(1);
        workers.dispose();
    });

    it("keeps a folder held while any one of several runs still holds it", () => {
        created.length = 0;
        const root = createRootContext();
        const workers = new GitScanWorkers(
            () => root,
            () => [],
        );
        const folder = process.platform === "win32" ? "C:\\Work\\Shared" : "/work/shared";
        const first = workers.hold(folder, undefined);
        const second = workers.hold(folder, undefined);
        first();
        expect(created[0]!.keepAlive()).toBe(true);
        second();
        expect(created[0]!.keepAlive()).toBe(false);
        workers.dispose();
    });
});

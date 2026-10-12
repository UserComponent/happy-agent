import { resolve } from "node:path";

import {
    computePermissions,
    createHostCommandWorker,
    type HostCommandWorker,
} from "@slopus/happy-agent-compute";
import type { RootContext } from "@steve.kite/stdlib";

import { runScanGitInWorker, scanEnvironment, type ScanGitRunner } from "../runScanGit.js";

/** Workspaces whose idle workers are kept; the least recently used one beyond this is stopped. */
const MAXIMUM_WORKERS = 32;

/**
 * One long-lived read-only sandbox per workspace for Windows Git scans.
 *
 * A one-shot sandboxed command on Windows costs a sandbox logon, a private desktop, and an ACL
 * refresh. The tracker issues a stream of short Git reads per workspace, so each workspace keeps
 * one worker that pays for those once.
 *
 * A worker starts on its workspace's first scan, or ahead of time when an agent run begins there.
 * It keeps running while the tracker follows the workspace or an agent run holds it, and stops
 * five idle minutes after neither is true. Being tracked never starts a worker by itself, so a
 * daemon with many background workspaces starts only the sandboxes that actually scan.
 */
export class GitScanWorkers {
    readonly #held = new Map<string, number>();
    readonly #lifetime: () => RootContext;
    readonly #tracked: () => Iterable<string>;
    readonly #workers = new Map<string, HostCommandWorker>();

    /** `tracked` names the repository paths the Git tracker currently follows. */
    constructor(lifetime: () => RootContext, tracked: () => Iterable<string>) {
        this.#lifetime = lifetime;
        this.#tracked = tracked;
    }

    /** The scan runner that routes each read to its workspace's worker. */
    scanner(gitCeilingDirectories: () => string | undefined): ScanGitRunner {
        return async (options) => {
            const worker = this.#worker(options.cwd, gitCeilingDirectories());
            return await runScanGitInWorker(worker, options);
        };
    }

    /**
     * Starts a workspace's worker in the background and keeps it running until the returned
     * release, for an agent run that is about to scan it. Never waits and never throws.
     */
    hold(cwd: string, gitCeilingDirectories: string | undefined): () => void {
        const path = pathKey(cwd);
        this.#held.set(path, (this.#held.get(path) ?? 0) + 1);
        this.#worker(cwd, gitCeilingDirectories).warm();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const count = (this.#held.get(path) ?? 1) - 1;
            if (count <= 0) this.#held.delete(path);
            else this.#held.set(path, count);
        };
    }

    /** Stops every worker. */
    dispose(): void {
        const workers = Array.from(this.#workers.values());
        this.#workers.clear();
        this.#held.clear();
        for (const worker of workers) void worker.dispose();
    }

    #inUse(path: string): boolean {
        if (this.#held.has(path)) return true;
        for (const tracked of this.#tracked()) {
            if (pathKey(tracked) === path) return true;
        }
        return false;
    }

    #worker(cwd: string, gitCeilingDirectories: string | undefined): HostCommandWorker {
        const path = pathKey(cwd);
        const key = `${path}\0${gitCeilingDirectories ?? ""}`;
        const existing = this.#workers.get(key);
        if (existing !== undefined) {
            // Reinsert so the map stays ordered from least to most recently used.
            this.#workers.delete(key);
            this.#workers.set(key, existing);
            return existing;
        }
        const worker = createHostCommandWorker({
            ctx: this.#lifetime().named("git-scan-worker"),
            cwd,
            environment: scanEnvironment(cwd, gitCeilingDirectories),
            keepAlive: () => this.#inUse(path),
            permissions: computePermissions("read_only"),
        });
        this.#workers.set(key, worker);
        for (const [oldest, idle] of this.#workers) {
            if (this.#workers.size <= MAXIMUM_WORKERS) break;
            this.#workers.delete(oldest);
            void idle.dispose();
        }
        return worker;
    }
}

/** Windows compares paths without regard to case. */
function pathKey(path: string): string {
    return resolve(path).toLowerCase();
}

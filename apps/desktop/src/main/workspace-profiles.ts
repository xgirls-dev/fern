import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceList } from "../preload/types";

const original = "original";
const profileId = /^[0-9a-f]{32}$/;

interface RecoveredWorkspace {
  id: string;
  name: string;
  previous?: string;
}

interface Catalog {
  active: string;
  recovered: RecoveredWorkspace[];
}

export class WorkspaceProfiles {
  private readonly location: string;
  private readonly recoveredRoot: string;
  private recoveredUnavailable = false;
  private catalog: Catalog = { active: original, recovered: [] };

  constructor(userData: string) {
    this.location = join(userData, "workspaces.json");
    this.recoveredRoot = join(userData, "recovered-workspaces");
  }

  async load(): Promise<void> {
    let saved: Catalog;
    try {
      saved = JSON.parse(await readFile(this.location, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    if (!saved || !Array.isArray(saved.recovered) || !saved.recovered.every((entry) =>
      entry && typeof entry.name === "string" && profileId.test(entry.id) &&
      (entry.previous === undefined || entry.previous === original || profileId.test(entry.previous)))) {
      throw new Error("Fern could not read its saved workspaces.");
    }
    const ids = new Set(saved.recovered.map(({ id }) => id));
    if (ids.size !== saved.recovered.length || (saved.active !== original && !ids.has(saved.active))) {
      throw new Error("Fern could not find the selected workspace.");
    }
    this.catalog = saved;
    if (this.active) await this.checkDirectory(this.active.id);
  }

  keepOriginalAvailable(): void {
    this.recoveredUnavailable = true;
    this.catalog = { active: original, recovered: [] };
  }

  get active(): RecoveredWorkspace | undefined {
    return this.catalog.recovered.find(({ id }) => id === this.catalog.active);
  }

  get directory(): string | undefined {
    return this.active && this.recoveredDirectory(this.active.id);
  }

  summary(): WorkspaceList {
    return {
      active: this.catalog.active,
      error: this.recoveredUnavailable ? "Fern could not read its recovered workspaces. The original workspace is available." : undefined,
      items: [{ id: original, name: "Original workspace" }, ...this.catalog.recovered.filter(({ previous }) => !previous)
        .map(({ id, name }) => ({ id, name }))],
    };
  }

  async create(name: string, stage: (directory: string) => Promise<void>): Promise<void> {
    if (this.recoveredUnavailable) throw new Error("Recovered workspaces are unavailable.");
    await mkdir(this.recoveredRoot, { recursive: true, mode: 0o700 });
    const root = await lstat(this.recoveredRoot);
    if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("Fern’s recovered workspace folder is unavailable.");
    const id = randomUUID().replaceAll("-", "");
    const directory = this.recoveredDirectory(id);
    try {
      await stage(directory);
      await this.write({
        active: id,
        recovered: [...this.catalog.recovered, { id, name, previous: this.catalog.active }],
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async switchTo(id: string): Promise<void> {
    if (id === this.catalog.active) return;
    if (id !== original) {
      if (!this.catalog.recovered.some((entry) => entry.id === id && !entry.previous)) {
        throw new Error("This workspace is unavailable.");
      }
      await this.checkDirectory(id);
    }
    await this.write({ ...this.catalog, active: id });
  }

  async seed(): Promise<string | null> {
    const workspace = this.active;
    if (!workspace?.previous) return null;
    return readFile(join(this.recoveredDirectory(workspace.id), "workspace.json"), "utf8");
  }

  async finish(): Promise<void> {
    const workspace = this.active;
    if (!workspace?.previous) return;
    await this.write({ ...this.catalog, recovered: this.catalog.recovered.map((entry) =>
      entry.id === workspace.id ? { id: entry.id, name: entry.name } : entry) });
    await rm(join(this.recoveredDirectory(workspace.id), "workspace.json"), { force: true }).catch(() => undefined);
  }

  async returnFromFailedRestore(): Promise<void> {
    const workspace = this.active;
    if (!workspace?.previous) return;
    const previous = this.catalog.recovered.some(({ id }) => id === workspace.previous) ? workspace.previous : original;
    await this.write({
      active: previous, recovered: this.catalog.recovered.filter(({ id }) => id !== workspace.id),
    });
    await rm(this.recoveredDirectory(workspace.id), { recursive: true, force: true }).catch(() => undefined);
  }

  private async checkDirectory(id: string): Promise<void> {
    const [root, workspace] = await Promise.all([lstat(this.recoveredRoot), lstat(this.recoveredDirectory(id))]);
    if (!root.isDirectory() || root.isSymbolicLink() || !workspace.isDirectory() || workspace.isSymbolicLink()) {
      throw new Error("This workspace folder is unavailable.");
    }
  }

  private recoveredDirectory(id: string): string {
    if (!profileId.test(id)) throw new Error("This workspace folder is invalid.");
    return join(this.recoveredRoot, id);
  }

  private async write(next: Catalog): Promise<void> {
    const staged = `${this.location}.${randomUUID()}.tmp`;
    try {
      await writeFile(staged, JSON.stringify(next), { encoding: "utf8", mode: 0o600, flush: true, flag: "wx" });
      await rename(staged, this.location);
      this.catalog = next;
    } finally {
      await rm(staged, { force: true }).catch(() => undefined);
    }
  }
}

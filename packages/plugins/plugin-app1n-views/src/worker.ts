import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { ACTION_KEYS, DATA_KEYS, PLUGIN_ID } from "./constants.js";

const HOME = process.env.HOME ?? "/home/igorlima";
const STATE_DIR = join(HOME, "state");
const FEATURES_PATH = join(STATE_DIR, "features.json");
const HANDOFFS_PATH = join(STATE_DIR, "handoffs.jsonl");
const BRAIN_DUMP_PATH = join(STATE_DIR, "brain-dump.md");

function readFeatures(): unknown {
  try {
    if (!existsSync(FEATURES_PATH)) return { versao: "v2", features: [] };
    return JSON.parse(readFileSync(FEATURES_PATH, "utf8"));
  } catch {
    return { versao: "v2", features: [] };
  }
}

function readHandoffs(): unknown[] {
  try {
    if (!existsSync(HANDOFFS_PATH)) return [];
    return readFileSync(HANDOFFS_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readBrainDump(): string {
  try {
    if (!existsSync(BRAIN_DUMP_PATH)) return "";
    return readFileSync(BRAIN_DUMP_PATH, "utf8");
  } catch {
    return "";
  }
}

const APP1N_REPOS = ["app1n-ai/cockpit", "app1n-ai/licita1n", "app1n-ai/fiscal1n", "app1n-ai/app1n-skills"];
const GCP_PROJECT = "app1n-497116";

type GithubPR = {
  repo: string;
  number: number;
  title: string;
  state: string;
  url: string;
  error?: string;
};

type GcpService = {
  name: string;
  url: string;
  ready: boolean;
  isProd: boolean;
  error?: string;
};

function fetchGithubPRs(): GithubPR[] {
  const results: GithubPR[] = [];
  for (const repo of APP1N_REPOS) {
    try {
      const raw = execSync(
        `gh pr list --repo ${repo} --json number,title,state,url --limit 10`,
        { timeout: 10_000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      );
      const prs = JSON.parse(raw) as Array<{ number: number; title: string; state: string; url: string }>;
      for (const pr of prs) {
        results.push({ repo, ...pr });
      }
    } catch {
      results.push({ repo, number: 0, title: "", state: "error", url: "", error: `gh pr list failed for ${repo}` });
    }
  }
  return results;
}

function fetchGcpServices(): GcpService[] {
  try {
    const raw = execSync(
      `gcloud run services list --format=json --project=${GCP_PROJECT}`,
      { timeout: 15_000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const services = JSON.parse(raw) as Array<{
      metadata: { name: string };
      status: { url?: string; conditions?: Array<{ type: string; status: string }> };
    }>;
    return services.map((svc) => {
      const readyCond = svc.status.conditions?.find((c) => c.type === "Ready");
      return {
        name: svc.metadata.name,
        url: svc.status.url ?? "",
        ready: readyCond?.status === "True",
        isProd: svc.metadata.name.endsWith("-prod"),
      };
    });
  } catch {
    return [{ name: "error", url: "", ready: false, isProd: false, error: "gcloud run services list failed" }];
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_ID} plugin setup complete`);

    ctx.data.register(DATA_KEYS.features, async () => {
      return readFeatures();
    });

    ctx.data.register(DATA_KEYS.handoffs, async () => {
      return readHandoffs();
    });

    ctx.data.register(DATA_KEYS.brainDumpNotes, async () => {
      return { content: readBrainDump() };
    });

    ctx.data.register(DATA_KEYS.missionStatus, async () => {
      const features = readFeatures() as { missao?: unknown; features?: unknown[] };
      const handoffs = readHandoffs() as Array<{ concluido?: boolean; papel?: string }>;
      const total = features.features?.length ?? 0;
      const done = (features.features as Array<{ status?: string }> | undefined)?.filter((f) => f.status === "done" || f.status === "concluido").length ?? 0;
      const activeHandoffs = handoffs.filter((h) => !h.concluido).length;
      return {
        missao: features.missao,
        totalFeatures: total,
        doneFeatures: done,
        pendingFeatures: total - done,
        activeHandoffs,
        totalHandoffs: handoffs.length,
      };
    });

    ctx.actions.register(ACTION_KEYS.saveBrainDump, async (params) => {
      const { content } = params as { content: string };
      writeFileSync(BRAIN_DUMP_PATH, content, "utf8");
      return { saved: true };
    });

    ctx.data.register(DATA_KEYS.fieldOpsGithub, async () => {
      return {
        repos: APP1N_REPOS,
        prs: fetchGithubPRs(),
        fetchedAt: new Date().toISOString(),
      };
    });

    ctx.data.register(DATA_KEYS.fieldOpsGcp, async () => {
      return {
        project: GCP_PROJECT,
        services: fetchGcpServices(),
        fetchedAt: new Date().toISOString(),
      };
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_ID} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

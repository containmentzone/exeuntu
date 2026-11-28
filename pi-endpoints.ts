// A pi extension that adds the models of OpenAI-compatible endpoints listed
// in ~/.pi/agent/endpoints, usually cyac services such as a cyac-inject
// proxy that adds the real API key on its way out. Each line is
//
//	[name] <base URL> [key=<api key>] [models=<pattern>,...]
//
// where <base>/models lists the models and <base>/chat/completions serves
// them. The name becomes the provider in /model and defaults to the first
// label of the URL's host (nanogpt for http://nanogpt.cyac.internal). The key
// takes pi's syntax ($VAR, !command) and defaults to a placeholder, since pi
// hides models it has no key for. Fields can't contain spaces. # starts a
// comment.
//
// An endpoint whose name or URL contains a provider ID from
// ~/.pi/agent/endpoint-presets.json (models.json's format) gets that
// provider's compat and only its models, in its order and with its metadata,
// as far as the endpoint lists them. That is for services such as NanoGPT
// and OpenRouter, which list hundreds. models= keeps only the IDs that match
// one of its patterns (* matches anything), preset or not. Whatever a preset
// doesn't say comes from pi's own catalog when the ID matches a model it
// knows, else from the endpoint, else from defaults.
//
// A preset's "subscription" names, relative to the base URL, a list of the
// models a subscription covers ("models", tagged [sub] in /model) and the
// subscription's usage ("usage", shown by /usage), in NanoGPT's shapes.
//
// Every endpoint is asked once at startup. One that doesn't answer (DNS or
// its gateway may not be up yet when a box boots) is asked again in the
// background, backing off to once a minute, until it does. /endpoints asks
// them all again now. Edit the files, then /reload.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

const LIST = join(getAgentDir(), "endpoints");
const PRESETS = join(getAgentDir(), "endpoint-presets.json");
const TIMEOUT_MS = 3000;

type Def = Record<string, any> & { id: string };
type Preset = { name?: string; compat?: object; models?: Def[]; subscription?: { models?: string; usage?: string } };
type Endpoint = { name: string; label?: string; baseUrl: string; apiKey: string; keep?: RegExp; preset?: Preset; catalog?: string };

function read(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

// glob turns patterns such as openai/gpt-5* into one anchored,
// case-insensitive expression.
function glob(patterns: string[]): RegExp {
	const escaped = patterns.map((p) => p.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*"));
	return new RegExp(`^(?:${escaped.join("|")})$`, "i");
}

export function parse(text: string, presets: Record<string, Preset> = {}): Endpoint[] {
	const out: Endpoint[] = [];
	for (const [n, raw] of text.split("\n").entries()) {
		const fields = raw.replace(/#.*/, "").trim().split(/\s+/).filter(Boolean);
		if (fields.length === 0) continue;
		// The line may hold a key, so warnings name it by number only.
		const skip = (why: string) => console.warn(`[pi-endpoints] ${LIST}:${n + 1}: skipped: ${why}`);
		const at = fields.findIndex((f) => /^https?:\/\//.test(f));
		const opts = new Map(fields.slice(at + 1).map((f) => [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)]));
		if (at < 0 || at > 1 || [...opts.keys()].some((k) => k !== "key" && k !== "models")) {
			skip("want [name] <url> [key=...] [models=...]");
			continue;
		}
		const baseUrl = fields[at].replace(/\/+$/, "");
		let host: string;
		try {
			host = new URL(baseUrl).hostname;
		} catch {
			skip("not a URL");
			continue;
		}
		const name = at === 1 ? fields[0] : host.split(".")[0];
		if (out.some((e) => e.name === name)) {
			skip(`a second endpoint named ${name}; give it a name of its own`);
			continue;
		}
		const models = opts.get("models")?.split(",").filter(Boolean);
		const id = Object.keys(presets).find((p) => `${name} ${baseUrl}`.toLowerCase().includes(p.toLowerCase()));
		out.push({
			name,
			label: id && presets[id].name,
			baseUrl,
			apiKey: opts.get("key") || "none",
			keep: models?.length ? glob(models) : undefined,
			preset: id ? presets[id] : undefined,
			catalog: id,
		});
	}
	return out;
}

// What pi's own catalog says about a model ID: first that of the built-in
// provider the preset is named after, then any provider's, matched exactly or
// by the part after the last slash. Another provider's prices and request
// quirks don't apply, so those come only from the same provider.
let everyone: Map<string, any>;
function known(id: string, provider?: string): Partial<Def> {
	const same = (getBuiltinProviders() as string[]).includes(provider ?? "")
		? getBuiltinModels(provider as any).find((m) => m.id === id)
		: undefined;
	if (same) {
		const { reasoning, thinkingLevelMap, input, inputLimits, contextWindow, maxTokens, cost } = same;
		return { reasoning, thinkingLevelMap, input, inputLimits, contextWindow, maxTokens, cost, ...(same.api === "openai-completions" && { compat: same.compat }) };
	}
	if (!everyone) {
		everyone = new Map();
		for (const p of getBuiltinProviders()) {
			for (const m of getBuiltinModels(p)) {
				if (m.type !== "chat") continue;
				for (const key of [m.id, m.id.split("/").pop()!]) if (!everyone.has(key)) everyone.set(key, m);
			}
		}
	}
	const m = everyone.get(id) ?? everyone.get(id.split("/").pop()!);
	return m ? { reasoning: m.reasoning, input: m.input, contextWindow: m.contextWindow, maxTokens: m.maxTokens } : {};
}

// secret resolves a key the way pi does, for the /models request:
// $NAME or ${NAME} from the environment, !command from its output.
function secret(key: string): string {
	if (key.startsWith("!")) return execSync(key.slice(1), { encoding: "utf8" }).trim();
	const env = /^\$\{?(\w+)\}?$/.exec(key);
	return env ? (process.env[env[1]] ?? "") : key;
}

type Listed = {
	id: string;
	name?: string;
	context_length?: number;
	context_window?: number;
	max_tokens?: number;
	max_output_tokens?: number;
	capabilities?: { reasoning?: boolean; vision?: boolean };
};

async function get(e: Endpoint, path: string, signal?: AbortSignal): Promise<any> {
	const url = new URL(path, `${e.baseUrl}/`).href;
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const res = await fetch(url, {
		headers: e.apiKey === "none" ? {} : { Authorization: `Bearer ${secret(e.apiKey)}` },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return res.json();
}

async function ids(e: Endpoint, path: string): Promise<Map<string, Listed>> {
	const { data } = (await get(e, path)) as { data?: Listed[] };
	if (!Array.isArray(data)) throw new Error(`${path}: no data list`);
	return new Map(data.filter((m) => typeof m?.id === "string").map((m) => [m.id, m]));
}

async function probe(e: Endpoint) {
	const listed = await ids(e, "models");
	const sub = e.preset?.subscription?.models;
	const covered = sub
		? await ids(e, sub).catch((err) => {
				console.warn(`[pi-endpoints] ${e.name}: no subscription tags: ${err.message}`);
				return new Map();
			})
		: new Map();
	const wanted = e.preset?.models ?? [...listed.keys()].map((id) => ({ id }));
	return wanted
		.filter((d) => listed.has(d.id) && (!e.keep || e.keep.test(d.id)))
		.map((d) => {
			const m = listed.get(d.id)!;
			const k = known(d.id, e.catalog);
			const def = {
				name: m.name ?? d.id,
				reasoning: m.capabilities?.reasoning ?? false,
				input: m.capabilities?.vision ? ["text" as const, "image" as const] : ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.context_length ?? m.context_window ?? 128000,
				maxTokens: m.max_output_tokens ?? m.max_tokens ?? 16384,
				...k,
				...d,
				compat: { ...k.compat, ...e.preset?.compat, ...d.compat },
			};
			return covered.has(d.id) ? { ...def, name: `${def.name} [sub]` } : def;
		});
}

// usage formats one counter of NanoGPT's subscription usage.
function usage(label: string, c?: { used?: number; remaining?: number; percentUsed?: number; resetAt?: number } | null) {
	if (!c || c.used == null) return `${label} unknown`;
	const pct = Math.round((c.percentUsed ?? 0) * 100);
	const reset = c.resetAt ? `, resets ${new Date(c.resetAt).toLocaleString()}` : "";
	return `${label} ${pct}% (${c.used.toLocaleString()} used, ${(c.remaining ?? 0).toLocaleString()} left${reset})`;
}

export default async function (pi: ExtensionAPI) {
	const text = read(LIST);
	if (text === undefined) return; // no list, no endpoints
	let presets: Record<string, Preset> = {};
	try {
		presets = JSON.parse(read(PRESETS) ?? "{}").providers ?? {};
	} catch (err) {
		console.warn(`[pi-endpoints] ${PRESETS}: ${(err as Error).message}`);
	}
	const endpoints = parse(text, presets);

	const register = (e: Endpoint, models: Awaited<ReturnType<typeof probe>>) =>
		pi.registerProvider(e.name, {
			name: e.label ?? e.name,
			baseUrl: e.baseUrl,
			apiKey: e.apiKey,
			api: "openai-completions",
			models,
		});
	// ask probes e and registers what it lists; false if it didn't answer.
	const ask = async (e: Endpoint, quiet = false) => {
		try {
			register(e, await probe(e));
			return true;
		} catch (err) {
			if (!quiet) console.warn(`[pi-endpoints] ${e.name}: ${(err as Error).message}; retrying`);
			return false;
		}
	};

	const pending = new Set<Endpoint>();
	await Promise.all(
		endpoints.map(async (e) => {
			if (!(await ask(e))) {
				register(e, []);
				pending.add(e);
			}
		}),
	);

	// Retry what didn't answer, from the session (not the factory, which
	// also runs for --list-models), backing off from 2s to once a minute.
	const timers = new Set<NodeJS.Timeout>();
	pi.on("session_start", async (_event, ctx) => {
		for (const e of pending) {
			let wait = 2000;
			const retry = () => {
				const t = setTimeout(async () => {
					timers.delete(t);
					if (!pending.has(e)) return;
					if (await ask(e, true)) {
						pending.delete(e);
						try {
							if (ctx.hasUI) ctx.ui.notify(`${e.name} answered; its models are in /model`, "info");
						} catch {
							// the session this ctx belonged to has been replaced
						}
					} else {
						wait = Math.min(wait * 2, 60_000);
						retry();
					}
				}, wait);
				t.unref();
				timers.add(t);
			};
			retry();
		}
	});
	pi.on("session_shutdown", async () => {
		for (const t of timers) clearTimeout(t);
		timers.clear();
	});

	pi.registerCommand("endpoints", {
		description: "Ask every endpoint in ~/.pi/agent/endpoints for its models again",
		handler: async (_args, ctx) => {
			const lines = await Promise.all(
				endpoints.map(async (e) => {
					try {
						const models = await probe(e);
						register(e, models);
						pending.delete(e);
						return `${e.name}: ${models.length} models`;
					} catch (err) {
						return `${e.name}: ${(err as Error).message}`;
					}
				}),
			);
			ctx.ui.notify(lines.join("\n") || "no endpoints", "info");
		},
	});

	pi.registerCommand("usage", {
		description: "Show subscription usage of the endpoints that have it",
		handler: async (_args, ctx) => {
			const withUsage = endpoints.filter((e) => e.preset?.subscription?.usage);
			const lines = await Promise.all(
				withUsage.map(async (e) => {
					try {
						const u = await get(e, e.preset!.subscription!.usage!);
						return [
							`${e.name}: ${u.state ?? (u.active ? "active" : "inactive")}`,
							usage("  daily input", u.dailyInputTokens),
							usage("  weekly input", u.weeklyInputTokens),
							...(u.routing?.recommendedMode ? [`  routing: ${u.routing.recommendedMode}`] : []),
						].join("\n");
					} catch (err) {
						return `${e.name}: ${(err as Error).message}`;
					}
				}),
			);
			ctx.ui.notify(lines.join("\n") || "no endpoint has subscription usage", "info");
		},
	});
}

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
// Every endpoint is asked once at startup and again whenever /model opens,
// so models that appear later show up there. Edit the files, then /reload.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

const LIST = join(getAgentDir(), "endpoints");
const PRESETS = join(getAgentDir(), "endpoint-presets.json");
const TIMEOUT_MS = 3000;

type Def = Record<string, any> & { id: string };
type Preset = { name?: string; compat?: object; models?: Def[] };
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
	for (const raw of text.split("\n")) {
		const fields = raw.replace(/#.*/, "").trim().split(/\s+/).filter(Boolean);
		if (fields.length === 0) continue;
		const at = fields.findIndex((f) => /^https?:\/\//.test(f));
		const opts = new Map(fields.slice(at + 1).map((f) => [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)]));
		if (at < 0 || at > 1 || [...opts.keys()].some((k) => k !== "key" && k !== "models")) {
			console.warn(`[pi-endpoints] ${LIST}: skipping "${raw.trim()}": want [name] <url> [key=...] [models=...]`);
			continue;
		}
		const baseUrl = fields[at].replace(/\/+$/, "");
		const name = at === 1 ? fields[0] : new URL(baseUrl).hostname.split(".")[0];
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

type Listed = { id: string; name?: string; context_length?: number; context_window?: number; max_tokens?: number };

async function probe(e: Endpoint, signal?: AbortSignal) {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const res = await fetch(`${e.baseUrl}/models`, {
		headers: e.apiKey === "none" ? {} : { Authorization: `Bearer ${secret(e.apiKey)}` },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!res.ok) throw new Error(`${e.baseUrl}/models: HTTP ${res.status}`);
	const { data } = (await res.json()) as { data?: Listed[] };
	if (!Array.isArray(data)) throw new Error(`${e.baseUrl}/models: no data list`);
	const listed = new Map(data.filter((m) => typeof m?.id === "string").map((m) => [m.id, m]));
	const wanted = e.preset?.models ?? [...listed.keys()].map((id) => ({ id }));
	return wanted
		.filter((d) => listed.has(d.id) && (!e.keep || e.keep.test(d.id)))
		.map((d) => {
			const m = listed.get(d.id)!;
			const k = known(d.id, e.catalog);
			return {
				name: m.name ?? d.id,
				reasoning: false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.context_length ?? m.context_window ?? 128000,
				maxTokens: m.max_tokens ?? 16384,
				...k,
				...d,
				compat: { ...k.compat, ...e.preset?.compat, ...d.compat },
			};
		});
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
	await Promise.all(
		parse(text, presets).map(async (e) => {
			const models = await probe(e).catch((err) => {
				console.warn(`[pi-endpoints] ${e.name}: ${err.message}`);
				return [];
			});
			pi.registerProvider(e.name, {
				name: e.label ?? e.name,
				baseUrl: e.baseUrl,
				apiKey: e.apiKey,
				api: "openai-completions",
				models,
				refreshModels: ({ signal }) => probe(e, signal),
			});
		}),
	);
}

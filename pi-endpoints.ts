// A pi extension that adds the models of OpenAI-compatible endpoints listed
// in ~/.config/pi-endpoints, usually cyac services such as a cyac-inject
// proxy that adds the real API key on its way out. Each line is
//
//	[name] <base URL> [api key]
//
// with the base URL up to and including /v1, so that <base>/models lists the
// models and <base>/chat/completions serves them. The name becomes the
// provider in /model and defaults to the first label of the URL's host
// (nanogpt for http://nanogpt.cyac.internal:8080/v1). The key takes pi's
// syntax ($VAR, !command) and defaults to a placeholder, since pi hides
// models it has no key for. # starts a comment.
//
// Every endpoint is asked once at startup and again whenever /model opens,
// so models that appear later show up there. Edit the file, then /reload.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

const FILE = join(homedir(), ".config", "pi-endpoints");
const TIMEOUT_MS = 3000;

type Endpoint = { name: string; baseUrl: string; apiKey: string };

export function parse(text: string): Endpoint[] {
	const out: Endpoint[] = [];
	for (const raw of text.split("\n")) {
		const fields = raw.replace(/#.*/, "").trim().split(/\s+/).filter(Boolean);
		if (fields.length === 0) continue;
		const at = fields.findIndex((f) => /^https?:\/\//.test(f));
		if (at < 0 || at > 1 || fields.length > at + 2) {
			console.warn(`[pi-endpoints] ${FILE}: skipping "${raw.trim()}": want [name] <url> [key]`);
			continue;
		}
		const baseUrl = fields[at].replace(/\/+$/, "");
		out.push({
			name: at === 1 ? fields[0] : new URL(baseUrl).hostname.split(".")[0],
			baseUrl,
			apiKey: fields[at + 1] ?? "none",
		});
	}
	return out;
}

// What pi's own catalog says about a model id, matched exactly or by the part
// after the last slash (anthropic/claude-x and claude-x are the same model).
let catalog: Map<string, { reasoning: boolean; input: ("text" | "image")[]; contextWindow: number; maxTokens: number }>;
function known(id: string) {
	if (!catalog) {
		catalog = new Map();
		for (const p of getBuiltinProviders()) {
			for (const m of getBuiltinModels(p)) {
				if (m.type !== "chat") continue;
				for (const key of [m.id, m.id.split("/").pop()!]) {
					if (!catalog.has(key)) catalog.set(key, m);
				}
			}
		}
	}
	return catalog.get(id) ?? catalog.get(id.split("/").pop()!);
}

type Listed = { id: string; name?: string; context_length?: number; context_window?: number; max_tokens?: number };

async function probe(e: Endpoint, signal?: AbortSignal) {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const res = await fetch(`${e.baseUrl}/models`, {
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!res.ok) throw new Error(`${e.baseUrl}/models: HTTP ${res.status}`);
	const { data } = (await res.json()) as { data?: Listed[] };
	if (!Array.isArray(data)) throw new Error(`${e.baseUrl}/models: no data list`);
	return data
		.filter((m) => typeof m?.id === "string")
		.map((m) => {
			const k = known(m.id);
			return {
				id: m.id,
				name: m.name ?? m.id,
				reasoning: k?.reasoning ?? false,
				input: k?.input ?? ["text" as const],
				// Costs are the endpoint's business; pi's catalog prices are
				// another provider's.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.context_length ?? m.context_window ?? k?.contextWindow ?? 128000,
				maxTokens: m.max_tokens ?? k?.maxTokens ?? 16384,
			};
		});
}

export default async function (pi: ExtensionAPI) {
	let text: string;
	try {
		text = readFileSync(FILE, "utf8");
	} catch {
		return; // no list, no endpoints
	}
	await Promise.all(
		parse(text).map(async (e) => {
			const models = await probe(e).catch((err) => {
				console.warn(`[pi-endpoints] ${e.name}: ${err.message}`);
				return [];
			});
			pi.registerProvider(e.name, {
				name: e.name,
				baseUrl: e.baseUrl,
				apiKey: e.apiKey,
				api: "openai-completions",
				models,
				refreshModels: ({ signal }) => probe(e, signal),
			});
		}),
	);
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { FirecrawlClient, FIRECRAWL_LIMITS } from "./client.js";
import { canonicalPublicUrl } from "./url.js";
import { createFirecrawlPlugin } from "./index.js";

const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
function setup(fetcher = vi.fn(async () => response({ web: [{ title: "Docs", url: "https://example.com", description: "excerpt" }] }))) {
	const admit = vi.fn(async () => ({ apiKey: "sentinel-secret" }));
	return { fetcher, admit, client: new FirecrawlClient({ admit, fetch: fetcher as typeof fetch }) };
}
afterEach(() => vi.useRealTimers());

describe("Firecrawl URLs", () => {
	it.each(["http://localhost", "http://foo.local", "http://foo.localhost", "http://printer", "http://user:pass@example.com", "file:///tmp/a", "http://0", "http://2130706433", "http://0177.0.0.1", "http://0x7f000001", "http://10.1", "http://192.168.1.1", "http://100.64.0.1", "http://169.254.169.254", "http://[::1]", "http://[::]", "http://[::ffff:127.0.0.1]", "http://[::ffff:192.168.0.1]", "http://[fc00::1]", "http://[fe80::1]", "http://[ff00::1]", "http://[2001:db8::1]", "http://224.0.0.1", "http://240.1.2.3", "https://example.com/\nfoo"])("rejects %s", url => {
		expect(() => canonicalPublicUrl(url)).toThrow();
	});
	it.each(["https://example.com/path", "http://8.8.8.8/", "https://[2606:4700:4700::1111]/", "https://[::ffff:8.8.8.8]/"])("accepts public %s", url => expect(canonicalPublicUrl(url)).toMatch(/^https?:/));
});

describe("Firecrawl adapter", () => {
	it("requests Markdown only, caps output, closes cut code fences, and redacts provider echoes", async () => {
		const { client, fetcher } = setup(vi.fn(async () => response({ markdown: "sentinel-secret\n```ts\n" + "x".repeat(60000) })));
		const text = await client.scrape({ url: "https://example.com" });
		expect(text).toContain("Source: https://example.com/");
		expect(text).not.toContain("sentinel-secret");
		expect(text).toContain("truncated");
		expect(text.length).toBeLessThanOrEqual(50000);
		expect(text.match(/^```/gm)).toHaveLength(2);
		const args = fetcher.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(args[1].body as string)).toEqual({ url: "https://example.com/", formats: ["markdown"], timeout: 60000 });
	});
	it("aborts a decoded stream above 2 MiB", async () => {
		const cancel = vi.fn();
		const { client } = setup(vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(FIRECRAWL_LIMITS.responseBytes + 1)); }, cancel }))));
		await expect(client.search({ query: "x" })).rejects.toMatchObject({ code: "response-size" });
		expect(cancel).toHaveBeenCalled();
	});
	it("uses a replacement key for each new admission and never sends a missing key", async () => {
		const fetcher = vi.fn(async () => response({ web: [] }));
		const admit = vi.fn().mockResolvedValueOnce({ apiKey: "old-key" }).mockResolvedValueOnce({ apiKey: "new-key" }).mockResolvedValueOnce({ apiKey: "" });
		const client = new FirecrawlClient({ fetch: fetcher as typeof fetch, admit });
		await client.search({ query: "x" });
		await client.search({ query: "x" });
		await expect(client.search({ query: "x" })).rejects.toMatchObject({ code: "missing-key" });
		const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
		expect(calls.map(([, options]) => (options.headers as Record<string, string>).Authorization)).toEqual(["Bearer old-key", "Bearer new-key"]);
	});
	it("bounds stalled admission and never dispatches after it times out", async () => {
		vi.useFakeTimers();
		let admit!: (value: { apiKey: string }) => void;
		const fetcher = vi.fn();
		const client = new FirecrawlClient({ admit: () => new Promise(resolve => { admit = resolve; }), fetch: fetcher });
		const request = expect(client.search({ query: "x" })).rejects.toMatchObject({ code: "timeout" });
		await vi.advanceTimersByTimeAsync(30000);
		await request;
		admit({ apiKey: "key" });
		await Promise.resolve();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("caller cancellation prevents dispatch after a pending admission resolves", async () => {
		const caller = new AbortController();
		let admit!: (value: { apiKey: string }) => void;
		const fetcher = vi.fn();
		const client = new FirecrawlClient({ admit: () => new Promise(resolve => { admit = resolve; }), fetch: fetcher });
		const request = expect(client.search({ query: "x" }, caller.signal)).rejects.toMatchObject({ code: "cancelled" });
		caller.abort();
		admit({ apiKey: "key" });
		await request;
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("child disable cancels its request while another tool remains admitted", async () => {
		const fetcher = vi.fn(async () => new Response(new ReadableStream()));
		const { client } = setup(fetcher);
		const search = expect(client.search({ query: "x" })).rejects.toMatchObject({ code: "cancelled" });
		client.abortTool("web_search");
		await search;
		const scrape = expect(client.scrape({ url: "https://example.com" })).rejects.toMatchObject({ code: "cancelled" });
		client.abortAll();
		await scrape;
	});
	it("tool results never include unknown provider or admission errors", async () => {
		const plugin = createFirecrawlPlugin({ admit: async () => { throw new Error("sentinel-secret"); } });
		const tool = plugin.tools[0];
		const result = await tool.execute("id", { query: "x" }, undefined, undefined, {} as never);
		expect(JSON.stringify(result)).not.toContain("sentinel-secret");
		expect(result.details).toEqual({ error: "unavailable" });
	});
});

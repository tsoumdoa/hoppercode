import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { addCustomProvider, type CustomProviderInput } from "./provider-config.js";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const config: CustomProviderInput = {
	id: "custom-local",
	baseUrl: "http://localhost:11434/v1",
	api: "openai-completions",
	modelIds: ["local-model"],
	noAuth: true,
};
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "hopper-providers-"));
	dirs.push(dir);
	return dir;
}

it("preserves both providers when additions run concurrently", async () => {
	const path = join(await directory(), "models.json");
	await Promise.all([
		addCustomProvider(path, config),
		addCustomProvider(path, { ...config, id: "custom-other" }),
	]);
	expect(Object.keys(JSON.parse(await readFile(path, "utf8")).providers)).toHaveLength(2);
});

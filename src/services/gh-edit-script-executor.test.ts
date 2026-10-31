import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeGhEditScript } from "./gh-edit-script-executor.js";
import { presentGhEditScriptExecution } from "../tools/edit-tools/gh-edit-script-render.js";
import { fetchScriptCode } from "../infra/canvas-fetch.js";
import { submitCommand } from "../infra/command-dispatch.js";

vi.mock("../infra/canvas-fetch.js", () => ({ fetchScriptCode: vi.fn() }));
vi.mock("../infra/command-dispatch.js", () => ({ submitCommand: vi.fn() }));
vi.mock("../infra/request-helpers.js", () => ({ withRequester: (run: (req: unknown) => unknown) => run({}) }));
vi.mock("./guid-shortener.js", () => ({ resolveInstanceGuid: (id: string) => id }));

beforeEach(() => vi.resetAllMocks());

describe("script execution and presentation", () => {

	it("does not submit mutations when preparation or validation fails", async () => {
		vi.mocked(fetchScriptCode).mockRejectedValue(new Error("read unavailable"));
		const prepared = presentGhEditScriptExecution(await executeGhEditScript([
			{ action: "patchCode", targetId: "script-1", patches: [{ op: "insert", afterLine: 0, lines: ["print(1)"] }] },
		]));
		expect(prepared.details).toMatchObject({ error: "read unavailable", results: ["prepare failed: read unavailable"], mutationCount: 0 });
		const validated = presentGhEditScriptExecution(await executeGhEditScript([
			{ action: "create", language: "python", x: 0, y: 0 },
		]));
		expect(validated.content).toEqual([{ type: "text", text: "Python create requires code." }]);
		expect(submitCommand).not.toHaveBeenCalled();
	});
});

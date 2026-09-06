import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { defaultDataDirectory, defaultGlobalPiAuthPath, resolveHostConfig } from "./config.js";

describe("host config", () => {
	it("keeps Windows preferences under roaming AppData, with a home-directory fallback", () => {
		expect(defaultDataDirectory({ platform: "win32", homeDir: "/users/test", env: { APPDATA: "/roaming" } }))
			.toBe(join("/roaming", "hopper-pi", "host"));
		expect(defaultDataDirectory({ platform: "win32", homeDir: "/users/test", env: {} }))
			.toBe(join("/users/test", "AppData", "Roaming", "hopper-pi", "host"));
	});

	it("uses a private platform application directory", () => {
		expect(defaultDataDirectory({ platform: "darwin", homeDir: "/Users/test" }))
			.toBe("/Users/test/Library/Application Support/hopper-pi/host");
		expect(defaultDataDirectory({
			platform: "linux",
			homeDir: "/home/test",
			env: { XDG_DATA_HOME: "/data" },
		})).toBe("/data/hopper-pi/host");
	});

	it("derives all Pi state below the configured data directory", () => {
		const config = resolveHostConfig([
			"--data-dir", "private",
			"--instance-id", "rhino-42-backend",
			"--connection-profile", "rhino.json",
			"--parent-pid", "42",
		], { cwd: "/work", moduleDir: "/app/host", homeDir: "/Users/test", env: {} });

		expect(config.paths).toEqual({
			dataDir: "/work/private",
			agentDir: "/work/private/agent",
			authPath: "/Users/test/.pi/agent/auth.json",
			sessionsDir: "/work/private/instances/rhino-42-backend/sessions",
			workspaceDir: "/work/private/instances/rhino-42-backend/workspace",
            scriptWorkspaceDir: "/work/private/workspaces/default",
			staticDir: "/app/host/static",
		});
		expect(config.connectionProfile).toBe("/work/rhino.json");
		expect(config.instanceId).toBe("rhino-42-backend");
		expect(config.parentPid).toBe(42);
		expect(config.host).toBe("127.0.0.1");
	});

	it("uses global Pi auth by default and honors its agent directory override", () => {
		expect(defaultGlobalPiAuthPath({ homeDir: "/Users/test", env: {} }))
			.toBe("/Users/test/.pi/agent/auth.json");
		expect(defaultGlobalPiAuthPath({
			homeDir: "/Users/test",
			env: { PI_CODING_AGENT_DIR: "~/shared-pi" },
		})).toBe("/Users/test/shared-pi/auth.json");
	});

	it("allows Hopper auth to be redirected explicitly", () => {
		const fromEnvironment = resolveHostConfig([], {
			cwd: "/work",
			homeDir: "/Users/test",
			env: { HOPPER_PI_AUTH_PATH: "~/hopper-auth.json" },
		});
		const fromArgument = resolveHostConfig(["--auth-path", "private/auth.json"], {
			cwd: "/work",
			homeDir: "/Users/test",
			env: { HOPPER_PI_AUTH_PATH: "/ignored/auth.json" },
		});

		expect(fromEnvironment.paths.authPath).toBe("/Users/test/hopper-auth.json");
		expect(fromArgument.paths.authPath).toBe("/work/private/auth.json");
	});

	it("rejects unsafe ports and malformed process ids", () => {
		expect(() => resolveHostConfig(["--port", "65536"])).toThrow("between 0 and 65535");
		expect(() => resolveHostConfig(["--parent-pid", "nope"])).toThrow("must be an integer");
		expect(() => resolveHostConfig(["--instance-id", "../shared"])).toThrow("only letters");
	});

	it("permits only an explicit loopback Vite development origin", () => {
		expect(resolveHostConfig(["--ui-dev-origin", "http://localhost:5173"], { env: {} }).uiDevOrigin)
			.toBe("http://localhost:5173");
		expect(resolveHostConfig(["--ui-dev-origin", "http://localhost:5173/?ignored=true"], { env: {} }).uiDevOrigin)
			.toBe("http://localhost:5173");
		expect(() => resolveHostConfig(["--ui-dev-origin", "https://localhost:5173"], { env: {} }))
			.toThrow("http localhost origin");
		expect(() => resolveHostConfig(["--ui-dev-origin", "http://example.com:5173"], { env: {} }))
			.toThrow("http localhost origin");
	});
});

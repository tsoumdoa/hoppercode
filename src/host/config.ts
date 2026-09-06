import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";

export type HostPaths = {
	dataDir: string;
	agentDir: string;
	authPath: string;
	sessionsDir: string;
	workspaceDir: string;
	scriptWorkspaceDir?: string;
	scriptWorkspaceQuotaBytes?: number;
	staticDir: string;
};

export type HostConfig = {
	host: typeof LOOPBACK_HOST;
	port: number;
	instanceId: string;
	parentPid?: number;
	connectionProfile?: string;
	uiDevOrigin?: string;
	paths: HostPaths;
};

export type HostConfigEnvironment = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	cwd?: string;
	moduleDir?: string;
};

function readOption(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}

function parseInteger(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is out of range`);
	return parsed;
}

export function defaultDataDirectory(options: HostConfigEnvironment = {}): string {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const userHome = options.homeDir ?? homedir();

	if (platform === "win32") {
		return join(env.APPDATA || join(userHome, "AppData", "Roaming"), "hopper-pi", "host");
	}
	if (platform === "darwin") {
		return join(userHome, "Library", "Application Support", "hopper-pi", "host");
	}
	return join(env.XDG_DATA_HOME || join(userHome, ".local", "share"), "hopper-pi", "host");
}

function expandUserPath(path: string, userHome: string): string {
	if (path === "~") return userHome;
	if (path.startsWith("~/")) return join(userHome, path.slice(2));
	return path;
}

export function defaultGlobalPiAuthPath(options: HostConfigEnvironment = {}): string {
	const env = options.env ?? process.env;
	const userHome = options.homeDir ?? homedir();
	const cwd = options.cwd ?? process.cwd();
	const configuredAgentDir = env.PI_CODING_AGENT_DIR;
	const agentDirValue = configuredAgentDir
		? expandUserPath(configuredAgentDir, userHome)
		: join(userHome, ".pi", "agent");
	const agentDir = isAbsolute(agentDirValue) ? agentDirValue : resolve(cwd, agentDirValue);
	return join(agentDir, "auth.json");
}

export function resolveHostConfig(
	args: readonly string[],
	options: HostConfigEnvironment = {},
): HostConfig {
	const cwd = options.cwd ?? process.cwd();
	const moduleDir = options.moduleDir ?? cwd;
	const env = options.env ?? process.env;
	const dataDirArg = readOption(args, "--data-dir");
	const authPathArg = readOption(args, "--auth-path");
	const scriptWorkspaceArg =
		readOption(args, "--script-workspace") ?? env.HOPPER_SCRIPT_WORKSPACE;
	if (scriptWorkspaceArg && !isAbsolute(scriptWorkspaceArg))
		throw new Error(
			"--script-workspace / HOPPER_SCRIPT_WORKSPACE must be absolute",
		);
	const scriptWorkspaceQuotaBytes = parseInteger(
		readOption(args, "--script-workspace-quota-bytes") ??
			env.HOPPER_SCRIPT_WORKSPACE_QUOTA_BYTES,
		"script workspace quota",
	);
	if (scriptWorkspaceQuotaBytes !== undefined && scriptWorkspaceQuotaBytes < 1)
		throw new Error("Script workspace quota must be positive");
	const staticDirArg = readOption(args, "--static-dir");
	const profileArg = readOption(args, "--connection-profile");
	const uiDevOriginArg = readOption(args, "--ui-dev-origin") ?? env.HOPPER_UI_DEV_ORIGIN;
	let uiDevOrigin: string | undefined;
	const instanceId = readOption(args, "--instance-id") ?? "standalone";
	const port = parseInteger(readOption(args, "--port"), "--port") ?? 0;
	const parentPid = parseInteger(readOption(args, "--parent-pid"), "--parent-pid");

	if (port < 0 || port > 65_535) throw new Error("--port must be between 0 and 65535");
	if (parentPid !== undefined && parentPid < 1) throw new Error("--parent-pid must be positive");
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) {
		throw new Error("--instance-id must contain only letters, numbers, underscores, or hyphens");
	}
	if (uiDevOriginArg) {
		let origin: URL;
		try {
			origin = new URL(uiDevOriginArg);
		} catch {
			throw new Error("--ui-dev-origin must be a valid URL");
		}
		if (origin.protocol !== "http:" || !["localhost", LOOPBACK_HOST].includes(origin.hostname) || !origin.port || origin.pathname !== "/") {
			throw new Error("--ui-dev-origin must be an http localhost origin with an explicit port");
		}
		uiDevOrigin = origin.origin;
	}

	const absolute = (path: string) => (isAbsolute(path) ? path : resolve(cwd, path));
	const dataDir = dataDirArg ? absolute(dataDirArg) : defaultDataDirectory(options);
	const configuredAuthPath = authPathArg ?? env.HOPPER_PI_AUTH_PATH;
	const authPath = configuredAuthPath
		? absolute(expandUserPath(configuredAuthPath, options.homeDir ?? homedir()))
		: defaultGlobalPiAuthPath(options);
	const instanceDir = join(dataDir, "instances", instanceId);

	return {
		host: LOOPBACK_HOST,
		port,
		instanceId,
		parentPid,
		connectionProfile: profileArg ? absolute(profileArg) : undefined,
		uiDevOrigin,
		paths: {
			dataDir,
			agentDir: join(dataDir, "agent"),
			authPath,
			sessionsDir: join(instanceDir, "sessions"),
			workspaceDir: join(instanceDir, "workspace"),
			scriptWorkspaceDir:
				scriptWorkspaceArg ?? join(dataDir, "workspaces", "default"),
			...(scriptWorkspaceQuotaBytes === undefined
				? {}
				: { scriptWorkspaceQuotaBytes }),
			staticDir: staticDirArg ? absolute(staticDirArg) : resolve(moduleDir, "static"),
		},
	};
}

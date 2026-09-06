import type { ReasonCode, RuntimeStatus } from "../protocol/v2.js";

export interface RuntimeStatusEventSource {
	subscribe(onWakeup: () => void): Promise<() => void | Promise<void>>;
}

export interface ReadinessClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export type GrasshopperReadinessOptions = {
	lifecycleInstanceId: string;
	events: RuntimeStatusEventSource;
	readStatus: (timeoutMs: number) => Promise<RuntimeStatus>;
	startGrasshopper: (timeoutMs: number) => Promise<void>;
	beforeStartGrasshopper?: (status: RuntimeStatus) => void | Promise<void>;
	clock?: ReadinessClock;
	timeoutMs?: number;
};

const systemClock: ReadinessClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class GrasshopperReadinessError extends Error {
	constructor(
		public readonly reasonCode: ReasonCode,
		public readonly status: RuntimeStatus,
		message: string,
	) {
		super(message);
		this.name = "GrasshopperReadinessError";
	}
}

export class GrasshopperReadinessCoordinator {
	private readonly lifecycleInstanceId: string;
	private readonly events: RuntimeStatusEventSource;
	private readonly readStatus: (timeoutMs: number) => Promise<RuntimeStatus>;
	private readonly startGrasshopper: (timeoutMs: number) => Promise<void>;
	private readonly beforeStartGrasshopper?: (status: RuntimeStatus) => void | Promise<void>;
	private readonly clock: ReadinessClock;
	private readonly timeoutMs: number;
	private inFlight: Promise<RuntimeStatus> | null = null;
	private activeInFlight: Promise<RuntimeStatus> | null = null;
	private wakeups: WakeupGate | null = null;
	private closed = false;

	constructor(options: GrasshopperReadinessOptions) {
		this.lifecycleInstanceId = options.lifecycleInstanceId;
		this.events = options.events;
		this.readStatus = options.readStatus;
		this.startGrasshopper = options.startGrasshopper;
		this.beforeStartGrasshopper = options.beforeStartGrasshopper;
		this.clock = options.clock ?? systemClock;
		this.timeoutMs = options.timeoutMs ?? 60_000;
	}

	ensureReady(requireActiveDocument = true): Promise<RuntimeStatus> {
		if (this.closed) return Promise.reject(new Error("Grasshopper readiness is closed."));
		if (!this.inFlight) {
			const pending = this.run();
			this.inFlight = pending;
			void pending.finally(() => {
				if (this.inFlight === pending) this.inFlight = null;
			}).catch(() => {});
		}
		if (!requireActiveDocument) return this.inFlight;
		if (!this.activeInFlight) {
			const pending = this.inFlight.then((status) => {
				if (!status.grasshopper.activeDocument) throw new GrasshopperReadinessError("NO_ACTIVE_GRASSHOPPER_DOCUMENT", status, "Grasshopper is ready but has no active document.");
				return status;
			});
			this.activeInFlight = pending;
			void pending.finally(() => {
				if (this.activeInFlight === pending) this.activeInFlight = null;
			}).catch(() => {});
		}
		return this.activeInFlight;
	}

	close(): void {
		this.closed = true;
		this.wakeups?.close();
	}

	private async run(): Promise<RuntimeStatus> {
		const deadlineAt = this.clock.now() + this.timeoutMs;
		const wakeups = new WakeupGate(this.clock);
		this.wakeups = wakeups;
		let unsubscribe: () => void | Promise<void> = () => { };
		let status: RuntimeStatus | null = null;
		let lastReadError: unknown;
		let startIssued = false;

		try {
			unsubscribe = await this.events.subscribe(() => wakeups.signal());
			this.throwIfClosed();
			({ status, error: lastReadError } = await this.tryReadStatus(deadlineAt));
			if (status) this.assertLifecycle(status);
			if (status?.grasshopper.state === "not_loaded") {
				startIssued = true;
				try {
					await this.beforeStartGrasshopper?.(status);
					await this.startGrasshopper(this.remainingCallBudget(deadlineAt));
				} catch (error) {
					lastReadError = error;
				}
			}
			// Always read again after subscription and the optional start request.
			// Advisory events can be dropped or can arrive during either RPC call.
			({ status, error: lastReadError } = await this.tryReadStatus(deadlineAt));

			while (true) {
				if (status) {
					this.assertLifecycle(status);
					if (status.grasshopper.state === "ready") {
						return status;
					}

					this.throwIfTerminalState(status);
					if (status.grasshopper.state === "not_loaded" && !startIssued) {
						// Set this before awaiting: a lost control reply must not cause a
						// second start request.
						startIssued = true;
						try {
							await this.beforeStartGrasshopper?.(status);
							await this.startGrasshopper(this.remainingCallBudget(deadlineAt));
						} catch (error) {
							lastReadError = error;
						}
						// Close the subscribe/read/start race even if the advisory event
						// was published before the subscription became effective.
						({ status, error: lastReadError } = await this.tryReadStatus(deadlineAt));
						continue;
					}
				}

				const remaining = deadlineAt - this.clock.now();
				if (remaining <= 0) {
					const finalRead = await this.tryReadStatus(deadlineAt);
					if (finalRead.status) {
						this.assertLifecycle(finalRead.status);
						if (finalRead.status.grasshopper.state === "ready") {
							return finalRead.status;
						}
						this.throwIfTerminalState(finalRead.status);
						throw new GrasshopperReadinessError(
							"GRASSHOPPER_START_FAILED",
							finalRead.status,
							`Grasshopper did not become ready within ${this.timeoutMs}ms.`,
						);
					}
					throw new Error(
						`Grasshopper readiness timed out after ${this.timeoutMs}ms` +
						(lastReadError ? `: ${errorMessage(lastReadError)}` : ""),
					);
				}

				const wakeReason = await wakeups.wait(remaining);
				this.throwIfClosed();
				({ status, error: lastReadError } = await this.tryReadStatus(deadlineAt));
				if (wakeReason === "deadline" && status?.grasshopper.state !== "ready") {
					this.assertLifecycle(status ?? undefined);
					if (status) {
						this.throwIfTerminalState(status);
						throw new GrasshopperReadinessError(
							"GRASSHOPPER_START_FAILED",
							status,
							`Grasshopper did not become ready within ${this.timeoutMs}ms.`,
						);
					}
					throw new Error(
						`Grasshopper readiness timed out after ${this.timeoutMs}ms` +
						(lastReadError ? `: ${errorMessage(lastReadError)}` : ""),
					);
				}
			}
		} finally {
			if (this.wakeups === wakeups) this.wakeups = null;
			wakeups.close();
			await unsubscribe();
		}
	}

	private async tryReadStatus(
		deadlineAt: number,
	): Promise<{ status: RuntimeStatus | null; error: unknown }> {
		try {
			return {
				status: await this.readStatus(this.remainingCallBudget(deadlineAt)),
				error: undefined,
			};
		} catch (error) {
			return { status: null, error };
		}
	}

	private remainingCallBudget(deadlineAt: number): number {
		return Math.max(1, deadlineAt - this.clock.now());
	}

	private assertLifecycle(status: RuntimeStatus | undefined): void {
		if (!status) return;
		const observed = status.transport.lifecycleInstanceId;
		if (observed !== null && observed !== this.lifecycleInstanceId) {
			throw new Error(
				`Runtime status belongs to lifecycle ${observed}, expected ${this.lifecycleInstanceId}`,
			);
		}
	}

	private throwIfTerminalState(status: RuntimeStatus): void {
		if (status.grasshopper.state === "not_installed") {
			throw new GrasshopperReadinessError(
				"GRASSHOPPER_NOT_INSTALLED",
				status,
				status.errors.grasshopper?.message ?? "Grasshopper is not installed.",
			);
		}
		if (status.grasshopper.state === "failed") {
			throw new GrasshopperReadinessError(
				"GRASSHOPPER_START_FAILED",
				status,
				status.errors.grasshopper?.message ?? "Grasshopper failed to start.",
			);
		}
	}

	private throwIfClosed(): void {
		if (this.closed) throw new Error("Grasshopper readiness is closed.");
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class WakeupGate {
	private queued = false;
	private closed = false;
	private resolve: ((reason: "event" | "closed") => void) | null = null;

	constructor(private readonly clock: ReadinessClock) { }

	signal(): void {
		if (this.closed) return;
		if (this.resolve) {
			const resolve = this.resolve;
			this.resolve = null;
			resolve("event");
			return;
		}
		this.queued = true;
	}

	wait(delayMs: number): Promise<"event" | "deadline" | "closed"> {
		if (this.closed) return Promise.resolve("closed");
		if (this.queued) {
			this.queued = false;
			return Promise.resolve("event");
		}

		return new Promise((resolve) => {
			const timer = this.clock.setTimeout(() => {
				this.resolve = null;
				resolve("deadline");
			}, delayMs);
			this.resolve = (reason) => {
				this.clock.clearTimeout(timer);
				resolve(reason);
			};
		});
	}

	close(): void {
		this.closed = true;
		this.queued = false;
		if (!this.resolve) return;
		const resolve = this.resolve;
		this.resolve = null;
		resolve("closed");
	}
}

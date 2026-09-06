import { FlaskConical, Power } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHopperStore, useHopperStoreApi } from "./state/hopper-store-context";
import { Composer, type ComposerHandle } from "./components/composer";
import { ConfirmDialog, type ConfirmRequest } from "./components/confirm-dialog";
import { ConnectionBanner } from "./components/connection-banner";
import { Conversation } from "./components/conversation";
import { ModelControls } from "./components/model-picker";
import { ProviderDialog } from "./components/provider-dialog";
import { Sidebar } from "./components/sidebar";
import { SkillsDialog } from "./components/skills-dialog";
import { ToastRegion } from "./components/toasts";
import { UiRequestDialog } from "./components/ui-request-dialog";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { useHopperConnection } from "./hooks/use-hopper-connection";
import { providerLabel } from "./lib/utils";
import type { DraftImage } from "./lib/image-attachments";
import type { SendMode } from "./state/hopper-types";

const SIDEBAR_KEY = "hopper.sidebar.collapsed";

function readCollapsed() {
	try {
		return window.localStorage.getItem(SIDEBAR_KEY) === "1";
	} catch {
		return false;
	}
}

function StatusPill({ connectionStatus, streaming, workingMessage }: { connectionStatus: string; streaming: boolean; workingMessage: string | null }) {
	if (connectionStatus !== "connected") {
		const label = { connecting: "Connecting", authenticating: "Authenticating", disconnected: "Offline", error: "Offline" }[connectionStatus] ?? "Starting";
		return <Badge variant={connectionStatus === "disconnected" || connectionStatus === "error" ? "danger" : "warn"} dot pulse={connectionStatus !== "disconnected"}>{label}</Badge>;
	}
	if (streaming) return <Badge variant="accent" dot pulse className="max-w-[240px] [&>span:last-child]:truncate"><span>{workingMessage || "Working"}</span></Badge>;
	return <Badge dot>Ready</Badge>;
}

export function App() {
	const { token, send, prompt, login, logout, reconnect, isMockMode } = useHopperConnection();
	const store = useHopperStoreApi();
	const connection = useHopperStore((state) => state.connection);
	const sessionName = useHopperStore((state) => state.session.name);
	const sessionId = useHopperStore((state) => state.session.id);
	const streaming = useHopperStore((state) => state.session.isStreaming);
	const workingMessage = useHopperStore((state) => state.workingMessage);
	const authCompletedCount = useHopperStore((state) => state.auth.completedCount);
	const connected = connection.status === "connected";

	const [draft, setDraft] = useState("");
	const [images, setImages] = useState<DraftImage[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const submission = useRef<object | null>(null);
	const selectedModel = useHopperStore((state) => state.selectedModel);
	const imagesSupported = selectedModel?.input?.includes("image") !== false;
	// Explicit delivery choice made while a turn runs; null means the default for the current state.
	const [modeOverride, setModeOverride] = useState<SendMode | null>(null);
	const [providerOpen, setProviderOpen] = useState(false);
	const [skillsOpen, setSkillsOpen] = useState(false);
	const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(readCollapsed);
	const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
	const composer = useRef<ComposerHandle>(null);

	// While a turn runs, new text becomes a follow-up unless the user picks otherwise;
	// when it finishes, go back to starting new turns.
	const mode: SendMode = modeOverride ?? (streaming ? "follow_up" : "prompt");

	useEffect(() => {
		document.title = sessionName ? `${sessionName} · Hopper` : "Hopper";
	}, [sessionName]);

	useEffect(() => {
		try {
			window.localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? "1" : "0");
		} catch {
			// Storage may be unavailable; the preference is only a convenience.
		}
	}, [sidebarCollapsed]);

	useEffect(() => {
		if (!streaming) setModeOverride(null);
	}, [streaming]);

	// A completed sign-in closes the provider dialog.
	useEffect(() => {
		if (authCompletedCount > 0) setProviderOpen(false);
	}, [authCompletedCount]);

	// Focus the composer when the host becomes ready or a new session starts.
	useEffect(() => {
		if (connected) composer.current?.focus();
	}, [connected, sessionId]);

	const submit = () => {
		if (submission.current) return;
		const text = draft.trim();
		if (!text && !images.length) return;
		if (images.length && !imagesSupported) return;
		const current = {};
		submission.current = current;
		setSubmitting(true);
		const finish = (accepted: boolean) => {
			if (submission.current !== current) return;
			submission.current = null;
			setSubmitting(false);
			if (accepted) { setDraft(""); setImages([]); }
		};
		if (!prompt(text, mode, images.map((attachment) => attachment.image), {
			onAccepted: () => finish(true), onRejected: () => finish(false),
		})) finish(false);
	};

	useEffect(() => { setImages([]); submission.current = null; setSubmitting(false); }, [sessionId]);

	const newSession = () => {
		const start = () => send({ type: "new_session" });
		if (streaming) {
			setConfirm({
				title: "Start a new session?",
				description: "Hopper is still working on the current response. Starting a new session stops it and clears this conversation.",
				confirmLabel: "New session",
				action: start,
			});
			return;
		}
		start();
	};

	const shutdown = () =>
		setConfirm({
			title: "Shut down the Hopper host?",
			description: "This stops the local Hopper host and closes this page's connection. Rhino can start it again with _HopperCode.",
			confirmLabel: "Shut down",
			destructive: true,
			action: () => send({ type: "shutdown" }),
		});

	const requestLogout = (provider: string) =>
		setConfirm({
			title: `Log out of ${providerLabel(provider, store.getState().providers)}?`,
			description: "Hopper forgets the saved credential for this provider. Models from it stop being available until you sign in again.",
			confirmLabel: "Log out",
			destructive: true,
			action: () => logout(provider),
		});

	const selectModel = (value: string) => {
		const [provider, ...rest] = value.split("/");
		const id = rest.join("/");
		if (provider && id) send({ type: "set_model", provider, id });
	};

	const openProvider = useCallback(() => {
		setMobileSettingsOpen(false);
		setProviderOpen(true);
	}, []);

	const useSuggestion = (text: string) => {
		if (submission.current) return;
		setDraft(text);
		composer.current?.focus();
	};

	return (
		<div className="flex h-dvh flex-col overflow-hidden bg-canvas lg:flex-row">
			<a className="skip-link" href="#composer-input">Skip to message</a>
			<Sidebar
				token={token}
				connected={connected}
				collapsed={sidebarCollapsed}
				onCollapsedChange={setSidebarCollapsed}
				mobileOpen={mobileSettingsOpen}
				onMobileOpenChange={setMobileSettingsOpen}
				onNewSession={newSession}
				onManageProvider={openProvider}
				onManageSkills={() => { setMobileSettingsOpen(false); setSkillsOpen(true); }}
				onReconnect={reconnect}
			/>
			<main className="flex min-h-0 min-w-0 flex-1 flex-col">
				<header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 sm:px-6">
					<h1 className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight">{sessionName}</h1>
					{isMockMode && (
						<Badge variant="warn" className="max-sm:hidden">
							<FlaskConical className="size-3" />
							Mock
						</Badge>
					)}
					<StatusPill connectionStatus={connection.status} streaming={streaming} workingMessage={workingMessage} />
					<Button size="icon-sm" variant="ghost" className="-mr-1.5" disabled={!connected} onClick={shutdown} aria-label="Shut down the Hopper host" title="Shut down the Hopper host">
						<Power className="size-3.5" />
					</Button>
				</header>
				<ConnectionBanner connection={connection} onReconnect={reconnect} />
				<Conversation connected={connected} onSuggestion={useSuggestion} />
				<Composer
					key={sessionId}
					ref={composer}
					draft={draft}
					onDraftChange={setDraft}
					images={images}
					onImagesChange={setImages}
					imagesSupported={imagesSupported}
					mode={mode}
					onModeChange={setModeOverride}
					disabled={!connected || submitting}
					streaming={streaming}
					onSubmit={submit}
					onAbort={() => send({ type: "abort" })}
					controls={
						<ModelControls
							connected={connected}
							onSelectModel={selectModel}
							onSelectThinking={(level) => send({ type: "set_thinking", level })}
							onManageProvider={openProvider}
						/>
					}
				/>
			</main>

			{providerOpen && (
				<ProviderDialog
					onOpenChange={setProviderOpen}
					onLogin={login}
					onLogout={requestLogout}
				/>
			)}
			{skillsOpen && <SkillsDialog token={token} connected={connected} streaming={streaming} onOpenChange={setSkillsOpen} />}
			<UiRequestDialog send={send} />
			<ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
			<ToastRegion />
		</div>
	);
}

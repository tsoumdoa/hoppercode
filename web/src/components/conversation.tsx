import { ArrowDown, Brain, ChevronRight, CircleAlert, CircleCheck, Loader2, Wrench } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHopperStore } from "../state/hopper-store-context";
import { cn, formatValue, summarizeValue } from "../lib/utils";
import type { ConversationMessage, ToolCall } from "../state/hopper-types";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

const SUGGESTIONS = [
	{ label: "Inspect this canvas", prompt: "Inspect the active Grasshopper canvas and summarize its structure and any errors." },
	{ label: "Create a pavilion", prompt: "Create a simple parametric pavilion on the active Grasshopper canvas. Explain the plan before applying the graph." },
	{ label: "Check the Rhino model", prompt: "Check the active Rhino document and tell me what geometry is present." },
];

const KIND_LABELS = { steer: "Steering note", follow_up: "Follow-up" } as const;

function ToolStatusIcon({ status }: { status: ToolCall["status"] }) {
	if (status === "running") return <Loader2 className="size-3.5 animate-spin text-accent" />;
	if (status === "error") return <CircleAlert className="size-3.5 text-danger" />;
	return <CircleCheck className="size-3.5 text-muted" />;
}

function ToolCard({ tool }: { tool: ToolCall }) {
	const [open, setOpen] = useState(tool.status === "error");
	useEffect(() => {
		if (tool.status === "error") setOpen(true);
	}, [tool.status]);
	const hasResult = tool.args !== undefined && tool.detail !== tool.args;
	const preview = summarizeValue(tool.status === "running" ? tool.args : tool.detail);
	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className={cn(
				"overflow-hidden rounded-sm border bg-surface text-xs transition-colors",
				tool.status === "error" ? "border-danger/30" : "border-line hover:border-line-strong",
			)}
		>
			<CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left outline-none focus-visible:bg-surface-muted">
				<ChevronRight className="size-3.5 shrink-0 text-muted transition-transform group-data-[state=open]:rotate-90" />
				<Wrench className="size-3 shrink-0 text-muted" />
				<span className="shrink-0 font-mono text-[11.5px] font-medium text-ink">{tool.name}</span>
				{preview && <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{preview}</span>}
				<span className={cn("ml-auto flex shrink-0 items-center gap-1.5", tool.status === "error" ? "text-danger" : tool.status === "running" ? "text-accent" : "text-muted")}>
					<span className="max-sm:hidden">{tool.status === "running" ? "Running" : tool.status === "error" ? "Failed" : "Done"}</span>
					<ToolStatusIcon status={tool.status} />
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="border-t border-line bg-surface-muted">
				{hasResult && (
					<div className="border-b border-line px-2.5 py-2">
						<p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted">Input</p>
						<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-soft">{formatValue(tool.args)}</pre>
					</div>
				)}
				<div className="px-2.5 py-2">
					{hasResult && <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted">{tool.status === "error" ? "Error" : "Output"}</p>}
					<pre className={cn("max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed", tool.status === "error" ? "text-danger" : "text-ink-soft")}>
						{formatValue(tool.detail)}
					</pre>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
	return (
		<Collapsible className="text-xs">
			<CollapsibleTrigger className="group inline-flex items-center gap-1.5 rounded-sm py-0.5 text-muted outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40">
				<Brain className={cn("size-3.5", streaming && "animate-pulse text-accent")} />
				<span className="font-medium">{streaming ? "Thinking…" : "Thinking"}</span>
				<ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-1 whitespace-pre-wrap border-l-2 border-line pl-3 leading-5 text-ink-soft">{text}</CollapsibleContent>
		</Collapsible>
	);
}

function UserMessage({ message }: { message: ConversationMessage }) {
	const kind = message.kind && message.kind !== "prompt" ? KIND_LABELS[message.kind] : null;
	return (
		<article className="flex justify-end animate-slide-up" aria-label="Your message">
			<div className="max-w-[min(85%,560px)]">
				{kind && <p className="mb-1 text-right text-[11px] font-medium text-muted">{kind}</p>}
				<div className="whitespace-pre-wrap break-words rounded-md bg-surface-muted px-3.5 py-2 text-[14px] leading-6 text-ink">{message.text}
					{message.images?.map((image, index) => <a key={index} href={`data:${image.mimeType};base64,${image.data}`} download={`attachment-${index + 1}`} className="mt-2 block" title="Download image"><img src={`data:${image.mimeType};base64,${image.data}`} alt={`Attached image ${index + 1}`} className="max-h-72 rounded-sm object-contain" /></a>)}
				</div>
			</div>
		</article>
	);
}

function AssistantMessage({ message }: { message: ConversationMessage }) {
	const empty = !message.text && !message.thinking && !message.error && message.tools.length === 0;
	return (
		<article className="animate-slide-up" aria-label="Hopper's reply">
			<div className="mb-1.5 flex items-center gap-2 text-xs">
				<span aria-hidden="true" className={cn("size-1.5 rounded-full bg-accent", message.streaming && "animate-pulse")} />
				<span className="font-medium text-ink">Hopper</span>
				{message.streaming && <span className="text-muted">Working…</span>}
			</div>
			<div className="min-w-0 pl-3.5">
				{message.thinking && (
					<div className="mb-2">
						<ThinkingBlock text={message.thinking} streaming={message.streaming && !message.text} />
					</div>
				)}
				{message.text && (
					<div className="whitespace-pre-wrap break-words text-[14px] leading-7 text-ink">
						{message.text}
						{message.streaming && <span aria-hidden="true" className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-accent animate-blink" />}
					</div>
				)}
				{message.error && (
					<p className="mt-2 flex items-start gap-2 rounded-sm border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] leading-5 text-danger" role="alert">
						<CircleAlert className="mt-0.5 size-4 shrink-0" />
						<span>{message.error}</span>
					</p>
				)}
				{empty && (
					<p className="flex items-center gap-2 text-[13px] text-muted">
						{message.streaming ? (
							<>
								<Loader2 className="size-3.5 animate-spin" />
								Getting started…
							</>
						) : (
							"No response was returned."
						)}
					</p>
				)}
				{message.tools.length > 0 && (
					<div className="mt-3 grid gap-1">
						{message.tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
					</div>
				)}
			</div>
		</article>
	);
}

function Welcome({ connected, onSuggestion }: { connected: boolean; onSuggestion(prompt: string): void }) {
	return (
		<section className="mx-auto mt-[max(14vh,2rem)] w-full max-w-[560px] animate-slide-up" aria-labelledby="welcome-title">
			<span aria-hidden="true" className="grid size-7 place-items-center rounded-sm bg-accent text-[14px] font-bold leading-none text-white">H</span>
			<h2 id="welcome-title" className="mt-4 text-[22px] font-semibold leading-tight tracking-[-.02em]">
				What should Hopper build?
			</h2>
			<p className="mt-1.5 text-[13px] text-muted">
				{connected ? "Describe a change to the active Grasshopper canvas or Rhino document." : "Connecting to the local Hopper host…"}
			</p>
			<div className="mt-5 flex flex-wrap gap-1.5" role="group" aria-label="Prompt suggestions">
				{SUGGESTIONS.map((suggestion) => (
					<Button key={suggestion.label} size="sm" variant="secondary" disabled={!connected} onClick={() => onSuggestion(suggestion.prompt)}>
						{suggestion.label}
					</Button>
				))}
			</div>
		</section>
	);
}

export function Conversation({
	connected,
	onSuggestion,
}: {
	connected: boolean;
	onSuggestion(prompt: string): void;
}) {
	const messages = useHopperStore((state) => state.session.messages);
	const scroller = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);
	const [showJump, setShowJump] = useState(false);
	const lastMessageId = messages.at(-1)?.id;
	const lastRole = messages.at(-1)?.role;

	const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
		const node = scroller.current;
		if (!node) return;
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		node.scrollTo({ top: node.scrollHeight, behavior: reducedMotion ? "auto" : behavior });
	};

	const onScroll = () => {
		const node = scroller.current;
		if (!node) return;
		const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
		stickToBottom.current = distance < 80;
		setShowJump(distance > 240);
	};

	// A new message the user just sent always reveals the bottom; otherwise follow only
	// while the reader is already near the bottom so they can scroll back during streaming.
	useLayoutEffect(() => {
		if (lastRole === "user") stickToBottom.current = true;
		if (stickToBottom.current) scrollToBottom(lastRole === "user" ? "smooth" : "auto");
	}, [messages, lastMessageId, lastRole]);

	return (
		<div className="relative min-h-0 flex-1">
			<div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-6 sm:px-6" aria-label="Conversation" aria-live="polite">
				<div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 pb-4">
					{messages.length === 0 ? (
						<Welcome connected={connected} onSuggestion={onSuggestion} />
					) : (
						messages.map((message) => message.role === "user" ? <UserMessage key={message.id} message={message} /> : <AssistantMessage key={message.id} message={message} />)
					)}
				</div>
			</div>
			{showJump && (
				<Button
					size="sm"
					variant="secondary"
					className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-pop animate-pop-in"
					onClick={() => {
						stickToBottom.current = true;
						scrollToBottom();
					}}
				>
					<ArrowDown className="size-3.5" />
					Jump to latest
				</Button>
			)}
		</div>
	);
}

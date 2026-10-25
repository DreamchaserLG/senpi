import { TuiAltScreen } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import { AttachedTui, validateAttachTerminal } from "./attach.ts";
import { initTheme, stopThemeWatcher } from "./theme/theme.ts";
import { createInteractiveTui } from "./tui-renderer.ts";

/** Lazy CLI presentation boundary, parallel to the ordinary interactive mode. */
export async function runAttachedTui(options: {
	readonly address: string;
	readonly session: string;
	readonly tuiMode?: "regular" | "fullscreen";
	readonly theme?: string;
}): Promise<void> {
	validateAttachTerminal(process.stdin.isTTY, process.stdout.isTTY);
	initTheme(options.theme);
	const ui = createInteractiveTui({
		tuiMode: options.tuiMode ?? "regular",
		showHardwareCursor: false,
		logDirectory: getAgentDir(),
	});
	let finish: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const view = new AttachedTui(ui, finish);
	const stop = () => finish();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	ui.addChild(view);
	if (ui instanceof TuiAltScreen) ui.setLayoutRoot(view.layoutRoot);
	ui.setFocus(view);
	ui.start();
	try {
		await view.connect(options.address, options.session);
		await done;
	} finally {
		try {
			await view.close();
		} finally {
			process.off("SIGTERM", stop);
			process.off("SIGINT", stop);
			ui.stop();
			stopThemeWatcher();
		}
	}
}

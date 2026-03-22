import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
} from "obsidian";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";

const execFileAsync = promisify(execFile);

interface ImageUploaderSettings {
	/**
	 * CLI command path/name to run.
	 * The plugin will execute: <uploadCommand> ...args <absolute_image_path>
	 * The command must print the uploaded image URL to stdout.
	 */
	uploadCommand: string;

	/**
	 * Optional working directory for the CLI command.
	 * If empty, defaults to the vault root.
	 */
	commandCwd: string;

	/**
	 * When true, also process wiki-style embeds: ![[image.png]]
	 */
	processWikiEmbeds: boolean;

	/**
	 * Extra args inserted before the image path.
	 * For ploys3, default is: ["upload"] so the final call becomes:
	 *   ploys3 upload <absolute_image_path>
	 */
	uploadArgs: string[];
}

const DEFAULT_SETTINGS: ImageUploaderSettings = {
	uploadCommand: "/Applications/PloyS3.app/Resources/bin/ploys3",
	commandCwd: "",
	processWikiEmbeds: true,
	uploadArgs: ["upload"],
};

/**
 * Matches standard markdown images: ![alt](target "title")
 * Captures target (group 1).
 */
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Matches wiki-style embeds: ![[target|alias]] or ![[target]]
 * Captures the inside (group 1).
 */
const WIKI_EMBED_RE = /!\[\[([^\]]+)\]\]/g;

function isRemoteImageTarget(target: string): boolean {
	const t = target.trim();
	// Already-remote images should not be processed.
	return (
		t.startsWith("http://") ||
		t.startsWith("https://") ||
		t.startsWith("data:") ||
		t.startsWith("file://")
	);
}

function stripWikiAlias(target: string): string {
	// ![[path|alias]] -> path
	const pipeIdx = target.indexOf("|");
	return (pipeIdx >= 0 ? target.slice(0, pipeIdx) : target).trim();
}

function stripAngleBrackets(target: string): string {
	// Markdown allows: ![]( <path with spaces> )
	let t = target.trim();
	if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1);
	return t.trim();
}

function decodeMarkdownLinkTarget(target: string): string {
	// Common case: spaces encoded as %20
	try {
		return decodeURI(target);
	} catch {
		return target;
	}
}

async function getVaultRoot(app: App): Promise<string> {
	// @ts-expect-error Obsidian exposes vault.adapter base path on desktop
	const basePath: string | undefined = app.vault.adapter?.basePath;
	if (!basePath) throw new Error("Cannot determine vault base path (desktop only).");
	return basePath;
}

async function resolveTargetToFile(app: App, note: TFile, rawTarget: string): Promise<TFile | null> {
	// Handles both markdown and wiki link targets.
	let target = rawTarget.trim();
	target = stripAngleBrackets(target);
	target = decodeMarkdownLinkTarget(target);
	if (!target) return null;
	if (isRemoteImageTarget(target)) return null;

	// Remove querystring/fragment if present: image.png?raw=1#fragment
	const noQuery = target.split("?")[0].split("#")[0];

	// 1) Try resolving as a link relative to the note.
	const dest = app.metadataCache.getFirstLinkpathDest(noQuery, note.path);
	if (dest && dest instanceof TFile) return dest;

	// 2) Try as vault-absolute path.
	const absInVault = normalizePath(noQuery);
	const af = app.vault.getAbstractFileByPath(absInVault);
	if (af && af instanceof TFile) return af;

	return null;
}

async function runUploadCommand(settings: ImageUploaderSettings, vaultRoot: string, absoluteImagePath: string): Promise<string> {
	if (!settings.uploadCommand.trim()) {
		throw new Error("Upload command is empty. Configure it in plugin settings.");
	}

	// Execute: <uploadCommand> <absoluteImagePath>
	// The command must print the final URL to stdout.
	const args = [...(settings.uploadArgs ?? []), absoluteImagePath];
	const { stdout, stderr } = await execFileAsync(settings.uploadCommand, args, { 
		cwd: settings.commandCwd.trim() ? settings.commandCwd.trim() : vaultRoot,
		windowsHide: true,
		maxBuffer: 10 * 1024 * 1024,
		env: process.env,
	});

	const out = (stdout ?? "").trim();
	if (!out) {
		throw new Error(`Upload command produced no output. stderr: ${(stderr ?? "").trim()}`);
	}
	// Use first non-empty line as URL.
	const url = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
	if (!url) throw new Error("Upload command output had no usable URL.");
	return url;
}

export default class ImageUploaderPlugin extends Plugin {
	settings!: ImageUploaderSettings;

	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		this.addRibbonIcon("upload", "Upload local images in current note", async () => {
			await this.handleUploadClicked();
		});

		this.addCommand({
			id: "upload-images-in-active-note",
			name: "Upload local images in active note",
			callback: async () => {
				await this.handleUploadClicked();
			},
		});

		this.addSettingTab(new ImageUploaderSettingTab(this.app, this));
	}

	async onunload() {
		// nothing
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async handleUploadClicked(): Promise<void> {
		const active = this.app.workspace.getActiveFile();
		if (!active) {
			new Notice("No active file.");
			return;
		}
		if (active.extension.toLowerCase() !== "md") {
			new Notice("Active file is not a markdown note.");
			return;
		}

		// Check if the upload command (PloyS3) is installed
		const cmd = this.settings.uploadCommand.trim();
		if (cmd) {
			try {
				await access(cmd);
			} catch {
				const frag = new DocumentFragment();
				frag.appendText("PloyS3 is not installed. Please install it first: ");
				const link = frag.createEl("a", {
					text: "https://github.com/mylxsw/ploys3",
					href: "https://github.com/mylxsw/ploys3",
				});
				link.style.color = "var(--text-accent)";
				new Notice(frag, 10000);
				return;
			}
		}

		try {
			await this.processNote(active);
		} catch (e) {
			console.error(e);
			new Notice(`Image upload failed: ${(e as Error)?.message ?? e}`);
		}
	}

	private async processNote(note: TFile): Promise<void> {
		const vaultRoot = await getVaultRoot(this.app);
		const original = await this.app.vault.read(note);

		// Collect targets from the note.
		const mdTargets: string[] = [];
		for (const m of original.matchAll(MD_IMAGE_RE)) {
			mdTargets.push(m[1]);
		}

		const wikiTargets: string[] = [];
		if (this.settings.processWikiEmbeds) {
			for (const m of original.matchAll(WIKI_EMBED_RE)) {
				wikiTargets.push(stripWikiAlias(m[1]));
			}
		}

		const allTargets = [...mdTargets, ...wikiTargets].filter((t) => !!t && !isRemoteImageTarget(t));
		if (allTargets.length === 0) {
			new Notice("No local images found in current note.");
			return;
		}

		// Resolve to actual files and de-duplicate by path.
		const resolvedFiles: TFile[] = [];
		const seen = new Set<string>();
		for (const t of allTargets) {
			const f = await resolveTargetToFile(this.app, note, t);
			if (!f) continue;
			if (seen.has(f.path)) continue;
			seen.add(f.path);
			resolvedFiles.push(f);
		}

		if (resolvedFiles.length === 0) {
			new Notice("No resolvable local image files found.");
			return;
		}

		new Notice(`Uploading ${resolvedFiles.length} image(s)...`);

		// Upload sequentially to keep it simple and avoid hammering image beds.
		const mapOldToNew = new Map<string, string>();
		for (const imgFile of resolvedFiles) {
			// @ts-expect-error Obsidian exposes adapter full path on desktop
			const fullPath: string | undefined = this.app.vault.adapter?.getFullPath?.(imgFile.path);
			const absPath = fullPath ?? `${vaultRoot}/${imgFile.path}`;
			const url = await runUploadCommand(this.settings, vaultRoot, absPath);
			mapOldToNew.set(imgFile.path, url);
		}

		let updated = original;

		// Replace markdown image targets.
		updated = updated.replace(MD_IMAGE_RE, (whole, target1: string) => {
			const rawTarget = String(target1);
			if (isRemoteImageTarget(rawTarget)) return whole;

			const cleaned = stripAngleBrackets(decodeMarkdownLinkTarget(rawTarget));
			const cleanedNoQuery = cleaned.split("?")[0].split("#")[0];
			const f = this.app.metadataCache.getFirstLinkpathDest(cleanedNoQuery, note.path);
			if (!f || !(f instanceof TFile)) return whole;
			const newUrl = mapOldToNew.get(f.path);
			if (!newUrl) return whole;

			return whole.replace(rawTarget, newUrl);
		});

		// Replace wiki embed targets.
		if (this.settings.processWikiEmbeds) {
			updated = updated.replace(WIKI_EMBED_RE, (whole, inner: string) => {
				const innerStr = String(inner);
				const target = stripWikiAlias(innerStr);
				if (isRemoteImageTarget(target)) return whole;

				const f = this.app.metadataCache.getFirstLinkpathDest(target, note.path);
				if (!f || !(f instanceof TFile)) return whole;
				const newUrl = mapOldToNew.get(f.path);
				if (!newUrl) return whole;

				// Convert wiki embed to standard markdown image link.
				const pipeIdx = innerStr.indexOf("|");
				const alt = pipeIdx >= 0 ? innerStr.slice(pipeIdx + 1).trim() : target;
				return `![${alt}](${newUrl})`;
			});
		}

		if (updated === original) {
			new Notice("No changes made (nothing replaced).");
			return;
		}

		await this.app.vault.modify(note, updated);
		new Notice("Image links replaced and note updated.");
	}
}

class ImageUploaderSettingTab extends PluginSettingTab {
	plugin: ImageUploaderPlugin;

	constructor(app: App, plugin: ImageUploaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Image Uploader Button" });

		new Setting(containerEl)
			.setName("Upload command")
			.setDesc(
				"CLI executable to run. It will be called as: <command> <uploadArgs...> <absolute_image_path>. The command must print the uploaded image URL to stdout."
			)
			.addText((text) =>
				text
					.setPlaceholder("/Applications/PloyS3.app/Resources/bin/ploys3")
					.setValue(this.plugin.settings.uploadCommand)
					.onChange(async (value) => {
						this.plugin.settings.uploadCommand = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Upload args")
			.setDesc("Arguments inserted before the image path. Default for PloyS3 is: upload")
			.addText((text) =>
				text
					.setPlaceholder("upload")
					.setValue((this.plugin.settings.uploadArgs ?? []).join(" "))
					.onChange(async (value) => {
						this.plugin.settings.uploadArgs = value
							.split(/\s+/)
							.map((v) => v.trim())
							.filter((v) => v.length > 0);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Command working directory (optional)")
			.setDesc("If empty, uses the vault root.")
			.addText((text) =>
				text
					.setPlaceholder("/path/to/vault")
					.setValue(this.plugin.settings.commandCwd)
					.onChange(async (value) => {
						this.plugin.settings.commandCwd = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Process wiki embeds (![[...]])")
			.setDesc("If disabled, only standard markdown image links ![]() are processed.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.processWikiEmbeds).onChange(async (value) => {
					this.plugin.settings.processWikiEmbeds = value;
					await this.plugin.saveSettings();
				})
			);
	}
}

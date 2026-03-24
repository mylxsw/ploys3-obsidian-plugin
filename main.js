"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const DEFAULT_PLOYS3_LOCATIONS = [
    (0, node_path_1.join)((0, node_os_1.homedir)(), ".local/bin/ploys3"),
    "/Applications/PloyS3.app/Resources/bin/ploys3",
];
const DEFAULT_SETTINGS = {
    uploadCommand: "",
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
function isRemoteImageTarget(target) {
    const t = target.trim();
    // Already-remote images should not be processed.
    return (t.startsWith("http://") ||
        t.startsWith("https://") ||
        t.startsWith("data:") ||
        t.startsWith("file://"));
}
function stripWikiAlias(target) {
    // ![[path|alias]] -> path
    const pipeIdx = target.indexOf("|");
    return (pipeIdx >= 0 ? target.slice(0, pipeIdx) : target).trim();
}
function stripAngleBrackets(target) {
    // Markdown allows: ![]( <path with spaces> )
    let t = target.trim();
    if (t.startsWith("<") && t.endsWith(">"))
        t = t.slice(1, -1);
    return t.trim();
}
function decodeMarkdownLinkTarget(target) {
    // Common case: spaces encoded as %20
    try {
        return decodeURI(target);
    }
    catch {
        return target;
    }
}
function getVaultRoot(app) {
    const adapter = app.vault.adapter;
    const basePath = adapter?.basePath;
    if (!basePath)
        throw new Error("Cannot determine vault base path (desktop only).");
    return basePath;
}
function resolveTargetToFile(app, note, rawTarget) {
    // Handles both markdown and wiki link targets.
    let target = rawTarget.trim();
    target = stripAngleBrackets(target);
    target = decodeMarkdownLinkTarget(target);
    if (!target)
        return null;
    if (isRemoteImageTarget(target))
        return null;
    // Remove querystring/fragment if present: image.png?raw=1#fragment
    const noQuery = target.split("?")[0].split("#")[0];
    // 1) Try resolving as a link relative to the note.
    const dest = app.metadataCache.getFirstLinkpathDest(noQuery, note.path);
    if (dest && dest instanceof obsidian_1.TFile)
        return dest;
    // 2) Try as vault-absolute path.
    const absInVault = (0, obsidian_1.normalizePath)(noQuery);
    const af = app.vault.getAbstractFileByPath(absInVault);
    if (af && af instanceof obsidian_1.TFile)
        return af;
    return null;
}
function expandUserPath(input) {
    const trimmed = input.trim();
    if (!trimmed)
        return "";
    if (trimmed === "~")
        return (0, node_os_1.homedir)();
    if (trimmed.startsWith("~/"))
        return (0, node_path_1.join)((0, node_os_1.homedir)(), trimmed.slice(2));
    return trimmed;
}
async function canExecute(path) {
    try {
        await (0, promises_1.access)(path, promises_1.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function resolveUploadCommandPath(settings) {
    const candidates = [];
    const seen = new Set();
    const addCandidate = (value) => {
        const normalized = expandUserPath(value);
        if (!normalized || seen.has(normalized))
            return;
        seen.add(normalized);
        candidates.push(normalized);
    };
    addCandidate(settings.uploadCommand);
    for (const path of DEFAULT_PLOYS3_LOCATIONS) {
        addCandidate(path);
    }
    for (const candidate of candidates) {
        if (await canExecute(candidate)) {
            return candidate;
        }
    }
    throw new Error(`PloyS3 executable not found. Tried: ${candidates.join(", ")}`);
}
function showInstallNotice() {
    const frag = new DocumentFragment();
    frag.appendText("PloyS3 is not installed. Please install it first: ");
    const link = frag.createEl("a", {
        text: "https://github.com/mylxsw/ploys3",
        href: "https://github.com/mylxsw/ploys3",
    });
    link.setCssProps({ color: "var(--text-accent)" });
    new obsidian_1.Notice(frag, 10000);
}
async function runUploadCommand(settings, vaultRoot, absoluteImagePath) {
    const commandPath = await resolveUploadCommandPath(settings);
    // Execute: <uploadCommand> <absoluteImagePath>
    // The command must print the final URL to stdout.
    const args = [...(settings.uploadArgs ?? []), absoluteImagePath];
    const { stdout, stderr } = await execFileAsync(commandPath, args, {
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
    if (!url)
        throw new Error("Upload command output had no usable URL.");
    return url;
}
class ImageUploaderPlugin extends obsidian_1.Plugin {
    onload() {
        void this.initialize();
    }
    onunload() {
        // nothing
    }
    async initialize() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.addRibbonIcon("upload", "Upload local images in current note", () => {
            void this.handleUploadClicked();
        });
        this.addCommand({
            id: "upload-images-in-active-note",
            name: "Upload local images in active note",
            callback: () => {
                void this.handleUploadClicked();
            },
        });
        this.addSettingTab(new ImageUploaderSettingTab(this.app, this));
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
    async handleUploadClicked() {
        const active = this.app.workspace.getActiveFile();
        if (!active) {
            new obsidian_1.Notice("No active file.");
            return;
        }
        if (active.extension.toLowerCase() !== "md") {
            new obsidian_1.Notice("Active file is not a markdown note.");
            return;
        }
        try {
            await resolveUploadCommandPath(this.settings);
        }
        catch {
            showInstallNotice();
            return;
        }
        try {
            await this.processNote(active);
        }
        catch (e) {
            console.error(e);
            new obsidian_1.Notice(`Image upload failed: ${e?.message ?? e}`);
        }
    }
    async processNote(note) {
        const vaultRoot = getVaultRoot(this.app);
        const original = await this.app.vault.read(note);
        // Collect targets from the note.
        const mdTargets = [];
        for (const m of original.matchAll(MD_IMAGE_RE)) {
            mdTargets.push(m[1]);
        }
        const wikiTargets = [];
        if (this.settings.processWikiEmbeds) {
            for (const m of original.matchAll(WIKI_EMBED_RE)) {
                wikiTargets.push(stripWikiAlias(m[1]));
            }
        }
        const allTargets = [...mdTargets, ...wikiTargets].filter((t) => !!t && !isRemoteImageTarget(t));
        if (allTargets.length === 0) {
            new obsidian_1.Notice("No local images found in current note.");
            return;
        }
        // Resolve to actual files and de-duplicate by path.
        const resolvedFiles = [];
        const seen = new Set();
        for (const t of allTargets) {
            const f = resolveTargetToFile(this.app, note, t);
            if (!f)
                continue;
            if (seen.has(f.path))
                continue;
            seen.add(f.path);
            resolvedFiles.push(f);
        }
        if (resolvedFiles.length === 0) {
            new obsidian_1.Notice("No resolvable local image files found.");
            return;
        }
        new obsidian_1.Notice(`Uploading ${resolvedFiles.length} image(s)...`);
        // Upload sequentially to keep it simple and avoid hammering image beds.
        const mapOldToNew = new Map();
        for (const imgFile of resolvedFiles) {
            const adapter = this.app.vault.adapter;
            const fullPath = adapter?.getFullPath?.(imgFile.path);
            const absPath = fullPath ?? `${vaultRoot}/${imgFile.path}`;
            const url = await runUploadCommand(this.settings, vaultRoot, absPath);
            mapOldToNew.set(imgFile.path, url);
        }
        let updated = original;
        // Replace markdown image targets.
        updated = updated.replace(MD_IMAGE_RE, (whole, target1) => {
            const rawTarget = String(target1);
            if (isRemoteImageTarget(rawTarget))
                return whole;
            const cleaned = stripAngleBrackets(decodeMarkdownLinkTarget(rawTarget));
            const cleanedNoQuery = cleaned.split("?")[0].split("#")[0];
            const f = this.app.metadataCache.getFirstLinkpathDest(cleanedNoQuery, note.path);
            if (!f || !(f instanceof obsidian_1.TFile))
                return whole;
            const newUrl = mapOldToNew.get(f.path);
            if (!newUrl)
                return whole;
            return whole.replace(rawTarget, newUrl);
        });
        // Replace wiki embed targets.
        if (this.settings.processWikiEmbeds) {
            updated = updated.replace(WIKI_EMBED_RE, (whole, inner) => {
                const innerStr = String(inner);
                const target = stripWikiAlias(innerStr);
                if (isRemoteImageTarget(target))
                    return whole;
                const f = this.app.metadataCache.getFirstLinkpathDest(target, note.path);
                if (!f || !(f instanceof obsidian_1.TFile))
                    return whole;
                const newUrl = mapOldToNew.get(f.path);
                if (!newUrl)
                    return whole;
                // Convert wiki embed to standard markdown image link.
                const pipeIdx = innerStr.indexOf("|");
                const alt = pipeIdx >= 0 ? innerStr.slice(pipeIdx + 1).trim() : target;
                return `![${alt}](${newUrl})`;
            });
        }
        if (updated === original) {
            new obsidian_1.Notice("No changes made (nothing replaced).");
            return;
        }
        await this.app.vault.modify(note, updated);
        new obsidian_1.Notice("Image links replaced and note updated.");
    }
}
exports.default = ImageUploaderPlugin;
class ImageUploaderSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        new obsidian_1.Setting(containerEl).setName("PloyS3 uploader").setHeading();
        new obsidian_1.Setting(containerEl)
            .setName("Upload command path")
            .setDesc("CLI executable to run. It will be called as: <command> <uploadArgs...> <absolute_image_path>. The command must print the uploaded image URL to stdout.")
            .addText((text) => text
            .setPlaceholder("~/.local/bin/ploys3")
            .setValue(this.plugin.settings.uploadCommand)
            .onChange(async (value) => {
            this.plugin.settings.uploadCommand = value;
            await this.plugin.saveSettings();
        }));
        new obsidian_1.Setting(containerEl)
            .setName("Upload arguments")
            .setDesc("Arguments inserted before the image path. Default for PloyS3 is: upload.")
            .addText((text) => text
            .setPlaceholder("upload")
            .setValue((this.plugin.settings.uploadArgs ?? []).join(" "))
            .onChange(async (value) => {
            this.plugin.settings.uploadArgs = value
                .split(/\s+/)
                .map((v) => v.trim())
                .filter((v) => v.length > 0);
            await this.plugin.saveSettings();
        }));
        new obsidian_1.Setting(containerEl)
            .setName("Command working directory")
            .setDesc("Optional. If empty, the vault root is used.")
            .addText((text) => text
            .setPlaceholder("/path/to/vault")
            .setValue(this.plugin.settings.commandCwd)
            .onChange(async (value) => {
            this.plugin.settings.commandCwd = value;
            await this.plugin.saveSettings();
        }));
        new obsidian_1.Setting(containerEl)
            .setName("Process wiki embeds")
            .setDesc("If disabled, only standard Markdown image links ![]() are processed.")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.processWikiEmbeds).onChange(async (value) => {
            this.plugin.settings.processWikiEmbeds = value;
            await this.plugin.saveSettings();
        }));
    }
}

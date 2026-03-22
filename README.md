# Obsidian Image Uploader Button

An Obsidian desktop plugin that adds an **Upload** button. When clicked, it:

1. Scans the **currently active markdown note** for images.
2. Finds images that are **local files** (including clipboard-pasted images, since those are saved as local attachments).
3. Skips images that already point to **network/remote URLs** (e.g. `https://...`).
4. Uploads each local image by running a user-configured **CLI command**.
5. Rewrites the note by replacing the image targets with the returned URLs, then overwrites the original note.

## What the upload command must do

A minimal example script is included: `uploader-example.sh` (for local testing only).

The plugin executes:

- `<uploadCommand> <uploadArgs...> <absolute_image_path>`

Default config (PloyS3):

- `uploadCommand`: `/Applications/PloyS3.app/Resources/bin/ploys3`
- `uploadArgs`: `upload`

So it becomes:

- `/Applications/PloyS3.app/Resources/bin/ploys3 upload /absolute/path/to/image.png`

It expects the command to print the **final image URL** to **stdout** (first non-empty line).

Examples of acceptable stdout:

- `https://img.example.com/abc.png`
- `https://cdn.example.com/abc.png\n`

If stdout is empty, the plugin treats it as a failure.

## Supported image syntaxes

- Standard markdown: `![alt](relative/or/linked/path.png)`
- Wiki embeds (configurable): `![[path.png]]` and `![[path.png|alias]]`

## Skipped (not processed)

- `http://...`
- `https://...`
- `data:...`
- `file://...`

## Install (dev)

1. Copy this folder into your vault:

   `.obsidian/plugins/image-uploader-button/`

2. From the plugin folder:

   - `npm install`
   - `npm run build`

3. Enable the plugin in Obsidian Settings.

## Configure

Obsidian → Settings → Community plugins → **Image Uploader Button**:

- **Upload command**: path/name of your uploader executable
- **Command working directory** (optional)
- **Process wiki embeds** toggle

## Notes / limitations

- Desktop only (uses Node.js `child_process`).
- Upload is sequential to avoid spamming your image bed.
- Link replacement is based on Obsidian's resolver (`metadataCache.getFirstLinkpathDest`).


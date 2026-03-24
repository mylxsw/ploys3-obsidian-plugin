# PloyS3 Uploader

`PloyS3 Uploader` is an Obsidian desktop plugin for the PloyS3 App.

It is designed for image upload workflows that target S3-compatible storage servers. The plugin scans the currently active note, finds local image references such as pasted attachments, uploads those images through the PloyS3 App upload flow, and then rewrites the note so the original local image links become remote image URLs.

When locating the PloyS3 executable, the plugin first checks a user-specified path if one is provided. If that path does not exist, it falls back to these default locations: `~/.local/bin/ploys3` and `/Applications/PloyS3.app/Resources/bin/ploys3`.

## What It Does

- Scans the active Markdown note for image references.
- Detects local image files, including pasted or attached images stored in the vault.
- Skips image links that already point to remote resources.
- Uploads local images to an S3 server through the PloyS3 App.
- Rewrites image links in the note after upload so the content references the returned remote URLs.

## Supported Image References

- Standard Markdown image links such as `![alt](image.png)`
- Wiki-style image embeds such as `![[image.png]]`

## Use Case

This plugin is intended for users who manage notes in Obsidian and want a smoother way to move locally referenced images to S3-backed storage using PloyS3 App, especially for publishing, syncing, or sharing notes with externally accessible image URLs.

## Notes

- Desktop only.
- Focused on image upload scenarios for S3-compatible object storage.

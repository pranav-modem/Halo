# Contributing to Halo

Thanks for helping. Small, focused pull requests are the easiest to review and merge.

## Set up

```bash
git clone https://github.com/pranav-modem/Halo.git
cd Halo
npm install
HALO_DEBUG=1 npm start
```

You need Claude Code installed and signed in. `gh` and `acli` are only needed for the GitHub and Jira parts.

## Making a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Branch from `main` as `<type>/<short-name>`, where type is `feat`, `fix`, `docs`, `chore` or `refactor`.
3. Keep it to one change per pull request.
4. Run `npm run check`, then try your change in the running app.
5. Open a pull request that says what changed and why. Add a screenshot for anything visual.

If you touch windows, screen capture or audio, say which platforms you tested on (macOS, Windows).

## Code style

- Plain ES modules and the DOM; no UI framework. Pages build elements with the small `h()` helper in `src/renderer/ui/common.js`.
- Keep comments short, and about why, not what.
- Add a dependency only after talking it through in an issue.
- Pages reach the main process only through `src/preload/preload.cjs`. A new IPC prefix has to be added to `ALLOWED` there, or the page fails when it loads.
- Colours come from the CSS variables, so day and night both work. Avoid pure black and pure white.

## Safety rules

These keep Halo trustworthy. Pull requests that weaken them won't be merged.

- Anything that sends, posts or changes something goes through the approval hook and waits for the user's **Allow**.
- Background checks only read.
- Never edit `~/.claude/settings.json` without a backup, a diff the user has seen, and their confirmation. `src/main/cc-settings.js` does this.
- Audio and screenshots stay on the device unless the user chooses otherwise.

## Reporting bugs

Use the bug report template, and include:
- your OS
- the Halo version
- the output of `claude --version`
- what you expected and what happened

Logs from `HALO_DEBUG=1 npm start` help a lot.

## License

The project doesn't have a license yet. Until it does, the code is all rights reserved.

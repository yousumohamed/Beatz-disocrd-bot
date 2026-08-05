# Beatz

A Discord music bot built with `discord.js` and `@discordjs/voice`.

## Features

- `/setup music` command to initialize music controls in a server.
- Button + modal flow to play a YouTube URL or search query.
- Pause, resume, and stop controls.
- Uses `yt-dlp` and WebM Opus streaming for playback.
- Uses `ffmpeg-static` path setup from Node.

## Requirements

- Node.js 18+ recommended
- A Discord bot token and application client ID

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file in the project root:

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_client_id
```

3. Make sure `yt-dlp` is available:
- On Windows, this project uses `yt-dlp.exe` in the root folder.
- On Linux, `index.js` attempts to auto-download `yt-dlp` on first run.

## Run

```bash
npm start
```

## Deploy on Render

Create a **Web Service** (not a Background Worker), set the environment
variables `DISCORD_TOKEN` and `CLIENT_ID`, then use:

- Build command: `npm ci`
- Start command: `npm start`

Render assigns `PORT` automatically. The bot listens on that port and exposes
`GET /health`, for example:

```text
https://your-service-name.onrender.com/health
```

The response includes `uptimeSeconds` and a readable `uptime` value. Configure
your external cron/ping service to request that URL. Note that Render free web
services can still spin down; use a paid always-on instance if you need a
reliable 24/7 Discord voice bot.

## Scripts

- `npm start` - Starts the bot using `node index.js`.

## Notes

- The bot needs voice permissions (`Connect`, `Speak`) in your server channels.
- Keep your `.env` file private. It is ignored by `.gitignore`.

require('dotenv').config();

// The greatest fix for "Could not establish a secure UDP voice connection" on Windows:
// Force Node.js to use IPv4 instead of IPv6. Discord's UDP servers commonly drop IPv6 hole-punches.
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const path = require('path');
const http = require('node:http');
// Use ffmpeg-static which works on both Windows AND Linux automatically
process.env.FFMPEG_PATH = require('ffmpeg-static');

// Render requires a web service to listen on its assigned port. This endpoint
// can also be called by an external cron job to monitor the process.
const startedAt = Date.now();
const port = Number(process.env.PORT) || 3000;

const healthServer = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && requestUrl.pathname === '/health') {
        const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({
            status: 'ok',
            uptimeSeconds,
            uptime: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,
            timestamp: new Date().toISOString(),
        }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found. Use GET /health.' }));
});

healthServer.listen(port, '0.0.0.0', () => {
    console.log(`[Health] Listening on port ${port} at /health`);
});

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    Events,
    ActivityType
} = require('discord.js');

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    getVoiceConnection,
    entersState,
    VoiceConnectionStatus,
    StreamType
} = require('@discordjs/voice');

const play = require('play-dl');
const sodium = require('libsodium-wrappers');
const { execSync, spawn } = require('child_process');
const fs = require('fs');

// yt-dlp binary path — use .exe on Windows, download Linux binary automatically on Linux/cloud hosting
const ytDlpBin = process.platform === 'win32'
    ? path.join(__dirname, 'yt-dlp.exe')
    : path.join(__dirname, 'yt-dlp');

// Auto-download yt-dlp Linux binary on first run (self-contained, no Python needed)
if (process.platform !== 'win32' && !fs.existsSync(ytDlpBin)) {
    try {
        console.log('[Setup] Downloading yt-dlp Linux binary...');
        execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${ytDlpBin}" && chmod +x "${ytDlpBin}"`, { stdio: 'inherit' });
        console.log('[Setup] yt-dlp downloaded successfully.');
    } catch (e) {
        console.error('[Setup] Failed to download yt-dlp:', e.message);
    }
}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Catch all unhandled promise rejections to completely prevent crashes
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

// CRITICAL: Catch SIGINT so the process never exits due to Wispbyte's throttle/monitor.
// Whatever sends SIGINT (console throttle, CPU monitor, etc.) — we survive it.
// SIGTERM is still respected for clean shutdown when user clicks Stop.
process.on('SIGINT', () => { /* intentionally stay alive */ });
process.on('SIGTERM', () => process.exit(0));

// Heartbeat: write a single dot every 90 seconds.
// Pterodactyl Wings kills processes silent for >3 minutes (output silence timeout).
// One dot per 90s keeps us under that threshold. .unref() allows clean exit.
const _hb = setInterval(() => process.stdout.write('.\n'), 25_000);
_hb.unref();

// Suppress Node.js deprecation warnings — each prints 2 lines (contributes to spam count)
process.removeAllListeners('warning');
process.on('warning', () => {});

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Store active audio players by guild ID
const sessions = new Map();

// Function configureConnection was destructively sabotaging UDP sockets by clearing the interval; removed to restore native keep-alive.

// Helper: Get or create an audio player
function getOrCreatePlayer(guildId, connection, channel) {
    if (sessions.has(guildId)) {
        const s = sessions.get(guildId);
        // Update connection and channel in case they changed
        s.connection = connection;
        s.channel = channel;
        s.connection.subscribe(s.player);
        return s.player;
    }

    const player = createAudioPlayer();
    sessions.set(guildId, { player, connection, channel });
    connection.subscribe(player);

    // Auto-unpause silently — logging here causes console spam → Wispbyte Exit 130
    player.on(AudioPlayerStatus.AutoPaused, () => {
        setTimeout(() => player.unpause(), 500);
    });

    player.on(AudioPlayerStatus.Idle, async () => {
        const session = sessions.get(guildId);
        if (!session) return;

        // Stay in voice channel — send a new Play Music button so user can queue the next song
        const playRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('play_music_btn')
                .setLabel('Play Music')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🎵')
        );

        try {
            await session.channel.send({
                content: '✅ Song finished! Click below to play the next song.',
                components: [playRow],
            });
        } catch (e) { /* silent */ }
    });

    player.on('error', () => { /* silent */ });

    return player;
}

client.once(Events.ClientReady, async (readyClient) => {
    // Await WebAssembly initialization for encryption! Without this, Windows drops all Opus packets!
    await sodium.ready;


    readyClient.user.setPresence({
        activities: [{
            name: 'Beatz Music',
            type: ActivityType.Streaming,
            url: 'https://www.twitch.tv/beatz',
        }],
        status: 'online',
    });

    const commands = [
        new SlashCommandBuilder()
            .setName('setup')
            .setDescription('Setup the bot')
            .addSubcommand(subcommand =>
                subcommand
                    .setName('music')
                    .setDescription('Join the current voice channel and setup music controls')
            )
    ];

    const rest = new REST().setToken(TOKEN);

    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    } catch (error) { /* silent */ }
});

client.on(Events.InteractionCreate, async interaction => {
    try {
        // --- Slash Command ---
        if (interaction.isChatInputCommand() && interaction.commandName === 'setup' && interaction.options.getSubcommand() === 'music') {
            const voiceChannel = interaction.member.voice.channel;

            if (!voiceChannel) {
                return interaction.reply({ content: '❌ You must be in a voice channel to use this command.', ephemeral: true });
            }

            const me = interaction.guild.members.me;
            if (!voiceChannel.permissionsFor(me).has('Connect') || !voiceChannel.permissionsFor(me).has('Speak')) {
                return interaction.reply({ content: '❌ I lack permissions to Connect or Speak in that channel.', ephemeral: true });
            }

            // Immediately join voice
            let conn = getVoiceConnection(interaction.guildId);
            if (!conn) {
                conn = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: interaction.guildId,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                    selfDeaf: false,
                });
            }

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('play_music_btn')
                    .setLabel('Play Music')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🎵')
            );

            return interaction.reply({ content: '✅ Music system is ready! Click the button below to play music.', components: [row] });
        }

        // --- Buttons ---
        if (interaction.isButton()) {
            if (interaction.customId === 'play_music_btn') {
                const modal = new ModalBuilder()
                    .setCustomId('music_modal')
                    .setTitle('Play Music');

                const urlInput = new TextInputBuilder()
                    .setCustomId('youtube_url')
                    .setLabel('YouTube URL or Search Query')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('Paste a link or type a song name...')
                    .setRequired(true);

                const actionRow = new ActionRowBuilder().addComponents(urlInput);
                modal.addComponents(actionRow);

                // Show modal immediately to avoid InteractionTimeout
                return await interaction.showModal(modal);
            } 
            else if (['music_resume', 'music_pause', 'music_stop'].includes(interaction.customId)) {
                const voiceChannel = interaction.member.voice.channel;
                const botVoiceChannel = interaction.guild.members.me.voice.channel;

                if (!voiceChannel || !botVoiceChannel || voiceChannel.id !== botVoiceChannel.id) {
                    return interaction.reply({ content: '❌ You must be in the same voice channel as the bot to use controls.', ephemeral: true });
                }

                const session = sessions.get(interaction.guildId);
                const connection = getVoiceConnection(interaction.guildId);

                if (!session || !connection) {
                    return interaction.reply({ content: '❌ No music is currently playing or bot is not connected.', ephemeral: true });
                }

                const player = session.player;

                if (interaction.customId === 'music_pause') {
                    player.pause();
                    return interaction.reply({ content: '⏸ Music paused.', ephemeral: true });
                } 
                else if (interaction.customId === 'music_resume') {
                    player.unpause();
                    return interaction.reply({ content: '▶️ Music resumed.', ephemeral: true });
                } 
                else if (interaction.customId === 'music_stop') {
                    player.stop(true);
                    connection.destroy();
                    sessions.delete(interaction.guildId);
                    return interaction.reply({ content: '⏹ Music stopped and disconnected.' });
                }
            }
        }

        // --- Modal Submit ---
        if (interaction.isModalSubmit() && interaction.customId === 'music_modal') {
            const rawInput = interaction.fields.getTextInputValue('youtube_url').trim();
            const voiceChannel = interaction.member.voice.channel;
            const botVoiceChannel = interaction.guild.members.me.voice.channel;

            if (!voiceChannel) {
                return interaction.reply({ content: '❌ You must be in a voice channel.', ephemeral: true });
            }
            if (botVoiceChannel && voiceChannel.id !== botVoiceChannel.id) {
                return interaction.reply({ content: '❌ You must be in the same voice channel as the bot.', ephemeral: true });
            }

            // Immediately tell Discord we received the modal (stops the "thinking" spinner fast)
            await interaction.deferReply({ ephemeral: false });

            try {
                let conn = getVoiceConnection(interaction.guildId);
                if (!conn) {
                    conn = joinVoiceChannel({
                        channelId: voiceChannel.id,
                        guildId: interaction.guildId,
                        adapterCreator: interaction.guild.voiceAdapterCreator,
                        selfDeaf: false,
                    });
                }

                // --- Fast URL resolution ---
                // For direct YouTube URLs: skip play.validate() entirely (saves ~1-2s network round trip)
                // For search queries / playlists: use play-dl to resolve to a YouTube URL first
                let targetUrl = rawInput;
                const isDirectYtUrl = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch|youtu\.be\/)/.test(rawInput);

                if (!isDirectYtUrl) {
                    const validation = await play.validate(rawInput);
                    if (validation === 'search') {
                        const searchResults = await play.search(rawInput, { limit: 1 });
                        if (!searchResults || searchResults.length === 0) {
                            return interaction.editReply('❌ No results found for that search query.');
                        }
                        targetUrl = searchResults[0].url;
                    } else if (validation === 'yt_playlist') {
                        const playlist = await play.playlist_info(rawInput, { incomplete: true });
                        const videos = await playlist.all_videos();
                        if (!videos || videos.length === 0) {
                            return interaction.editReply('❌ That playlist is empty or unreadable.');
                        }
                        targetUrl = videos[0].url;
                    } else if (!validation || !validation.startsWith('yt')) {
                        return interaction.editReply('❌ Invalid YouTube link or search query provided.');
                    }
                }

                // Strip playlist/mix params — these cause yt-dlp to make extra API calls
                try {
                    const u = new URL(targetUrl);
                    ['list','start_radio','index','pp'].forEach(p => u.searchParams.delete(p));
                    targetUrl = u.toString();
                } catch (_) {}

                await interaction.editReply({ content: '⏳ Loading your song...' });

                // BEST PIPELINE: yt-dlp WebmOpus → Discord (no ffmpeg, 12x better buffering)
                //
                // YouTube web player serves format 251 = WebM Opus at ~16KB/s.
                // @discordjs/voice has a built-in WebM Opus demuxer (no ffmpeg needed).
                // At yt-dlp's throttled download speed of ~17KB/s vs Discord's 16KB/s read rate,
                // we have a +1KB/s surplus meaning the buffer NEVER drains → no AutoPaused loops.
                // Bypassing ffmpeg also eliminates its CPU overhead → no CPU-limit kills.
                //
                // SIGINT handler above ensures the bot survives even if Wispbyte sends SIGINT.
                // 
                // Why NOT "yt-dlp -g + ffmpeg -i <url>":
                //   Google CDN URLs are SESSION-BOUND to yt-dlp's HTTP session headers.
                //   When ffmpeg tries to use that URL directly, Google returns 403 Forbidden
                //   immediately → ffmpeg exits → zero audio → instant "Song finished".
                //
                // Why this pipe approach works:
                //   yt-dlp handles ALL authentication transparently in its own process.
                //   The audio bytes flow directly from yt-dlp → ffmpeg → Discord.
                //
                // --no-playlist: prevents &list= URLs from expanding into 50 tracks
                // --quiet: CRITICAL — prevents console spam that makes Wispbyte kill the server

                let ytDlpProc;

                try {
                    ytDlpProc = spawn(ytDlpBin, [
                        '-f', 'bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]/bestaudio',
                        '--no-playlist',
                        '--quiet',
                        '--no-progress',
                        '--no-warnings',
                        '-o', '-',
                        targetUrl
                    ]);

                    // Completely silent — no output whatsoever during playback
                    ytDlpProc.stderr.on('data', () => {});
                    ytDlpProc.on('error', () => {});
                    ytDlpProc.on('close', () => {});

                    // Feed WebM Opus directly to Discord's native demuxer — no ffmpeg needed!
                    const resource = createAudioResource(ytDlpProc.stdout, {
                        inputType: StreamType.WebmOpus,
                        inlineVolume: false,
                    });

                    const player = getOrCreatePlayer(interaction.guildId, conn, interaction.channel);
                    player.play(resource);



                    const controlsRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('music_resume').setLabel('▶️ Play / Resume').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId('music_pause').setLabel('⏸ Pause').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId('music_stop').setLabel('⏹ Stop').setStyle(ButtonStyle.Danger)
                    );

                    await interaction.editReply({
                        content: `🎶 Now playing: **${targetUrl}**`,
                        components: [controlsRow],
                    });

                } catch (error) {
                    try { if (ytDlpProc) ytDlpProc.kill(); } catch (_) {}
                    throw error;
                }

            } catch (error) {
                await interaction.editReply('❌ Could not load that YouTube URL. It may be age-restricted, private, or unavailable.');            }
        }
    } catch (err) {
        console.error('[Interaction General Error]', err);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: '❌ An unexpected error occurred.' });
            } else {
                await interaction.reply({ content: '❌ An unexpected error occurred.', ephemeral: true });
            }
        } catch (e) {
            // Failsafe
        }
    }
});

client.login(TOKEN);

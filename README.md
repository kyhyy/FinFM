# sharkord-music-bot

Simple music bot plugin for Sharkord that allows streaming music from youtube directly to voice channels.

## Installation

1. Download the latest release from the [Releases](https://github.com/diogomartino/sharkord-music-bot) page.
2. Move the `sharkord-music-bot` folder to your Sharkord plugins directory, typically located at `~/.config/sharkord/plugins`.
3. Download both the `ffmpeg` and `yt-dlp` binaries and place them inside the `sharkord/plugins/sharkord-music-bot/bin` folder.
4. Make both the `ffmpeg` and `yt-dlp` binaries have execution permissions (on UNIX systems, you can run `chmod +x ./ffmpeg` and `chmod +x ./yt-dlp` in the terminal).
5. Open Sharkord and enable the plugin.

`ffmpeg` can be downloaded from [FFmpeg's official website](https://ffmpeg.org/download.html).
`yt-dlp` can be downloaded from the [yt-dlp releases page](https://github.com/yt-dlp/yt-dlp/releases).

## Screenshots

![ss](https://i.imgur.com/mPsZSHA.png)

## Commands

- `/play <query>`: Plays a song in the voice channel you are currently in. The query can be a YouTube URL or a search term.
- `/stop`: Stops the music.
- `/volume <0-100>`: Sets the playback volume (default is 50).
- `/nowplaying`: Shows the currently playing song.

## Troubleshooting

### Sign in to confirm you’re not a bot

Well, turns out this is a bot. If you encounter this issue, you can try the following solutions:

1. Use a different IP address by connecting through a VPN or proxy.
2. Pass your cookies to yt-dlp to a file in `plugins/sharkord-music-bot/bin/cookies.txt`.

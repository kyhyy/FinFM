import {
  type AppData,
  type PlainTransport,
  type PluginContext,
  type Producer,
  type Transport,
} from "@sharkord/plugin-sdk";
import { spawnMusicStream, killMusicStream } from "./ffmpeg";
import { isYouTubeUrl } from "./yt-dlp";
import type { TMusicStreamResult } from "./ffmpeg";

let debug = false;

type ChannelStreamState = {
  ffmpegProcess: TMusicStreamResult["process"] | null;
  audioProducer: Producer | null;
  audioTransport: PlainTransport<AppData> | null;
  router: any;
  routerCloseHandler: ((...args: unknown[]) => void) | null;
  producerCloseHandler: ((...args: unknown[]) => void) | null;
  currentSong: string | null;
  streamActive: boolean;
  streamStarting: boolean;
  volume: number;
  queue: string[];
  loop: boolean;
};

const channelStreams = new Map<number, ChannelStreamState>();

const getState = (channelId: number): ChannelStreamState => {
  let state = channelStreams.get(channelId);

  if (!state) {
    state = {
      ffmpegProcess: null,
      audioProducer: null,
      audioTransport: null,
      router: null,
      routerCloseHandler: null,
      producerCloseHandler: null,
      currentSong: null,
      streamActive: false,
      streamStarting: false,
      volume: 50,
      queue: [],
      loop: false,
    };

    channelStreams.set(channelId, state);
  }

  return state;
};

const cleanupStream = (channelId: number) => {
  const state = channelStreams.get(channelId);
  if (!state) return;

  killMusicStream(state.ffmpegProcess);
  state.ffmpegProcess = null;

  if (state.producerCloseHandler && state.audioProducer) {
    state.audioProducer.observer.off("close", state.producerCloseHandler);
  }

  if (state.routerCloseHandler) {
    state.router?.off("@close", state.routerCloseHandler);
  }

  try { state.audioProducer?.close(); } catch {}
  try { state.audioTransport?.close(); } catch {}

  state.audioProducer = null;
  state.audioTransport = null;
  state.router = null;
  state.routerCloseHandler = null;
  state.producerCloseHandler = null;
  state.streamActive = false;
  state.currentSong = null;
  state.streamStarting = false;
};

const cleanupChannel = (channelId: number) => {
  const state = channelStreams.get(channelId);
  if (!state) return;

  cleanupStream(channelId);
  state.queue = [];
  state.loop = false;
};

const forceClean = () => {
  for (const channelId of channelStreams.keys()) {
    cleanupChannel(channelId);
  }

  try { Bun.spawnSync({ cmd: ["killall", "ffmpeg"] }); } catch {}

  channelStreams.clear();
};

const playSource = async (
  ctx: PluginContext,
  channelId: number,
  sourceUrl: string,
  bitrateSetting: string,
): Promise<string> => {
  const state = getState(channelId);

  if (state.streamStarting) {
    throw new Error("A song is already starting. Please wait.");
  }

  state.streamStarting = true;

  try {
    const router = ctx.actions.voice.getRouter(channelId);
    if (!router) throw new Error("Could not access voice channel");

    const { announcedAddress, ip } = await ctx.actions.voice.getListenInfo();

    state.router = router;

    state.routerCloseHandler = () => {
      ctx.log("Router closed, cleaning up channel", channelId);
      cleanupChannel(channelId);
    };

    state.router.on("@close", state.routerCloseHandler);

    const audioSsrc = Math.floor(Math.random() * 1e9);

    state.audioTransport = await router.createPlainTransport({
      listenIp: { ip, announcedIp: announcedAddress },
      rtcpMux: true,
      comedia: true,
      enableSrtp: false,
    });

    state.audioProducer = await state.audioTransport.produce({
      kind: "audio",
      rtpParameters: {
        codecs: [
          {
            mimeType: "audio/opus",
            payloadType: 111,
            clockRate: 48000,
            channels: 2,
            parameters: {},
            rtcpFeedback: [],
          },
        ],
        encodings: [{ ssrc: audioSsrc }],
      },
    });

    ctx.log("Final source URL:", sourceUrl);

    const result = await spawnMusicStream({
      sourceUrl,
      audioPayloadType: 111,
      audioSsrc,
      rtpHost: ip,
      audioRtpPort: state.audioTransport.tuple.localPort,
      volume: state.volume,
      bitrate: bitrateSetting,
      error: (...m) => ctx.error(...m),
      log: (...m) => ctx.log(...m),
      debug: (...m) => { if (debug) ctx.debug(...m); },
      onEnd: () => {
        ctx.log("Song ended in channel", channelId);
        advanceQueue(ctx, channelId, sourceUrl, bitrateSetting);
      },
    });

    ctx.actions.voice.createStream({
      key: "music",
      channelId,
      title: result.title,
      avatarUrl: "https://i.imgur.com/uVBNUK9.png",
      producers: { audio: state.audioProducer },
    });

    state.producerCloseHandler = () => cleanupStream(channelId);
    state.audioProducer.observer.on("close", state.producerCloseHandler);

    state.ffmpegProcess = result.process;
    state.currentSong = result.title;
    state.streamActive = true;

    return result.title;
  } catch (err) {
    cleanupStream(channelId);
    throw err;
  } finally {
    state.streamStarting = false;
  }
};

const advanceQueue = async (
  ctx: PluginContext,
  channelId: number,
  finishedUrl: string,
  bitrateSetting: string,
) => {
  const state = channelStreams.get(channelId);
  if (!state) return;

  cleanupStream(channelId);

  if (state.loop) {
    ctx.log("Loop enabled — replaying:", finishedUrl);
    try {
      await playSource(ctx, channelId, finishedUrl, bitrateSetting);
    } catch (err) {
      ctx.error("Loop replay failed:", err);
    }
    return;
  }

  const next = state.queue.shift();

  if (!next) {
    ctx.log("Queue empty — stopping playback in channel", channelId);
    return;
  }

  ctx.log("Advancing queue, next:", next);

  try {
    await playSource(ctx, channelId, next, bitrateSetting);
  } catch (err) {
    ctx.error("Failed to play next song in queue:", err);
  }
};

const onLoad = async (ctx: PluginContext) => {
  const settings = await ctx.settings.register([
    {
      key: "bitrate",
      name: "Bitrate",
      description: "The bitrate for the music stream",
      type: "string",
      defaultValue: "128k",
    },
  ]);

  const handlePlay = async (
    invoker: any,
    sourceUrl: string,
    label: string,
  ): Promise<string> => {
    const channelId = invoker.currentVoiceChannelId;
    if (!channelId) throw new Error("You must be in a voice channel to play music.");

    const state = getState(channelId);
    const bitrateSetting = await settings.get("bitrate");

    if (state.streamActive || state.streamStarting) {
      state.queue.push(sourceUrl);
      return `Added to queue (position ${state.queue.length}): ${label}`;
    }

    const title = await playSource(ctx, channelId, sourceUrl, bitrateSetting);
    return `Now playing: ${title}`;
  };

  ctx.commands.register<{ query: string }>({
    name: "play",
    description: "Play music from YouTube or a direct URL — queues if something is already playing",
    args: [
      {
        name: "query",
        description: "YouTube URL, search query, or direct audio URL",
        type: "string",
        required: true,
      },
    ],
    executes: async (invoker, input) => {
      if (!input.query) throw new Error("You must provide a search query or URL.");

      let sourceUrl = input.query;
      if (!/^https?:\/\//.test(sourceUrl)) {
        sourceUrl = `ytsearch:${sourceUrl}`;
      }

      return handlePlay(invoker, sourceUrl, input.query);
    },
  });

  ctx.commands.register<{ url: string }>({
    name: "play_direct",
    description: "Play music from a direct MP3 URL",
    args: [
      {
        name: "url",
        description: "Direct MP3 URL",
        type: "string",
        required: true,
      },
    ],
    executes: async (invoker, input) => {
      if (!input.url) throw new Error("You must provide a direct audio URL.");
      if (!/^https?:\/\//.test(input.url)) throw new Error("You must provide a direct http(s) URL.");
      if (isYouTubeUrl(input.url)) throw new Error("YouTube URLs are not supported by /play_direct.");

      return handlePlay(invoker, input.url, input.url);
    },
  });

  ctx.commands.register({
    name: "skip",
    description: "Skip the currently playing song",
    executes: async (invoker) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = channelStreams.get(channelId);
      if (!state || !state.streamActive) return "Nothing is currently playing";

      const skipped = state.currentSong ?? "current song";
      const bitrateSetting = await settings.get("bitrate");

      const wasLooping = state.loop;
      state.loop = false;

      cleanupStream(channelId);

      const next = state.queue.shift();

      if (!next) {
        state.loop = wasLooping;
        return `Skipped: ${skipped}. Queue is now empty.`;
      }

      try {
        await playSource(ctx, channelId, next, bitrateSetting);
        state.loop = wasLooping;
        return `Skipped: ${skipped}. Now playing: ${state.currentSong}`;
      } catch (err) {
        state.loop = wasLooping;
        throw err;
      }
    },
  });

  ctx.commands.register({
    name: "stop",
    description: "Stop playback and clear the queue",
    executes: async (invoker) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = channelStreams.get(channelId);
      if (!state || !state.streamActive) return "No music is currently playing";

      cleanupChannel(channelId);
    },
  });

  ctx.commands.register({
    name: "nowplaying",
    description: "Show what's currently playing",
    executes: async (invoker) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = channelStreams.get(channelId);
      if (!state || !state.streamActive || !state.currentSong) {
        return "Nothing is currently playing";
      }

      const loopIndicator = state.loop ? " 🔁" : "";
      const queueInfo = state.queue.length > 0
        ? ` | ${state.queue.length} song(s) in queue`
        : "";

      return `Now playing: ${state.currentSong}${loopIndicator}${queueInfo}`;
    },
  });

  ctx.commands.register({
    name: "queue",
    description: "Show the current queue",
    executes: async (invoker) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = channelStreams.get(channelId);

      if (!state || (!state.streamActive && state.queue.length === 0)) {
        return "The queue is empty";
      }

      const lines: string[] = [];

      if (state.currentSong) {
        const loopIndicator = state.loop ? " 🔁" : "";
        lines.push(`▶ Now playing: ${state.currentSong}${loopIndicator}`);
      }

      if (state.queue.length === 0) {
        lines.push("Queue is empty — nothing up next");
      } else {
        lines.push(`\nUp next (${state.queue.length}):`);
        state.queue.forEach((url, i) => {
          const label = url.startsWith("ytsearch:")
            ? url.slice("ytsearch:".length)
            : url;
          lines.push(`  ${i + 1}. ${label}`);
        });
      }

      return lines.join("\n");
    },
  });

  ctx.commands.register({
    name: "loop",
    description: "Toggle loop mode for the current song",
    executes: async (invoker) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = getState(channelId);
      state.loop = !state.loop;

      return state.loop
        ? "🔁 Loop enabled — current song will repeat"
        : "Loop disabled";
    },
  });

  ctx.commands.register<{ level: number }>({
    name: "volume",
    description: "Set the volume level (0-100)",
    args: [
      {
        name: "level",
        description: "Volume level from 0 to 100",
        type: "number",
        required: true,
      },
    ],
    executes: async (invoker, input) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) throw new Error("You are not in a voice channel");

      if (input.level < 0 || input.level > 100) {
        throw new Error("Volume must be between 0 and 100");
      }

      const state = getState(channelId);
      state.volume = input.level;

      return `Volume set to ${input.level}% (applies to next song)`;
    },
  });

  ctx.commands.register({
    name: "forceclean",
    description: "Cleanup all music streams (admin only)",
    executes: async () => {
      forceClean();
    },
  });

  ctx.commands.register({
    name: "musicbotdebug",
    description: "Toggle debug logging for Music Bot (admin only)",
    executes: async () => {
      debug = !debug;
      return `Music Bot debug logging is now ${debug ? "enabled" : "disabled"}`;
    },
  });

  ctx.events.on("voice:runtime_closed", ({ channelId }) => {
    cleanupChannel(channelId);
  });
};

const onUnload = (ctx: PluginContext) => {
  for (const channelId of channelStreams.keys()) {
    cleanupChannel(channelId);
  }

  channelStreams.clear();
  ctx.log("Music Bot Plugin unloaded");
};

export { onLoad, onUnload };
import type { PluginContext } from "@sharkord/plugin-sdk";
import { StreamKind } from "../../../repos/sharkord/packages/shared/src";
import { spawnMusicStream, killMusicStream } from "./ffmpeg";
import type { TMusicStreamResult } from "./ffmpeg";

let debug = false;

type ChannelStreamState = {
  ffmpegProcess: TMusicStreamResult["process"] | null;
  audioProducer: any;
  audioTransport: any;
  currentSong: string | null;
  streamActive: boolean;
  streamStarting: boolean;
  volume: number;
};

const channelStreams = new Map<number, ChannelStreamState>();

const getState = (channelId: number): ChannelStreamState => {
  let state = channelStreams.get(channelId);

  if (!state) {
    state = {
      ffmpegProcess: null,
      audioProducer: null,
      audioTransport: null,
      currentSong: null,
      streamActive: false,
      streamStarting: false,
      volume: 50,
    };

    channelStreams.set(channelId, state);
  }

  return state;
};

const cleanupChannel = (channelId: number) => {
  const state = channelStreams.get(channelId);
  if (!state) return;

  killMusicStream(state.ffmpegProcess);

  state.ffmpegProcess = null;

  state.audioProducer?.close();
  state.audioTransport?.close();

  state.audioProducer = null;
  state.audioTransport = null;
  state.streamActive = false;
  state.currentSong = null;
  state.streamStarting = false;
};

const forceClean = () => {
  for (const channelId of channelStreams.keys()) {
    cleanupChannel(channelId);
  }

  try {
    Bun.spawnSync({ cmd: ["killall", "ffmpeg"] });
  } catch {}

  channelStreams.clear();
};

const onLoad = (ctx: PluginContext) => {
  ctx.commands.register<{ query: string }>({
    name: "play",
    description: "Play music from YouTube or a direct URL",
    args: [
      {
        name: "query",
        description: "YouTube URL, search query, or direct audio URL",
        type: "string",
        required: true,
      },
    ],
    executes: async (invoker, input) => {
      const channelId = invoker.currentVoiceChannelId;

      if (!channelId) {
        throw new Error("You must be in a voice channel to play music.");
      }

      const state = getState(channelId);

      if (state.streamActive) {
        throw new Error(
          "Music is already playing in this channel. Use /stop first."
        );
      }

      if (state.streamStarting) {
        throw new Error("Music is already starting. Please wait.");
      }

      ctx.log(`Query: ${input.query} in channel ${channelId}`);

      state.streamStarting = true;

      try {
        const router = ctx.actions.voice.getRouter(channelId);

        if (!router) throw new Error("Could not access voice channel");

        const { announcedAddress, ip } =
          await ctx.actions.voice.getListenInfo();

        router.on("@close", () => {
          ctx.log("Router closed, cleaning up channel", channelId);
          cleanupChannel(channelId);
        });

        const audioSsrc = Math.floor(Math.random() * 1e9);

        state.audioTransport = await router.createPlainTransport({
          listenIp: {
            ip,
            announcedIp: announcedAddress,
          },
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

        let sourceUrl = input.query;
        if (!/^https?:\/\//.test(sourceUrl)) {
          sourceUrl = `ytsearch:${sourceUrl}`;
        }

        ctx.log("Final source URL:", sourceUrl);

        const result = await spawnMusicStream({
          sourceUrl,
          audioPayloadType: 111,
          audioSsrc,
          rtpHost: ip,
          audioRtpPort: state.audioTransport.tuple.localPort,
          volume: state.volume,
          error: (...m) => ctx.error(...m),
          log: (...m) => ctx.log(...m),
          debug: (...m) => {
            if (debug) {
              ctx.debug(...m);
            }
          },
          onEnd: () => {
            ctx.log("Music ended in channel", channelId);
            cleanupChannel(channelId);
          },
        });

        ctx.actions.voice.addExternalStream(
          channelId,
          `🎵 ${result.title}`,
          StreamKind.EXTERNAL_AUDIO,
          state.audioProducer
        );

        state.audioProducer.observer.on("close", () => {
          cleanupChannel(channelId);
        });

        state.ffmpegProcess = result.process;
        state.currentSong = result.title;
        state.streamActive = true;

        return `Now playing: ${result.title}`;
      } catch (err) {
        cleanupChannel(channelId);
        throw err;
      } finally {
        state.streamStarting = false;
      }
    },
  });

  ctx.commands.register({
    name: "stop",
    description: "Stop the currently playing music",
    executes: async (invoker) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = channelStreams.get(channelId);

      if (!state || !state.streamActive) {
        return "No music is currently playing";
      }

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

      return `Now playing: ${state.currentSong}`;
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

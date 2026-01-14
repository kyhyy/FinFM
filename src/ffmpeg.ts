import path from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { fetchYouTubeAudio, isYouTubeUrl } from "./yt-dlp";

const __dirname = dirname(fileURLToPath(import.meta.url));

type TMusicStreamResult = {
  process: ReturnType<typeof Bun.spawn>;
  title: string;
};

type TMusicOptions = {
  sourceUrl: string;
  audioPayloadType: number;
  audioSsrc: number;
  rtpHost: string;
  audioRtpPort: number;
  volume?: number; // 0-100, default 100
  log: (...messages: unknown[]) => void;
  error: (...messages: unknown[]) => void;
  debug: (...messages: unknown[]) => void;
  onEnd?: () => void;
};

const getBinaryPath = (): string => {
  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  return path.join(__dirname, "bin", binaryName);
};

const spawnMusicStream = async (
  options: TMusicOptions
): Promise<TMusicStreamResult> => {
  const ffmpegPath = getBinaryPath();

  options.log("Using FFmpeg binary at:", ffmpegPath);

  let inputSource = options.sourceUrl;
  let inputArgs: string[] = [];
  let title = options.sourceUrl;

  if (isYouTubeUrl(options.sourceUrl)) {
    const ytResult = await fetchYouTubeAudio(options.sourceUrl, {
      log: options.log,
      error: options.error,
      debug: options.debug,
    });

    inputSource = ytResult.url;
    title = ytResult.title;

    inputArgs = [
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
    ];
  }

  const volumeLevel = (options.volume ?? 100) / 100;

  options.log(`Using volume level: ${volumeLevel * 100}%`);

  const ffmpegArgs = [
    ...inputArgs,
    "-re",
    "-i",
    inputSource,

    // Audio processing
    "-vn", // No video
    "-af",
    `volume=${volumeLevel}`, // Volume filter
    "-c:a",
    "libopus",
    "-ar",
    "48000", // 48kHz sample rate
    "-ac",
    "2", // Stereo
    "-b:a",
    "192k", // 192kbps bitrate
    "-application",
    "audio", // Optimize for music

    // RTP output
    "-payload_type",
    options.audioPayloadType.toString(),
    "-ssrc",
    options.audioSsrc.toString(),
    "-f",
    "rtp",
    `rtp://${options.rtpHost}:${options.audioRtpPort}?pkt_size=1200`,
  ];

  options.log("Starting music stream with FFmpeg...");
  options.log("Command:", ffmpegPath, ...ffmpegArgs);

  const ffmpegProcess = Bun.spawn({
    cmd: [ffmpegPath, ...ffmpegArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  (async () => {
    const reader = ffmpegProcess.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        if (text.trim()) options.debug("[FFmpeg]", text.trim());
      }
    } catch (error) {
      options.error("[FFmpeg stdout error]", error);
    }
  })();

  (async () => {
    const reader = ffmpegProcess.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        if (text.trim()) options.debug("[FFmpeg]", text.trim());
      }
    } catch (error) {
      options.error("[FFmpeg stderr error]", error);
    }
  })();

  ffmpegProcess.exited.then((exitCode) => {
    options.debug("FFmpeg process exited with code:", exitCode);

    if (options.onEnd) {
      options.onEnd();
    }
  });

  return { process: ffmpegProcess, title };
};

const killMusicStream = (
  process: ReturnType<typeof Bun.spawn> | null
): void => {
  if (process) {
    process.kill();
  }
};

export { spawnMusicStream, killMusicStream };
export type { TMusicOptions, TMusicStreamResult };

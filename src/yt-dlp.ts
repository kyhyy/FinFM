import path from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));

type TYtDlpResult = {
  url: string;
  title: string;
};

type TYtDlpOptions = {
  log: (...messages: unknown[]) => void;
  debug: (...messages: unknown[]) => void;
  error: (...messages: unknown[]) => void;
};

const getYtDlpPath = (): string => {
  const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";

  return path.join(__dirname, "bin", binaryName);
};

const getCookiesPath = (): string => {
  return path.join(__dirname, "bin", "cookies.txt");
};

const isYouTubeUrl = (url: string): boolean => {
  return (
    url.includes("youtube.com") ||
    url.includes("youtu.be") ||
    url.startsWith("ytsearch:")
  );
};

const fetchYouTubeAudio = async (
  sourceUrl: string,
  options: TYtDlpOptions
): Promise<TYtDlpResult> => {
  const ytDlpPath = getYtDlpPath();
  const cookiesPath = getCookiesPath();

  options.log("Using yt-dlp binary at:", ytDlpPath);
  options.log("Fetching audio URL from YouTube:", sourceUrl);

  const command = [
    ytDlpPath,
    "--js-runtimes",
    "bun",
    "-f",
    "bestaudio",
    "-g",
    sourceUrl,
  ];

  if (await fs.exists(cookiesPath)) {
    command.splice(3, 0, "--cookies", cookiesPath);
  }

  options.log("Running command:", command.join(" "));

  try {
    const urlProcess = Bun.spawnSync({
      cmd: command,
    });

    if (urlProcess.exitCode !== 0) {
      throw new Error(`yt-dlp failed: ${urlProcess.stderr.toString()}`);
    }

    const url = urlProcess.stdout.toString().trim();

    const titleProcess = Bun.spawnSync({
      cmd: [ytDlpPath, "--js-runtimes", "bun", "--get-title", sourceUrl],
    });

    if (titleProcess.exitCode !== 0) {
      throw new Error(
        `yt-dlp title fetch failed: ${titleProcess.stderr.toString()}`
      );
    }

    const title = titleProcess.stdout.toString().trim();

    options.log("Audio URL fetched:", url);
    options.log("Title fetched:", title);

    return { url, title };
  } catch (error) {
    options.error("Failed to fetch YouTube URL:", error);
    throw error;
  }
};

export { fetchYouTubeAudio, isYouTubeUrl };
export type { TYtDlpResult, TYtDlpOptions };

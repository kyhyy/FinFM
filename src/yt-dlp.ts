import path from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { access } from "fs/promises";
import { constants as fsConstants } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

type TYtDlpResult = { url: string; title: string; originalHostname: string };

type TYtDlpOptions = {
  log: (...messages: unknown[]) => void;
  debug: (...messages: unknown[]) => void;
  error: (...messages: unknown[]) => void;
};

const getYtDlpPath = (): string => {
  const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  return path.join(__dirname, "bin", binaryName);
};

const getCookiesPath = (): string => path.join(__dirname, "bin", "cookies.txt");

const isYouTubeUrl = (url: string): boolean =>
  url.includes("youtube.com") ||
  url.includes("youtu.be") ||
  url.startsWith("ytsearch:");

const fileExists = async (p: string) => {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const runYtDlp = async (
  cmd: string[],
  options: TYtDlpOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (stderr.trim()) options.error("[yt-dlp]", stderr.trim());

  return { stdout, stderr, exitCode };
};

const resolveGoogleVideoUrl = async (url: string): Promise<{ resolvedUrl: string; originalHostname: string }> => {
  const originalHostname = new URL(url).hostname;
  try {
    const parsed = new URL(url);
    const proc = Bun.spawn({
      cmd: ["getent", "ahostsv4", originalHostname],
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    const ip = output.trim().split(/\s+/)[0];
    if (ip) {
      parsed.hostname = ip;
      return { resolvedUrl: parsed.toString(), originalHostname };
    }
  } catch {}
  return { resolvedUrl: url, originalHostname };
};

const fetchYouTubeAudio = async (
  sourceUrl: string,
  options: TYtDlpOptions,
): Promise<TYtDlpResult> => {
  const ytDlpPath = getYtDlpPath();
  const cookiesPath = getCookiesPath();

  options.log("Using yt-dlp binary at:", ytDlpPath);
  options.log("Fetching audio URL from YouTube:", sourceUrl);

  const ffmpegPath = path.join(__dirname, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const base = [ytDlpPath, "--js-runtimes", "bun", "--ffmpeg-location", ffmpegPath];
  const cookiesArgs = (await fileExists(cookiesPath))
    ? ["--cookies", cookiesPath]
    : [];

  const urlCmd = [...base, ...cookiesArgs, "-f", "bestaudio", "-g", sourceUrl];
  options.log("Running command:", urlCmd.join(" "));

  const urlRes = await runYtDlp(urlCmd, options);

  if (urlRes.exitCode !== 0) {
    throw new Error(`yt-dlp failed (exit ${urlRes.exitCode})`);
  }

  const url = urlRes.stdout.trim().split(/\r?\n/).filter(Boolean)[0];

  if (!url) throw new Error("yt-dlp returned empty URL");

  const { resolvedUrl, originalHostname } = await resolveGoogleVideoUrl(url);

  const titleCmd = [...base, ...cookiesArgs, "--get-title", sourceUrl];

  options.log("Running command:", titleCmd.join(" "));

  const titleRes = await runYtDlp(titleCmd, options);

  if (titleRes.exitCode !== 0) {
    throw new Error(`yt-dlp title fetch failed (exit ${titleRes.exitCode})`);
  }

  const title =
    titleRes.stdout.trim().split(/\r?\n/).filter(Boolean)[0] ?? sourceUrl;

  options.log("Audio URL fetched:", resolvedUrl);
  options.log("Title fetched:", title);

  return { url: resolvedUrl, title, originalHostname };
};

export { fetchYouTubeAudio, isYouTubeUrl };
export type { TYtDlpResult, TYtDlpOptions };
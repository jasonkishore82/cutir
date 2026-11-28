import { iso3 } from "./captions/cues";

/** A subtitle track to store in the MP4 as text, written to the ffmpeg file system as `file`. */
export type MuxSubtitle = { file: string; lang: string; name: string };

/**
 * The ffmpeg arguments that join the video segments (a concat list), the audio mix and subtitle files into one MP4
 * (the compatibility encoder, phase 25 and 23). Subtitles are stored as mov_text, the MP4 text track players list
 * as a switchable subtitle, each tagged with its language and name.
 */
export function muxArgs(o: { list: string; audio?: string; subtitles?: MuxSubtitle[]; out: string }): string[] {
  const subs = o.subtitles ?? [];
  const args = ["-y", "-f", "concat", "-safe", "0", "-i", o.list];
  if (o.audio) args.push("-i", o.audio);
  for (const s of subs) args.push("-i", s.file);
  const audioIndex = o.audio ? 1 : -1;
  args.push("-map", "0:v:0");
  if (o.audio) args.push("-map", `${audioIndex}:a:0`);
  subs.forEach((_, i) => args.push("-map", `${(o.audio ? 2 : 1) + i}:0`));
  args.push("-c:v", "copy");
  if (o.audio) args.push("-c:a", "aac", "-b:a", "192k");
  if (subs.length) args.push("-c:s", "mov_text");
  subs.forEach((s, i) => args.push(`-metadata:s:s:${i}`, `language=${iso3(s.lang)}`, `-metadata:s:s:${i}`, `title=${s.name}`));
  if (o.audio) args.push("-shortest");
  args.push("-movflags", "+faststart", o.out);
  return args;
}

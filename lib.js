"use strict";

function parseTimestamp(value) {
  const input = value.trim();
  if (input === "--:--") return null;
  const parts = input.split(":");
  if (parts.length < 2 || parts.length > 3) return Number.NaN;
  const numbers = parts.map(Number);
  if (numbers.some((number) => !Number.isFinite(number) || number < 0)) return Number.NaN;
  const seconds = parts.length === 2
    ? numbers[0] * 60 + numbers[1]
    : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  return seconds;
}

function formatTimestamp(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = (safe % 60).toFixed(2).padStart(5, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
    : `${String(minutes).padStart(2, "0")}:${remainder}`;
}

function cleanMediaTarget(value) {
  let result = value.trim();
  if (result.startsWith("[[") && result.endsWith("]]")) result = result.slice(2, -2);
  const aliasIndex = result.indexOf("|");
  if (aliasIndex !== -1) result = result.slice(0, aliasIndex);
  const fragmentIndex = result.indexOf("#");
  if (fragmentIndex !== -1) result = result.slice(0, fragmentIndex);
  return result.trim();
}

function parseMediaBlock(source) {
  const result = { media: "", title: "", cues: [], sections: [], errors: [] };
  const lines = source.split(/\r?\n/);
  lines.forEach((line, lineIndex) => {
    if (!line.trim()) return;
    const section = line.match(/^\s*#+\s+(.+?)\s*$/);
    if (section) {
      result.sections.push({ text: section[1], lineIndex });
      return;
    }
    if (line.trim().startsWith("#")) return;
    const property = line.match(/^\s*(media|title)\s*:\s*(.+?)\s*$/i);
    if (property) {
      const key = property[1].toLowerCase();
      result[key] = key === "media" ? cleanMediaTarget(property[2]) : property[2].trim();
      return;
    }
    const cue = line.match(/^\s*(--:--|(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,3})?)\s*[|\uff5c]\s*(.+?)\s*$/);
    if (cue) {
      const time = parseTimestamp(cue[1]);
      if (Number.isNaN(time)) result.errors.push(`Line ${lineIndex + 1}: invalid timestamp`);
      result.cues.push({ rawTime: cue[1], time, text: cue[2], lineIndex });
      return;
    }
    result.errors.push(`Line ${lineIndex + 1}: unrecognized content`);
  });
  if (!result.cues.length) result.errors.push("No lyric cues found");
  return result;
}

function replaceCueTimestamp(source, lineIndex, seconds) {
  const lines = source.split(/\r?\n/);
  if (lineIndex < 0 || lineIndex >= lines.length) throw new Error("Cue line is out of range");
  const updated = lines[lineIndex].replace(
    /^(\s*)(--:--|(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,3})?)(\s*[|\uff5c])/,
    `$1${formatTimestamp(seconds)}$3`,
  );
  if (updated === lines[lineIndex]) throw new Error("Could not replace cue timestamp");
  lines[lineIndex] = updated;
  return lines.join("\n");
}

function findActiveCueIndex(cues, currentTime) {
  let activeIndex = -1;
  let activeTime = -Infinity;
  for (let index = 0; index < cues.length; index += 1) {
    const cueTime = cues[index].time;
    if (cueTime != null && cueTime <= currentTime && cueTime > activeTime) {
      activeIndex = index;
      activeTime = cueTime;
    }
  }
  return activeIndex;
}

function findRepeatEndTime(cues, startTime, duration = Infinity) {
  let endTime = Number.isFinite(duration) && duration > startTime ? duration : Infinity;
  for (const cue of cues) {
    if (cue.time != null && cue.time > startTime && cue.time < endTime) endTime = cue.time;
  }
  return endTime;
}

module.exports = {
  cleanMediaTarget,
  findActiveCueIndex,
  findRepeatEndTime,
  formatTimestamp,
  parseMediaBlock,
  parseTimestamp,
  replaceCueTimestamp,
};

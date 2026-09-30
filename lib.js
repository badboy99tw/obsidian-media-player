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
    const cue = line.match(/^\s*(--:--|(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,3})?)\s*[|\uff5c]\s*(.*?)\s*$/);
    if (cue) {
      const time = parseTimestamp(cue[1]);
      if (Number.isNaN(time)) result.errors.push(`Line ${lineIndex + 1}: invalid timestamp`);
      result.cues.push({ rawTime: cue[1], time, text: cue[2], lineIndex });
      return;
    }
    result.errors.push(`Line ${lineIndex + 1}: unrecognized content`);
  });
  return result;
}

function replaceCueTimestamp(source, lineIndex, seconds) {
  const lines = source.split(/\r?\n/);
  if (lineIndex < 0 || lineIndex >= lines.length) throw new Error("Cue line is out of range");
  const updated = lines[lineIndex].replace(
    /^(\s*)(--:--|(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,3})?)(\s*[|\uff5c])/,
    `$1${formatTimestamp(seconds)}$3`,
  );
  if (!/^\s*(--:--|(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,3})?)\s*[|\uff5c]/.test(lines[lineIndex])) throw new Error("Could not replace cue timestamp");
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

function editCueText(source, lineIndex, text) {
  if (/[\r\n]/.test(text)) throw new Error("每句限一行；請使用拆句新增下一行。");
  const lines = source.split(/\r?\n/);
  if (!parseMediaBlock(source).cues.some((cue) => cue.lineIndex === lineIndex)) throw new Error("找不到這句歌詞");
  lines[lineIndex] = lines[lineIndex].replace(/([|\uff5c]).*$/, (_, separator) => `${separator} ${text}`);
  return lines.join("\n");
}

function insertBlankCue(source, afterLine, seconds = null) {
  const lines = source.split(/\r?\n/);
  if (afterLine < -1 || afterLine >= lines.length) throw new Error("新增位置不存在");
  lines.splice(afterLine + 1, 0, `${seconds == null ? "--:--" : formatTimestamp(seconds)} |`);
  return lines.join("\n");
}

function splitCue(source, lineIndex, cursor) {
  const cue = parseMediaBlock(source).cues.find((entry) => entry.lineIndex === lineIndex);
  if (!cue || !Number.isInteger(cursor) || cursor < 0 || cursor > cue.text.length) throw new Error("拆句位置不存在");
  const updated = editCueText(source, lineIndex, cue.text.slice(0, cursor).trimEnd());
  const lines = updated.split("\n");
  lines.splice(lineIndex + 1, 0, `--:-- | ${cue.text.slice(cursor).trimStart()}`);
  return lines.join("\n");
}

function mergeCue(source, lineIndex) {
  const parsed = parseMediaBlock(source);
  const index = parsed.cues.findIndex((cue) => cue.lineIndex === lineIndex);
  const cue = parsed.cues[index], next = parsed.cues[index + 1];
  if (!cue || !next) throw new Error("沒有下一句可以合併");
  if (parsed.sections.some((section) => section.lineIndex > lineIndex && section.lineIndex < next.lineIndex)) throw new Error("不能跨分段標題合併");
  const updated = editCueText(source, lineIndex, [cue.text, next.text].filter(Boolean).join(" "));
  const lines = updated.split("\n");
  lines.splice(next.lineIndex, 1);
  return lines.join("\n");
}

function removeCueBoundary(source, lineIndex, preserveText = false) {
  const cue = parseMediaBlock(source).cues.find((entry) => entry.lineIndex === lineIndex);
  if (!cue) throw new Error("找不到這個時間點");
  const lines = source.split(/\r?\n/);
  if (cue.text) {
    if (!preserveText) throw new Error("這句已有歌詞，請先確認保留文字。");
    lines[lineIndex] = lines[lineIndex].replace(/^(\s*)(--:--|(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,3})?)/, "$1--:--");
  } else {
    lines.splice(lineIndex, 1);
  }
  return lines.join("\n");
}

function replaceMediaBlock(content, source, updatedSource) {
  let matches = 0;
  const updated = content.replace(/^([ \t]*)(`{3,})music-transcriber[^\S\r\n]*\r?\n([\s\S]*?)^\1\2[^\S\r\n]*(?=\r?$)/gm, (whole, indent, fence, body) => {
    if (body.replace(/\r\n/g, "\n").replace(/\n$/, "") !== source.replace(/\r\n/g, "\n").replace(/\n$/, "")) return whole;
    matches += 1;
    const newline = whole.includes("\r\n") ? "\r\n" : "\n";
    return `${indent}${fence}music-transcriber${newline}${updatedSource.replace(/\r\n/g, "\n").replace(/\n$/, "").replace(/\n/g, newline)}${newline}${indent}${fence}`;
  });
  if (matches !== 1) throw new Error(matches ? "有多個相同播放器區塊，請先讓區塊內容可區分。" : "筆記的播放器內容已變動；草稿保留，請先核對 Markdown。");
  return updated;
}

module.exports = {
  cleanMediaTarget,
  findActiveCueIndex,
  findRepeatEndTime,
  formatTimestamp,
  parseMediaBlock,
  parseTimestamp,
  replaceCueTimestamp,
  editCueText,
  insertBlankCue,
  removeCueBoundary,
  splitCue,
  mergeCue,
  replaceMediaBlock,
};

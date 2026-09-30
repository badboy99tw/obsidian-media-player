"use strict";

const assert = require("node:assert/strict");
const {
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
} = require("./lib");

assert.equal(parseTimestamp("01:23.50"), 83.5);
assert.equal(parseTimestamp("1:02:03"), 3723);
assert.equal(parseTimestamp("--:--"), null);
assert.equal(formatTimestamp(83.5), "01:23.50");
assert.equal(cleanMediaTarget("[[../../assets/audio/song.m4a|Song]]"), "../../assets/audio/song.m4a");

const source = [
  "media: [[../../assets/audio/song.m4a|Song]]",
  "title: Test song",
  "# Verse",
  "--:-- | First line",
  "00:10.25 | Second line",
].join("\n");
const parsed = parseMediaBlock(source);
assert.equal(parsed.errors.length, 0);
assert.equal(parsed.media, "../../assets/audio/song.m4a");
assert.equal(parsed.cues.length, 2);
assert.deepEqual(parsed.sections, [{ text: "Verse", lineIndex: 2 }]);
assert.equal(parsed.cues[0].time, null);
assert.equal(parsed.cues[1].time, 10.25);
assert.match(replaceCueTimestamp(source, 3, 4.2), /00:04\.20 \| First line/);

let batched = replaceCueTimestamp(source, 3, 4.2);
batched = replaceCueTimestamp(batched, 4, 12.3);
assert.match(batched, /00:04\.20 \| First line/);
assert.match(batched, /00:12\.30 \| Second line/);

const unsortedCues = [
  { time: 7.94 },
  { time: 33.67 },
  { time: 28.68 },
  { time: 84.74 },
];
assert.equal(findActiveCueIndex(unsortedCues, 30), 2);
assert.equal(findActiveCueIndex(unsortedCues, 33.67), 1);
assert.equal(findRepeatEndTime(unsortedCues, 28.68, 211), 33.67);
assert.equal(findRepeatEndTime(unsortedCues, 33.67, 211), 84.74);
assert.equal(findRepeatEndTime(unsortedCues, 84.74, 211), 211);

const frontmatterMediaSource = [
  "title: Frontmatter media",
  "--:-- | First line",
].join("\n");
const frontmatterMedia = parseMediaBlock(frontmatterMediaSource);
assert.equal(frontmatterMedia.errors.length, 0);
assert.equal(frontmatterMedia.media, "");

const sectionsOnlyAroundCue = parseMediaBlock([
  "# Intro",
  "--:-- | Line",
  "## Outro",
].join("\n"));
assert.deepEqual(sectionsOnlyAroundCue.sections, [
  { text: "Intro", lineIndex: 0 },
  { text: "Outro", lineIndex: 2 },
]);
assert.equal(sectionsOnlyAroundCue.errors.length, 0);

const blank = parseMediaBlock("title: No lyrics\n# 口白\n00:07.50 |\n--:-- |   ");
assert.equal(blank.errors.length, 0);
assert.deepEqual(blank.cues.map(({ text, time }) => ({ text, time })), [{ text: "", time: 7.5 }, { text: "", time: null }]);
assert.equal(parseMediaBlock("title: No lyrics").errors.length, 0);
assert.equal(replaceCueTimestamp("00:07.50 |", 0, 7.5), "00:07.50 |");
const withText = editCueText("00:07.50 |", 0, "公：$1 | 唱詞");
assert.equal(parseMediaBlock(withText).cues[0].text, "公：$1 | 唱詞");
assert.throws(() => editCueText(withText, 0, "line\n```"));
assert.equal(editCueText(withText, 0, ""), "00:07.50 | ");
const newSection = insertBlankCue("title: No lyrics\n# 唱", 1, 12.34);
assert.equal(parseMediaBlock(newSection).cues[0].time, 12.34);
const divided = splitCue("# 唱\n00:07.50 | 桃花 過渡\n00:17.77 | 下一句", 1, 3);
assert.deepEqual(parseMediaBlock(divided).cues.map(({ text, time }) => ({ text, time })), [
  { text: "桃花", time: 7.5 }, { text: "過渡", time: null }, { text: "下一句", time: 17.77 },
]);
assert.equal(mergeCue(divided, 1), "# 唱\n00:07.50 | 桃花 過渡\n00:17.77 | 下一句");
assert.throws(() => mergeCue("00:00.00 | A\n# 唱\n00:10.00 | B", 0));
const document = "Before\n```music-transcriber\n00:07.50 |\n```\nAfter\n";
assert.equal(replaceMediaBlock(document, "00:07.50 |\n", withText), `Before\n\`\`\`music-transcriber\n${withText}\n\`\`\`\nAfter\n`);
assert.throws(() => replaceMediaBlock(document, "00:08.00 |", withText));
assert.throws(() => replaceMediaBlock(document + document, "00:07.50 |", withText));
const crlfDocument = document.replace(/\n/g, "\r\n");
assert.equal(replaceMediaBlock(crlfDocument, "00:07.50 |", withText), replaceMediaBlock(document, "00:07.50 |", withText).replace(/\n/g, "\r\n"));

// Validate the actual deployed runtime helpers, not just the separate test library.
const fs = require("node:fs");
const vm = require("node:vm");
const runtime = {};
vm.runInNewContext(fs.readFileSync("main.js", "utf8").split("function createToggleButton")[0].replace(/^const \{ MarkdownRenderChild.*$/m, ""), runtime);
assert.equal(runtime.editCueText("00:07.50 |", 0, "公：$1 | 唱詞"), withText);
assert.equal(runtime.splitCue("# 唱\n00:07.50 | 桃花 過渡\n00:17.77 | 下一句", 1, 3), divided);
assert.equal(runtime.replaceMediaBlock(document, "00:07.50 |", withText), replaceMediaBlock(document, "00:07.50 |", withText));
assert.equal(runtime.parseMediaBlock("title: No lyrics\n00:07.50 |").errors.length, 0);
assert.equal(removeCueBoundary("title: Test\n00:01.00 |\n00:05.00 | B", 1), "title: Test\n00:05.00 | B");
assert.throws(() => removeCueBoundary("00:01.00 | 歌詞", 0));
assert.equal(removeCueBoundary("00:01.00 | 歌詞", 0, true), "--:-- | 歌詞");
assert.equal(runtime.removeCueBoundary("00:01.00 | 歌詞", 0, true), "--:-- | 歌詞");
const legacyDocument = document.replace("music-transcriber", "media-player");
assert.throws(() => replaceMediaBlock(legacyDocument, "00:07.50 |", withText), "old syntax must not be writable");
assert.throws(() => runtime.replaceMediaBlock(legacyDocument, "00:07.50 |", withText), "runtime must not accept old syntax");
console.log("local-music-transcriber tests passed");

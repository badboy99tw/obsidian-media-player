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

console.log("local-media-player tests passed");

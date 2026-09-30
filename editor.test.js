"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Exercise real renderer handlers with a small Obsidian/DOM harness.
class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.textContent = options.text || "";
    this.children = [];
    this.events = new Map();
    this.classes = new Set((options.cls || "").split(" ").filter(Boolean));
    this.dataset = {};
    this.disabled = options.attr?.disabled === "true";
    this.value = "";
    this.currentTime = 0;
    this.duration = 60;
    this.readyState = 0;
    this.paused = true;
    this.classList = { remove: (name) => this.classes.delete(name) };
  }
  createEl(tag, options = {}) { const child = new Element(tag, options); this.children.push(child); return child; }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
  empty() { this.children = []; }
  addClass(name) { this.classes.add(name); }
  removeClass(name) { this.classes.delete(name); }
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }
  setAttribute() {}
  removeAttribute() {}
  setText(value) { this.textContent = value; }
  focus() { this.focused = true; }
  addEventListener(name, handler) { const handlers = this.events.get(name) || []; handlers.push(handler); this.events.set(name, handlers); }
  removeEventListener(name, handler) { this.events.set(name, (this.events.get(name) || []).filter((entry) => entry !== handler)); }
  async emit(name) { for (const handler of this.events.get(name) || []) await handler(); }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
  load() {}
  all() { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelectorAll(selector) { const tags = selector.split(",").map((tag) => tag.trim()); return this.all().filter((child) => tags.includes(child.tag)); }
  querySelector(selector) { return this.all().find((child) => child.classes.has(selector.slice(1))); }
}
class File {}
class RenderChild { constructor(container) { this.containerEl = container; } }
const notices = [];
const moduleObject = { exports: {} };
const sandbox = {
  require: (name) => {
    assert.equal(name, "obsidian");
    return { MarkdownRenderChild: RenderChild, Plugin: class {}, TFile: File, Notice: class { constructor(message) { notices.push(message); } } };
  },
  module: moduleObject,
  Date,
};
vm.runInNewContext(fs.readFileSync("main.js", "utf8"), sandbox);

async function setup(source, newline = "\n") {
  const plugin = new moduleObject.exports();
  const note = new File(), mediaFile = new File();
  mediaFile.extension = "mp3";
  mediaFile.basename = "Test";
  const container = new Element();
  const frontmatter = { media_source: "mock.mp3", media_speed: 1 };
  let content = `Intro\n\`\`\`music-transcriber\n${source}\n\`\`\`\nOutro`.replace(/\n/g, newline);
  plugin.app = {
    fileManager: {
      processFrontMatter: async (_note, change) => { change(frontmatter); },
    },
    vault: {
      getAbstractFileByPath: () => note,
      getResourcePath: () => "mock.mp3",
      process: async (_note, change) => { content = change(content); },
    },
    metadataCache: {
      getFileCache: () => ({ frontmatter }),
      getFirstLinkpathDest: () => mediaFile,
    },
  };
  let registrations = 0;
  plugin.registerMarkdownCodeBlockProcessor = (type, handler) => {
    assert.equal(type, "music-transcriber", "only the new syntax may be registered");
    registrations += 1;
    plugin.processor = handler;
  };
  plugin.onload();
  assert.equal(registrations, 1, "no legacy syntax alias may be registered");
  let child;
  plugin.processor(source, container, { sourcePath: "song.md", addChild: (renderChild) => { child = renderChild; child.onload(); } });
  const byText = (text) => container.all().find((element) => element.tag === "button" && (element.textContent === text || element.all().some((descendant) => descendant.textContent === text)));
  const rerender = () => {
    const newContainer = new Element();
    let newChild;
    plugin.processor(source, newContainer, { sourcePath: "song.md", addChild: (renderChild) => { newChild = renderChild; newChild.onload(); } });
    return { child: newChild, container: newContainer };
  };
  return { plugin, child, container, byText, frontmatter, rerender, getContent: () => content, setContent: (value) => { content = value; } };
}

(async () => {
  const test = await setup("title: Test\n# 唱\n00:05.00 | 第一段\n00:10.00 |", "\r\n");
  test.child.media.currentTime = 20;
  await test.byText("編輯歌詞").emit("click");
  await test.byText("第一段").emit("click");
  assert.equal(test.child.media.currentTime, 20, "editing a cue must not seek");
  assert.equal(test.child.media.paused, true, "editing must not start playback");
  let inputs = test.container.all().filter((element) => element.tag === "input");
  assert.equal(inputs[0].focused, true);
  inputs[0].value = "桃花 過渡 $1";
  await inputs[0].emit("input");
  assert.match(test.child.draftSource, /00:05.00 \| 桃花 過渡 \$1/);
  assert.match(test.getContent(), /第一段/, "typing must remain a draft until saved");
  const speed = test.container.all().find((element) => element.tag === "select");
  speed.value = "0.75";
  await speed.emit("change");
  assert.equal(test.child.media.playbackRate, 0.75);
  assert.equal(test.frontmatter.media_speed, 0.75);
  assert.match(test.getContent(), /第一段/, "changing speed must not save or discard lyric drafts");
  const restored = test.rerender();
  assert.equal(restored.child.editingMode, true);
  assert.equal(restored.child.draftSource, test.child.draftSource);
  assert.equal(restored.child.media.playbackRate, 0.75);
  await restored.child.media.emit("loadedmetadata");
  assert.equal(restored.child.media.currentTime, 20);
  speed.value = "1";
  await speed.emit("change");
  assert.equal(test.frontmatter.media_speed, 1, "returning to the original speed must persist too");
  await test.byText("播放這段").emit("click");
  assert.equal(test.child.media.currentTime, 5);
  assert.equal(test.child.repeatEnd, 10);
  assert.equal(test.child.media.paused, false);
  assert.equal(test.child.timingButton.disabled, true);
  inputs[0].selectionStart = 3;
  test.child.media.currentTime = 6.25;
  await test.byText("在目前時間切段").emit("click");
  assert.match(test.child.draftSource, /00:05.00 \| 桃花 過渡 \$1\n00:06.25 \|\n00:10.00 \|/);
  assert.equal(test.child.media.currentTime, 6.25);
  assert.equal(test.child.media.paused, false);
  const removeButtons = test.container.all().filter((element) => element.textContent === "移除此時間點");
  await removeButtons[1].emit("click");
  assert.doesNotMatch(test.child.draftSource, /00:06.25/);
  await test.byText("桃花 過渡 $1").emit("click");
  test.child.media.currentTime = 7.5;
  await test.byText("新增空白句（目前時間）").emit("click");
  assert.match(test.child.draftSource, /00:05.00 \| 桃花 過渡 \$1\n00:07.50 \|\n00:10.00 \|/);
  assert.equal(test.child.media.currentTime, 7.5, "adding a boundary must not seek");
  await test.byText("儲存歌詞").emit("click");
  assert.match(test.getContent(), /00:07.50 \|\r\n00:10.00 \|/);
  assert.equal(test.plugin.lyricDrafts.size, 0);
  assert.equal(test.byText("儲存歌詞").disabled, true);
  await test.byText("編輯歌詞").emit("click");
  test.child.media.currentTime = 30;
  await test.byText("（待填詞）").emit("click");
  assert.equal(test.child.media.currentTime, 7.5, "normal playback still seeks blank cues");

  const removal = await setup("title: Test\n00:01.00 | 保留這句\n00:05.00 | 下一句");
  await removal.byText("編輯歌詞").emit("click");
  const original = removal.child.draftSource;
  await removal.byText("移除此時間點").emit("click");
  assert.equal(removal.child.draftSource, original, "text must not be removed without confirmation");
  const confirmation = removal.byText("保留文字並移除時間");
  assert.equal(confirmation.focused, true);
  await removal.byText("取消").emit("click");
  assert.equal(removal.child.draftSource, original);
  await removal.byText("移除此時間點").emit("click");
  await removal.byText("保留文字並移除時間").emit("click");
  assert.equal(removal.child.draftSource, "title: Test\n--:-- | 保留這句\n00:05.00 | 下一句");
  await removal.byText("儲存歌詞").emit("click");
  assert.match(removal.getContent(), /--:-- \| 保留這句/);

  const conflict = await setup("title: Test\n00:01.00 | A");
  await conflict.byText("編輯歌詞").emit("click");
  const input = conflict.container.all().find((element) => element.tag === "input");
  input.value = "B";
  await input.emit("input");
  const otherEdit = conflict.getContent().replace("| A", "| externally changed");
  conflict.setContent(otherEdit);
  await conflict.byText("儲存歌詞").emit("click");
  assert.equal(conflict.getContent(), otherEdit, "saving must not overwrite external edits");
  assert.match(conflict.child.draftSource, /\| B/);
  assert.equal(conflict.byText("儲存歌詞").disabled, false, "failed save must remain retryable");
  assert.equal(conflict.plugin.lyricDrafts.size, 1);

  const empty = await setup("title: Empty");
  await empty.byText("編輯歌詞").emit("click");
  const cleanSpeed = empty.container.all().find((element) => element.tag === "select");
  cleanSpeed.value = "0.5";
  await cleanSpeed.emit("change");
  const cleanRestored = empty.rerender();
  assert.equal(cleanRestored.child.editingMode, true, "speed changes must preserve editing mode even without draft text");
  empty.child.media.currentTime = 0;
  await empty.byText("新增空白句（目前時間）").emit("click");
  assert.equal(empty.child.draftSource, "title: Empty\n00:00.00 |");
  await empty.byText("儲存歌詞").emit("click");
  assert.match(empty.getContent(), /00:00.00 \|/);
  console.log("editor interaction tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });

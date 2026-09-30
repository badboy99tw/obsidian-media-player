"use strict";

const { MarkdownRenderChild, Notice, Plugin, TFile } = require("obsidian");

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

function createToggleButton(parent, label, ariaLabel) {
  const button = parent.createEl("button", {
    cls: "music-transcriber-toggle",
    attr: { type: "button", "aria-label": ariaLabel, "aria-pressed": "false" },
  });
  const labelElement = button.createSpan({ cls: "music-transcriber-toggle-label", text: label });
  const track = button.createSpan({ cls: "music-transcriber-toggle-track" });
  track.setAttribute("aria-hidden", "true");
  track.createSpan({ cls: "music-transcriber-toggle-thumb" });
  return { button, labelElement };
}

function setToggleButtonState(button, enabled) {
  button.toggleClass("is-on", enabled);
  button.setAttribute("aria-pressed", String(enabled));
}

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mkv"]);
const SPEEDS = [0.25, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.25, 1.5, 2];
const VIDEO_SIZES = [
  { value: "small", label: "小（50%）" },
  { value: "medium", label: "中（75%）" },
  { value: "large", label: "大（100%）" },
];
const VIDEO_SIZE_VALUES = new Set(VIDEO_SIZES.map(({ value }) => value));

class MusicTranscriberChild extends MarkdownRenderChild {
  constructor(plugin, container, source, sourcePath) {
    super(container);
    this.plugin = plugin;
    this.app = plugin.app;
    this.container = container;
    this.source = source;
    this.draftSource = source;
    this.draftKey = `${sourcePath}\n${source}`;
    this.editingMode = false;
    this.selectedLine = null;
    this.cueCleanup = [];
    this.sourcePath = sourcePath;
    this.media = null;
    this.cleanup = [];
    this.timingMode = false;
    this.pendingTimestamps = new Map();
    this.timingButton = null;
    this.timingLabel = null;
    this.timingSaveButton = null;
    this.playbackKey = null;
    this.repeatMode = false;
    this.repeatStart = null;
    this.repeatEnd = null;
    this.repeatRow = null;
    this.loopStartButton = null;
    this.loopEndButton = null;
    this.repeatButton = null;
    this.isSeeking = false;
  }

  onload() {
    this.render();
  }

  onunload() {
    for (const callback of this.cueCleanup) callback();
    for (const callback of this.cleanup) callback();
    if (this.media) {
      this.media.pause();
      this.media.removeAttribute("src");
      this.media.load();
    }
  }

  listen(target, event, handler) {
    target.addEventListener(event, handler);
    this.cleanup.push(() => target.removeEventListener(event, handler));
  }

  render() {
    const cachedDraft = this.plugin.lyricDrafts.get(this.draftKey);
    if (cachedDraft) {
      this.draftSource = cachedDraft;
      this.editingMode = true;
    }
    let parsed = parseMediaBlock(this.draftSource);
    this.container.empty();
    this.container.addClass("music-transcriber");

    if (parsed.errors.length) {
      const errors = this.container.createDiv({ cls: "music-transcriber-errors" });
      for (const error of parsed.errors) errors.createDiv({ text: error });
      if (!parsed.cues.length) return;
    }

    const note = this.app.vault.getAbstractFileByPath(this.sourcePath);
    const frontmatter = note instanceof TFile ? this.app.metadataCache.getFileCache(note)?.frontmatter : null;
    const mediaTarget = parsed.media || cleanMediaTarget(String(frontmatter?.media_source || ""));
    if (!mediaTarget) {
      this.container.createDiv({ cls: "music-transcriber-errors", text: "\u7f3a\u5c11 media \u8a2d\u5b9a或 media_source property" });
      return;
    }

    const file = this.app.metadataCache.getFirstLinkpathDest(mediaTarget, this.sourcePath);
    if (!(file instanceof TFile)) {
      this.container.createDiv({ cls: "music-transcriber-errors", text: `找不到媒體：${mediaTarget}` });
      return;
    }

    const title = this.container.createEl("h3", { text: parsed.title || file.basename });
    title.addClass("music-transcriber-title");

    const resourcePath = this.app.vault.getResourcePath(file);
    const isVideo = VIDEO_EXTENSIONS.has(file.extension.toLowerCase());
    const configuredVideoSize = String(frontmatter?.media_size || "");
    const videoSize = VIDEO_SIZE_VALUES.has(configuredVideoSize) ? configuredVideoSize : "large";
    const configuredSpeed = Number(frontmatter?.media_speed);
    const playbackSpeed = SPEEDS.includes(configuredSpeed) ? configuredSpeed : 1;
    this.playbackKey = `${this.sourcePath}\n${mediaTarget}`;
    this.media = this.container.createEl(isVideo ? "video" : "audio", {
      cls: isVideo ? "music-transcriber-video" : "music-transcriber-audio",
    });
    this.media.controls = true;
    this.media.preload = "metadata";
    this.media.src = resourcePath;
    this.media.playsInline = true;
    this.media.preservesPitch = true;
    this.media.webkitPreservesPitch = true;
    this.media.playbackRate = playbackSpeed;
    if (isVideo) this.media.dataset.size = videoSize;

    const toolbar = this.container.createDiv({ cls: "music-transcriber-toolbar" });
    const rewind = toolbar.createEl("button", { text: "\u22125 \u79d2", attr: { type: "button" } });
    const toggle = toolbar.createEl("button", { text: "\u64ad\u653e", attr: { type: "button" } });
    const forward = toolbar.createEl("button", { text: "+5 \u79d2", attr: { type: "button" } });
    const time = toolbar.createEl("span", { cls: "music-transcriber-time", text: "00:00 / --:--" });
    const speedLabel = toolbar.createEl("label", { cls: "music-transcriber-speed" });
    speedLabel.createSpan({ text: "\u901f\u5ea6 " });
    const speed = speedLabel.createEl("select", { attr: { "aria-label": "\u64ad\u653e\u901f\u5ea6" } });
    for (const value of SPEEDS) {
      const option = speed.createEl("option", { text: `${value}\u00d7` });
      option.value = String(value);
    }
    speed.value = String(playbackSpeed);
    if (isVideo) {
      const sizeLabel = toolbar.createEl("label", { cls: "music-transcriber-size" });
      sizeLabel.createSpan({ text: "影片大小 " });
      const size = sizeLabel.createEl("select", { attr: { "aria-label": "影片大小" } });
      for (const { value, label } of VIDEO_SIZES) {
        const option = size.createEl("option", { text: label });
        option.value = value;
      }
      size.value = videoSize;
      this.listen(size, "change", async () => {
        if (this.draftSource !== this.source) {
          size.value = this.media.dataset.size;
          new Notice("請先儲存歌詞或時間標記，再修改影片大小。");
          return;
        }
        const selectedSize = size.value;
        this.media.dataset.size = selectedSize;
        if (frontmatter?.media_size === selectedSize) return;
        this.rememberPlaybackState();
        await this.app.fileManager.processFrontMatter(note, (properties) => {
          properties.media_size = selectedSize;
        });
      });
    }
    const timingControls = toolbar.createDiv({
      cls: "music-transcriber-timing-controls",
      attr: { "aria-label": "時間標記控制" },
    });
    const timingToggle = createToggleButton(timingControls, "標記時間", "標記時間模式");
    const timing = timingToggle.button;
    this.timingButton = timing;
    this.timingLabel = timingToggle.labelElement;
    this.timingSaveButton = timingControls.createEl("button", {
      cls: "music-transcriber-timing-save",
      text: "儲存標記（0）",
      attr: { type: "button", disabled: "true" },
    });
    const editControls = toolbar.createDiv({ cls: "music-transcriber-edit-controls" });
    const editing = createToggleButton(editControls, "編輯歌詞", "編輯歌詞模式").button;
    const saveLyrics = editControls.createEl("button", {
      text: "儲存歌詞",
      attr: { type: "button", disabled: "true" },
    });
    const addCue = editControls.createEl("button", {
      text: "新增空白句（目前時間）",
      attr: { type: "button" },
    });
    const editHint = this.container.createDiv({ cls: "music-transcriber-edit-hint" });
    const updateEditControls = () => {
      const dirty = this.draftSource !== this.source;
      saveLyrics.disabled = !dirty;
      saveLyrics.toggleClass("is-dirty", dirty);
      addCue.hidden = !this.editingMode;
      editHint.hidden = !this.editingMode;
      editHint.setText(dirty
        ? "歌詞草稿尚未儲存。點句子編輯；用「播放這段」聽寫，再按「儲存歌詞」。"
        : "點句子編輯，不會跳轉。聽到新段落時按「新增空白句」，之後逐段填詞。");
      setToggleButtonState(editing, this.editingMode);
      this.container.toggleClass("is-editing", this.editingMode);
      timing.disabled = this.editingMode;
    };
    this.updateEditControls = updateEditControls;
    const loopControls = toolbar.createDiv({
      cls: "music-transcriber-loop-controls",
      attr: { "aria-label": "循環控制" },
    });
    this.loopStartButton = loopControls.createEl("button", {
      text: "設 A",
      attr: { type: "button", title: "將目前時間設為循環起點" },
    });
    this.loopEndButton = loopControls.createEl("button", {
      text: "設 B",
      attr: { type: "button", title: "將目前時間設為循環終點" },
    });
    this.repeatButton = createToggleButton(loopControls, "循環", "循環播放").button;
    const lyrics = this.container.createDiv({ cls: "music-transcriber-lines" });
    let cueButtons = [];
    const playCue = async (cue, row) => {
      if (cue.time == null) {
        new Notice("這句還沒有時間點；開啟「標記時間」後點它來標記。");
        return;
      }
      const repeatEnd = findRepeatEndTime(parsed.cues, cue.time, this.media.duration);
      this.setLoopRange(cue.time, repeatEnd, row);
      this.media.currentTime = cue.time;
      await this.media.play().catch(() => undefined);
    };
    const changeStructure = (change, focusLine) => {
      try {
        this.draftSource = change(this.draftSource);
        this.selectedLine = focusLine;
        this.rememberDraft();
        // Previous A/B may refer to a removed boundary. Explicit playback selects the new range.
        this.setRepeatMode(false);
        this.repeatStart = null;
        this.repeatEnd = null;
        this.repeatRow = null;
        this.loopStartButton.setText("設 A");
        this.loopEndButton.setText("設 B");
        drawLyrics();
        cueButtons.find(({ cue }) => cue.lineIndex === focusLine)?.input.focus();
      } catch (error) {
        new Notice(error.message);
      }
    };
    const drawLyrics = () => {
      for (const callback of this.cueCleanup) callback();
      this.cueCleanup = [];
      lyrics.empty();
      parsed = parseMediaBlock(this.draftSource);
      let sectionIndex = 0;
      const listenCue = (target, event, handler) => {
        target.addEventListener(event, handler);
        this.cueCleanup.push(() => target.removeEventListener(event, handler));
      };
      const renderSectionsBefore = (lineIndex) => {
      while (sectionIndex < parsed.sections.length && parsed.sections[sectionIndex].lineIndex < lineIndex) {
        lyrics.createDiv({ cls: "music-transcriber-section", text: parsed.sections[sectionIndex].text });
        sectionIndex += 1;
      }
    };
      cueButtons = parsed.cues.map((cue) => {
      renderSectionsBefore(cue.lineIndex);
      const row = lyrics.createDiv({
        cls: `music-transcriber-cue${cue.time == null ? " is-untimed" : ""}`,
      });
      const select = row.createEl("button", {
        cls: "music-transcriber-cue-select",
        attr: { type: "button" },
      });
      select.createSpan({ cls: "music-transcriber-cue-time", text: cue.time == null ? "\u5f85\u6a19\u8a18" : cue.rawTime });
      const text = select.createSpan({ cls: "music-transcriber-cue-text", text: cue.text || "（待填詞）" });
      const editor = row.createDiv({ cls: "music-transcriber-cue-editor" });
      const input = editor.createEl("input", {
        cls: "music-transcriber-lyric-input",
        attr: { type: "text", "aria-label": `歌詞 ${cue.rawTime}`, placeholder: "聽這段，填入歌詞或口白" },
      });
      input.value = cue.text;
      const actions = editor.createDiv({ cls: "music-transcriber-cue-actions" });
      const play = actions.createEl("button", { text: "播放這段", attr: { type: "button" } });
      const split = actions.createEl("button", { text: "在目前時間切段", attr: { type: "button", title: "在本句下方新增空白句，時間使用當下播放位置；原句文字不動" } });
      const remove = actions.createEl("button", { text: "移除此時間點", attr: { type: "button" } });
      const confirmation = editor.createDiv();
      confirmation.hidden = true;
      confirmation.createSpan({ text: "這句已有歌詞。要移除時間、保留文字為待標記句嗎？" });
      const keepText = confirmation.createEl("button", { text: "保留文字並移除時間", attr: { type: "button" } });
      const cancel = confirmation.createEl("button", { text: "取消", attr: { type: "button" } });
      play.disabled = cue.time == null;
      listenCue(input, "focus", () => { this.selectedLine = cue.lineIndex; });
      listenCue(input, "input", () => {
        this.draftSource = editCueText(this.draftSource, cue.lineIndex, input.value);
        cue.text = input.value;
        text.setText(cue.text || "（待填詞）");
        this.rememberDraft();
        updateEditControls();
      });
      listenCue(play, "click", () => playCue(cue, row));
      listenCue(split, "click", () => changeStructure((source) => insertBlankCue(source, cue.lineIndex, this.media.currentTime), cue.lineIndex + 1));
      listenCue(remove, "click", () => {
        if (cue.text) {
          confirmation.hidden = false;
          keepText.focus();
          return;
        }
        changeStructure((source) => removeCueBoundary(source, cue.lineIndex), cue.lineIndex - 1);
      });
      listenCue(keepText, "click", () => changeStructure((source) => removeCueBoundary(source, cue.lineIndex, true), cue.lineIndex));
      listenCue(cancel, "click", () => { confirmation.hidden = true; });
      listenCue(select, "click", async () => {
        if (this.editingMode) {
          this.selectedLine = cue.lineIndex;
          input.focus();
          return;
        }
        if (this.timingMode) {
          this.markCue(cue, row);
          return;
        }
        await playCue(cue, row);
      });
      return { cue, row, input };
    });
    renderSectionsBefore(Infinity);
      if (!parsed.cues.length) lyrics.createDiv({ text: "尚無段落。開啟「編輯歌詞」，播放時新增空白句，再逐段填詞。", cls: "music-transcriber-empty" });
      updateEditControls();
    };
    drawLyrics();
    this.listen(addCue, "click", () => {
      const afterLine = this.selectedLine ?? parsed.cues[parsed.cues.length - 1]?.lineIndex ?? this.draftSource.split(/\r?\n/).length - 1;
      changeStructure((source) => insertBlankCue(source, afterLine, this.media.currentTime), afterLine + 1);
    });
    this.listen(saveLyrics, "click", async () => { await this.saveDraft("歌詞與段落"); });
    this.listen(editing, "click", async () => {
      if (this.timingMode) {
        new Notice("請先儲存標記並關閉「標記時間」。");
        return;
      }
      if (this.editingMode && this.draftSource !== this.source && !(await this.saveDraft("歌詞與段落"))) return;
      this.editingMode = !this.editingMode;
      updateEditControls();
    });

    const updateTime = () => {
      const duration = Number.isFinite(this.media.duration) ? formatTimestamp(this.media.duration).replace(/\.\d+$/, "") : "--:--";
      const current = formatTimestamp(this.media.currentTime).replace(/\.\d+$/, "");
      time.setText(`${current} / ${duration}`);
      const active = findActiveCueIndex(parsed.cues, this.media.currentTime);
      cueButtons.forEach(({ row }, index) => row.toggleClass("is-active", index === active));
    };

    const updateTimeAndRepeat = () => {
      if (!this.isSeeking && this.repeatMode && this.repeatStart != null) {
        const repeatEnd = Number.isFinite(this.repeatEnd) ? this.repeatEnd : this.media.duration;
        if (Number.isFinite(repeatEnd) && repeatEnd > this.repeatStart && this.media.currentTime >= repeatEnd - 0.04) {
          this.media.currentTime = this.repeatStart;
        }
      }
      updateTime();
    };

    this.listen(rewind, "click", () => { this.media.currentTime = Math.max(0, this.media.currentTime - 5); });
    this.listen(forward, "click", () => { this.media.currentTime = Math.min(this.media.duration || Infinity, this.media.currentTime + 5); });
    this.listen(toggle, "click", async () => {
      if (this.media.paused) await this.media.play().catch(() => undefined);
      else this.media.pause();
    });
    this.listen(speed, "change", async () => {
      if (this.draftSource !== this.source && !this.editingMode) {
        speed.value = String(this.media.playbackRate);
        new Notice("請先儲存時間標記，再修改速度。");
        return;
      }
      const selectedSpeed = Number(speed.value);
      this.media.playbackRate = selectedSpeed;
      this.media.preservesPitch = true;
      this.media.webkitPreservesPitch = true;
      this.rememberDraft();
      this.rememberPlaybackState();
      try {
        await this.app.fileManager.processFrontMatter(note, (properties) => {
          properties.media_speed = selectedSpeed;
        });
      } catch (error) {
        new Notice(`速度已套用，但未儲存設定：${error.message}`);
      }
    });
    this.listen(this.loopStartButton, "click", () => {
      this.setRepeatMode(false);
      this.setLoopRange(this.media.currentTime, null, null);
    });
    this.listen(this.loopEndButton, "click", async () => {
      if (this.repeatStart == null) {
        new Notice("請先按「設 A」設定循環起點。");
        return;
      }
      if (this.media.currentTime <= this.repeatStart) {
        new Notice("循環終點必須晚於起點。");
        return;
      }
      this.setLoopRange(this.repeatStart, this.media.currentTime, null);
      this.setRepeatMode(true);
      this.media.currentTime = this.repeatStart;
      await this.media.play().catch(() => undefined);
    });
    this.listen(this.repeatButton, "click", () => {
      const enabling = !this.repeatMode;
      if (enabling && this.repeatStart != null && this.repeatEnd == null) {
        new Notice("請先按「設 B」設定循環終點。");
        return;
      }
      this.setRepeatMode(enabling);
      if (this.repeatMode && this.repeatStart == null) {
        new Notice("請點一行歌詞，或用「設 A」「設 B」選擇循環段落。");
      }
    });
    const finishTiming = async () => {
      if (!(await this.saveTiming())) return;
      this.timingMode = false;
      setToggleButtonState(timing, false);
      this.container.removeClass("is-timing");
      if (this.timingSaveButton) {
        this.timingSaveButton.setText("儲存標記（0）");
        this.timingSaveButton.disabled = true;
      }
    };
    this.listen(timing, "click", async () => {
      if (this.editingMode) return;
      if (!this.timingMode) {
        this.setRepeatMode(false);
        this.timingMode = true;
        setToggleButtonState(timing, true);
        this.container.addClass("is-timing");
        if (this.timingSaveButton) {
          this.timingSaveButton.setText("儲存標記（0）");
          this.timingSaveButton.disabled = true;
        }
        return;
      }
      await finishTiming();
    });
    this.listen(this.timingSaveButton, "click", finishTiming);
    this.listen(this.media, "play", () => toggle.setText("\u66ab\u505c"));
    this.listen(this.media, "pause", () => toggle.setText("\u64ad\u653e"));
    this.listen(this.media, "seeking", () => {
      this.isSeeking = true;
    });
    this.listen(this.media, "seeked", () => {
      this.isSeeking = false;
      let shouldSelectCurrentCue = !this.repeatMode
        && !(this.repeatStart != null && this.repeatEnd == null);
      if (this.repeatMode && this.repeatStart != null) {
        const repeatEnd = Number.isFinite(this.repeatEnd) ? this.repeatEnd : this.media.duration;
        const outsideStart = this.media.currentTime < this.repeatStart;
        const outsideEnd = Number.isFinite(repeatEnd) && this.media.currentTime >= repeatEnd;
        if (outsideStart || outsideEnd) {
          this.setRepeatMode(false);
          shouldSelectCurrentCue = true;
        }
      }
      if (shouldSelectCurrentCue) {
        const activeCueIndex = findActiveCueIndex(parsed.cues, this.media.currentTime);
        if (activeCueIndex >= 0) {
          const { cue, row } = cueButtons[activeCueIndex];
          const nextCueTime = findRepeatEndTime(parsed.cues, cue.time, this.media.duration);
          this.setLoopRange(cue.time, nextCueTime, row);
        }
      }
      updateTime();
    });
    this.listen(this.media, "timeupdate", updateTimeAndRepeat);
    this.listen(this.media, "ended", async () => {
      if (!this.repeatMode || this.repeatStart == null) return;
      this.media.currentTime = this.repeatStart;
      await this.media.play().catch(() => undefined);
    });
    this.listen(this.media, "loadedmetadata", updateTime);
    const pendingPlayback = this.plugin.consumePlaybackState(this.playbackKey);
    if (pendingPlayback) {
      this.editingMode = pendingPlayback.editingMode ?? this.editingMode;
      this.selectedLine = pendingPlayback.selectedLine ?? this.selectedLine;
      this.setLoopRange(pendingPlayback.repeatStart ?? null, pendingPlayback.repeatEnd ?? null,
        cueButtons.find(({ cue }) => cue.lineIndex === pendingPlayback.repeatLine)?.row ?? null);
      this.setRepeatMode(Boolean(pendingPlayback.repeatMode));
      updateEditControls();
      let restored = false;
      const restorePlayback = async () => {
        if (restored) return;
        restored = true;
        this.media.currentTime = Math.min(pendingPlayback.currentTime, this.media.duration || Infinity);
        this.media.volume = pendingPlayback.volume;
        this.media.muted = pendingPlayback.muted;
        if (!pendingPlayback.paused) await this.media.play().catch(() => undefined);
        updateTime();
      };
      this.listen(this.media, "loadedmetadata", restorePlayback);
      if (this.media.readyState >= 1) void restorePlayback();
    }
    updateTime();
  }

  setLoopRange(startTime, endTime, row) {
    if (this.repeatRow) this.repeatRow.classList.remove("is-repeat-target");
    this.repeatStart = startTime;
    this.repeatEnd = endTime;
    this.repeatRow = row;
    if (this.repeatMode && this.repeatRow) this.repeatRow.classList.add("is-repeat-target");
    if (this.loopStartButton) this.loopStartButton.setText(`A ${formatTimestamp(startTime)}`);
    if (this.loopEndButton) {
      const label = endTime == null
        ? "B --:--"
        : Number.isFinite(endTime) ? `B ${formatTimestamp(endTime)}` : "B 媒體結尾";
      this.loopEndButton.setText(label);
    }
  }

  setRepeatMode(enabled) {
    this.repeatMode = enabled;
    if (this.repeatButton) setToggleButtonState(this.repeatButton, enabled);
    if (this.repeatRow) this.repeatRow.toggleClass("is-repeat-target", enabled);
  }

  rememberPlaybackState() {
    if (!this.playbackKey || !this.media) return;
    this.plugin.rememberPlaybackState(this.playbackKey, {
      currentTime: this.media.currentTime,
      paused: this.media.paused,
      volume: this.media.volume,
      muted: this.media.muted,
      editingMode: this.editingMode,
      selectedLine: this.selectedLine,
      repeatStart: this.repeatStart,
      repeatEnd: this.repeatEnd,
      repeatMode: this.repeatMode,
      repeatLine: this.selectedLine,
    });
  }

  markCue(cue, row) {
    const seconds = this.media.currentTime;
    const timestamp = formatTimestamp(seconds);
    cue.time = seconds;
    cue.rawTime = timestamp;
    this.pendingTimestamps.set(cue.lineIndex, seconds);
    this.draftSource = replaceCueTimestamp(this.draftSource, cue.lineIndex, seconds);
    this.rememberDraft();
    this.updateEditControls();
    row.classList.remove("is-untimed");
    const time = row.querySelector(".music-transcriber-cue-time");
    if (time) time.textContent = timestamp;
    if (this.timingSaveButton) {
      this.timingSaveButton.setText(`儲存標記（${this.pendingTimestamps.size}）`);
      this.timingSaveButton.disabled = false;
    }
  }

  async saveTiming() {
    if (!this.pendingTimestamps.size) return true;
    return this.saveDraft("時間標記");
  }

  rememberDraft() {
    if (this.draftSource === this.source) this.plugin.lyricDrafts.delete(this.draftKey);
    else this.plugin.lyricDrafts.set(this.draftKey, this.draftSource);
  }

  async saveDraft(label) {
    if (this.isSaving) return false;
    if (this.draftSource === this.source) return true;
    const note = this.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(note instanceof TFile)) {
      new Notice("\u627e\u4e0d\u5230\u76ee\u524d\u7b46\u8a18\uff0c\u7121\u6cd5\u5beb\u5165\u6642\u9593\u9ede\u3002");
      return false;
    }
    const originalSource = this.source;
    const updatedSource = this.draftSource;
    this.isSaving = true;
    const disabledControls = [...this.container.querySelectorAll("input, button, select")].map((control) => [control, control.disabled]);
    for (const [control] of disabledControls) control.disabled = true;
    this.rememberPlaybackState();
    try {
      await this.app.vault.process(note, (content) => replaceMediaBlock(content, originalSource, updatedSource));
      this.plugin.lyricDrafts.delete(this.draftKey);
      this.source = updatedSource;
      this.draftKey = `${this.sourcePath}\n${this.source}`;
      this.pendingTimestamps.clear();
      this.updateEditControls();
      if (this.timingSaveButton) {
        this.timingSaveButton.setText("儲存標記（0）");
        this.timingSaveButton.disabled = true;
      }
      new Notice(`已儲存${label}`);
      return true;
    } catch (error) {
      new Notice(`未儲存：${error.message}`);
      return false;
    } finally {
      this.isSaving = false;
      for (const [control, disabled] of disabledControls) control.disabled = disabled;
      this.updateEditControls();
      if (!this.pendingTimestamps.size && this.timingSaveButton) {
        this.timingSaveButton.setText("儲存標記（0）");
        this.timingSaveButton.disabled = true;
      }
    }
  }
}

module.exports = class MusicTranscriberPlugin extends Plugin {
  onload() {
    this.pendingPlaybackStates = new Map();
    this.lyricDrafts = new Map();
    this.registerMarkdownCodeBlockProcessor("music-transcriber", (source, element, context) => {
      context.addChild(new MusicTranscriberChild(this, element, source, context.sourcePath));
    });
  }

  rememberPlaybackState(key, state) {
    this.pendingPlaybackStates.set(key, { ...state, savedAt: Date.now() });
  }

  consumePlaybackState(key) {
    const state = this.pendingPlaybackStates.get(key);
    this.pendingPlaybackStates.delete(key);
    if (!state || Date.now() - state.savedAt > 10000) return null;
    return state;
  }
};

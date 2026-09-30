"use strict";

const { MarkdownRenderChild, Notice, Plugin, TFile } = require("obsidian");

function parseTimestamp(value) {
  const input = value.trim();
  if (input === "--:--") return null;
  const parts = input.split(":");
  if (parts.length < 2 || parts.length > 3) return Number.NaN;
  const numbers = parts.map(Number);
  if (numbers.some((number) => !Number.isFinite(number) || number < 0)) return Number.NaN;
  return parts.length === 2
    ? numbers[0] * 60 + numbers[1]
    : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
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
  if (!result.cues.length) result.errors.push("No text cues found");
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

function createToggleButton(parent, label, ariaLabel) {
  const button = parent.createEl("button", {
    cls: "media-player-toggle",
    attr: { type: "button", "aria-label": ariaLabel, "aria-pressed": "false" },
  });
  const labelElement = button.createSpan({ cls: "media-player-toggle-label", text: label });
  const track = button.createSpan({ cls: "media-player-toggle-track" });
  track.setAttribute("aria-hidden", "true");
  track.createSpan({ cls: "media-player-toggle-thumb" });
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

class MediaPlayerChild extends MarkdownRenderChild {
  constructor(plugin, container, source, sourcePath) {
    super(container);
    this.plugin = plugin;
    this.app = plugin.app;
    this.container = container;
    this.source = source;
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
    const parsed = parseMediaBlock(this.source);
    this.container.empty();
    this.container.addClass("media-player");

    if (parsed.errors.length) {
      const errors = this.container.createDiv({ cls: "media-player-errors" });
      for (const error of parsed.errors) errors.createDiv({ text: error });
      if (!parsed.cues.length) return;
    }

    const note = this.app.vault.getAbstractFileByPath(this.sourcePath);
    const frontmatter = note instanceof TFile ? this.app.metadataCache.getFileCache(note)?.frontmatter : null;
    const mediaTarget = parsed.media || cleanMediaTarget(String(frontmatter?.media_source || ""));
    if (!mediaTarget) {
      this.container.createDiv({ cls: "media-player-errors", text: "\u7f3a\u5c11 media \u8a2d\u5b9a或 media_source property" });
      return;
    }

    const file = this.app.metadataCache.getFirstLinkpathDest(mediaTarget, this.sourcePath);
    if (!(file instanceof TFile)) {
      this.container.createDiv({ cls: "media-player-errors", text: `找不到媒體：${mediaTarget}` });
      return;
    }

    const title = this.container.createEl("h3", { text: parsed.title || file.basename });
    title.addClass("media-player-title");

    const resourcePath = this.app.vault.getResourcePath(file);
    const isVideo = VIDEO_EXTENSIONS.has(file.extension.toLowerCase());
    const configuredVideoSize = String(frontmatter?.media_size || "");
    const videoSize = VIDEO_SIZE_VALUES.has(configuredVideoSize) ? configuredVideoSize : "large";
    const configuredSpeed = Number(frontmatter?.media_speed);
    const playbackSpeed = SPEEDS.includes(configuredSpeed) ? configuredSpeed : 1;
    this.playbackKey = `${this.sourcePath}\n${mediaTarget}`;
    this.media = this.container.createEl(isVideo ? "video" : "audio", {
      cls: isVideo ? "media-player-video" : "media-player-audio",
    });
    this.media.controls = true;
    this.media.preload = "metadata";
    this.media.src = resourcePath;
    this.media.playsInline = true;
    this.media.preservesPitch = true;
    this.media.webkitPreservesPitch = true;
    this.media.playbackRate = playbackSpeed;
    if (isVideo) this.media.dataset.size = videoSize;

    const toolbar = this.container.createDiv({ cls: "media-player-toolbar" });
    const rewind = toolbar.createEl("button", { text: "\u22125 \u79d2", attr: { type: "button" } });
    const toggle = toolbar.createEl("button", { text: "\u64ad\u653e", attr: { type: "button" } });
    const forward = toolbar.createEl("button", { text: "+5 \u79d2", attr: { type: "button" } });
    const time = toolbar.createEl("span", { cls: "media-player-time", text: "00:00 / --:--" });
    const speedLabel = toolbar.createEl("label", { cls: "media-player-speed" });
    speedLabel.createSpan({ text: "\u901f\u5ea6 " });
    const speed = speedLabel.createEl("select", { attr: { "aria-label": "\u64ad\u653e\u901f\u5ea6" } });
    for (const value of SPEEDS) {
      const option = speed.createEl("option", { text: `${value}\u00d7` });
      option.value = String(value);
    }
    speed.value = String(playbackSpeed);
    if (isVideo) {
      const sizeLabel = toolbar.createEl("label", { cls: "media-player-size" });
      sizeLabel.createSpan({ text: "影片大小 " });
      const size = sizeLabel.createEl("select", { attr: { "aria-label": "影片大小" } });
      for (const { value, label } of VIDEO_SIZES) {
        const option = size.createEl("option", { text: label });
        option.value = value;
      }
      size.value = videoSize;
      this.listen(size, "change", async () => {
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
      cls: "media-player-timing-controls",
      attr: { "aria-label": "時間標記控制" },
    });
    const timingToggle = createToggleButton(timingControls, "標記時間", "標記時間模式");
    const timing = timingToggle.button;
    this.timingButton = timing;
    this.timingLabel = timingToggle.labelElement;
    this.timingSaveButton = timingControls.createEl("button", {
      cls: "media-player-timing-save",
      text: "儲存標記（0）",
      attr: { type: "button", disabled: "true" },
    });
    const loopControls = toolbar.createDiv({
      cls: "media-player-loop-controls",
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
    const lyrics = this.container.createDiv({ cls: "media-player-lines" });
    let sectionIndex = 0;
    const renderSectionsBefore = (lineIndex) => {
      while (sectionIndex < parsed.sections.length && parsed.sections[sectionIndex].lineIndex < lineIndex) {
        lyrics.createDiv({ cls: "media-player-section", text: parsed.sections[sectionIndex].text });
        sectionIndex += 1;
      }
    };
    const cueButtons = parsed.cues.map((cue) => {
      renderSectionsBefore(cue.lineIndex);
      const row = lyrics.createEl("button", {
        cls: `media-player-cue${cue.time == null ? " is-untimed" : ""}`,
        attr: { type: "button" },
      });
      row.createSpan({ cls: "media-player-cue-time", text: cue.time == null ? "\u5f85\u6a19\u8a18" : cue.rawTime });
      row.createSpan({ cls: "media-player-cue-text", text: cue.text });
      this.listen(row, "click", async () => {
        if (this.timingMode) {
          this.markCue(cue, row);
          return;
        }
        if (cue.time == null) {
          new Notice("這句還沒有時間點；開啟「標記時間」後點它來標記。");
          return;
        }
        const repeatEnd = findRepeatEndTime(parsed.cues, cue.time, this.media.duration);
        this.setLoopRange(cue.time, repeatEnd, row);
        this.media.currentTime = cue.time;
        await this.media.play().catch(() => undefined);
      });
      return { cue, row };
    });
    renderSectionsBefore(Infinity);

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
      const selectedSpeed = Number(speed.value);
      this.media.playbackRate = selectedSpeed;
      this.media.preservesPitch = true;
      this.media.webkitPreservesPitch = true;
      if (Number(frontmatter?.media_speed) === selectedSpeed) return;
      this.rememberPlaybackState();
      await this.app.fileManager.processFrontMatter(note, (properties) => {
        properties.media_speed = selectedSpeed;
      });
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
      this.timingMode = false;
      setToggleButtonState(timing, false);
      this.container.removeClass("is-timing");
      await this.saveTiming();
      if (this.timingSaveButton) {
        this.timingSaveButton.setText("儲存標記（0）");
        this.timingSaveButton.disabled = true;
      }
    };
    this.listen(timing, "click", async () => {
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
    });
  }

  markCue(cue, row) {
    const seconds = this.media.currentTime;
    const timestamp = formatTimestamp(seconds);
    cue.time = seconds;
    cue.rawTime = timestamp;
    this.pendingTimestamps.set(cue.lineIndex, seconds);
    row.classList.remove("is-untimed");
    const time = row.querySelector(".media-player-cue-time");
    if (time) time.textContent = timestamp;
    if (this.timingSaveButton) {
      this.timingSaveButton.setText(`儲存標記（${this.pendingTimestamps.size}）`);
      this.timingSaveButton.disabled = false;
    }
  }

  async saveTiming() {
    if (!this.pendingTimestamps.size) return;
    const note = this.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(note instanceof TFile)) {
      new Notice("\u627e\u4e0d\u5230\u76ee\u524d\u7b46\u8a18\uff0c\u7121\u6cd5\u5beb\u5165\u6642\u9593\u9ede\u3002");
      return;
    }
    let updatedSource = this.source;
    for (const [lineIndex, seconds] of [...this.pendingTimestamps].sort((a, b) => a[0] - b[0])) {
      updatedSource = replaceCueTimestamp(updatedSource, lineIndex, seconds);
    }
    const before = `\`\`\`media-player\n${this.source}\n\`\`\``;
    const after = `\`\`\`media-player\n${updatedSource}\n\`\`\``;
    let changed = false;
    this.rememberPlaybackState();
    await this.app.vault.process(note, (content) => {
      if (!content.includes(before)) return content;
      changed = true;
      return content.replace(before, after);
    });
    if (changed) {
      const count = this.pendingTimestamps.size;
      this.pendingTimestamps.clear();
      new Notice(`\u5df2\u5132\u5b58 ${count} 個\u6642\u9593\u9ede`);
    } else {
      new Notice("\u627e\u4e0d\u5230\u539f\u59cb\u64ad\u653e\u5668\u5340\u584a\uff0c\u672a\u5beb\u5165\u3002");
    }
  }
}

module.exports = class LocalMediaPlayerPlugin extends Plugin {
  onload() {
    this.pendingPlaybackStates = new Map();
    this.registerMarkdownCodeBlockProcessor("media-player", (source, element, context) => {
      context.addChild(new MediaPlayerChild(this, element, source, context.sourcePath));
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

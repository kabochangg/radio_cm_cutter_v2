const CANVAS_HEIGHT = 280;
const TICK_SPACING_PX = 100;
const MAX_CANVAS_PIXELS = 20_000_000;
const MAX_CANVAS_BITMAP_WIDTH = 32767;

const WAVE_COLOR = "#2f7fda";
const ZERO_LINE_COLOR = "#5f7fa0";
const GRID_COLOR = "#dfe8f2";
const TICK_TEXT_COLOR = "#4f6277";
const PLAYHEAD_COLOR = "#d62f2f";
const HOVER_HEAD_COLOR = "rgba(12, 95, 112, 0.45)";
const ZOOM_STEPS_SEC = [10, 20, 30, 60, 180, 300];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const total = Math.floor(safe);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");

  if (hh > 0) {
    return `${hh}:${String(mm).padStart(2, "0")}:${ss}`;
  }

  return `${mm}:${ss}`;
}

/**
 * 音声解析クラス。
 * 各ブロック(例:256サンプル)ごとに min/max を保持し、ズーム時に再利用する。
 */
class WaveformAnalyzer {
  constructor(blockSize = 256) {
    this.blockSize = blockSize;
  }

  async analyzeFile(file) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;

    if (!AudioCtx) {
      throw new Error("このブラウザはAudioContextに対応していません。");
    }

    const arrayBuffer = await file.arrayBuffer();
    const context = new AudioCtx();

    try {
      const audioBuffer = await context.decodeAudioData(arrayBuffer);
      return this.buildWaveformData(audioBuffer);
    } finally {
      await context.close().catch(() => {
        // close失敗は解析結果に影響しないため握りつぶす
      });
    }
  }

  buildWaveformData(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const totalSamples = audioBuffer.length;
    const channelCount = audioBuffer.numberOfChannels;
    const blockSize = this.blockSize;

    const blockCount = Math.ceil(totalSamples / blockSize);
    const minValues = new Float32Array(blockCount);
    const maxValues = new Float32Array(blockCount);

    const channels = [];

    for (let ch = 0; ch < channelCount; ch += 1) {
      channels.push(audioBuffer.getChannelData(ch));
    }

    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const start = blockIndex * blockSize;
      const end = Math.min(start + blockSize, totalSamples);

      let blockMin = 1;
      let blockMax = -1;

      for (let ch = 0; ch < channelCount; ch += 1) {
        const data = channels[ch];
        let localMin = 1;
        let localMax = -1;

        for (let i = start; i < end; i += 1) {
          const v = data[i];

          if (v < localMin) {
            localMin = v;
          }

          if (v > localMax) {
            localMax = v;
          }
        }

        if (localMin < blockMin) {
          blockMin = localMin;
        }

        if (localMax > blockMax) {
          blockMax = localMax;
        }
      }

      minValues[blockIndex] = blockMin;
      maxValues[blockIndex] = blockMax;
    }

    return {
      duration: audioBuffer.duration,
      sampleRate,
      channelCount,
      blockSize,
      blockCount,
      minValues,
      maxValues,
    };
  }
}

/**
 * 波形描画クラス。
 * 目盛り線ピクセル間隔を固定し、ズームで1目盛り秒数だけ変える。
 */
class WaveformRenderer {
  constructor(mainCanvas, overlayCanvas, scrollContainer, shell) {
    this.mainCanvas = mainCanvas;
    this.overlayCanvas = overlayCanvas;
    this.scrollContainer = scrollContainer;
    this.shell = shell;

    this.mainCtx = this.mainCanvas.getContext("2d");
    this.overlayCtx = this.overlayCanvas.getContext("2d");

    this.padding = { top: 16, right: 14, bottom: 30, left: 52 };
    this.zoomIntervalSec = 10;
    // 波形本体は内部解像度を固定し、横幅上限を広く確保してズーム差を出しやすくする
    this.mainRenderDpr = 1;

    this.data = null;
    this.totalWidth = 1200;
    this.plotWidth = 1134;
    this.pixelsPerSecond = TICK_SPACING_PX / this.zoomIntervalSec;
    this.viewportWidth = 1200;
    this.cappedByMemory = false;

    this.resizeViewport();
    this.drawEmpty();
    this.renderOverlay(null, null);
  }

  setData(data) {
    this.data = data;
    this.redrawStatic();
  }

  clearData() {
    this.data = null;
    this.mainCanvas.classList.remove("clickable");
    this.totalWidth = this.viewportWidth;
    this.resizeMainCanvas();
    this.drawEmpty();
    this.renderOverlay(null, null);
  }

  setZoomInterval(seconds) {
    this.zoomIntervalSec = seconds;

    if (this.data) {
      this.redrawStatic();
    }
  }

  redrawStatic() {
    if (!this.data) {
      return;
    }

    this.computeGeometry();
    this.resizeMainCanvas();
    this.drawStaticLayer();
    this.mainCanvas.classList.add("clickable");
  }

  resizeViewport() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, Math.floor(this.scrollContainer.clientWidth || 1200));

    this.viewportWidth = width;
    this.overlayCanvas.style.width = `${width}px`;
    this.overlayCanvas.style.height = `${CANVAS_HEIGHT}px`;

    this.overlayCanvas.width = Math.floor(width * dpr);
    this.overlayCanvas.height = Math.floor(CANVAS_HEIGHT * dpr);
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  computeGeometry() {
    const duration = Math.max(0, this.data.duration);
    const dpr = this.mainRenderDpr;

    const desiredPps = TICK_SPACING_PX / this.zoomIntervalSec;
    const desiredPlotWidth = Math.max(1, Math.floor(duration * desiredPps));
    const desiredTotalWidth = desiredPlotWidth + this.padding.left + this.padding.right;

    const maxByPixels = Math.floor(MAX_CANVAS_PIXELS / (CANVAS_HEIGHT * dpr * dpr));
    const maxByBitmap = Math.floor(MAX_CANVAS_BITMAP_WIDTH / dpr);
    const maxLogicalWidth = Math.max(this.viewportWidth, Math.min(maxByPixels, maxByBitmap));

    this.cappedByMemory = false;

    if (desiredTotalWidth > maxLogicalWidth && duration > 0) {
      this.totalWidth = maxLogicalWidth;
      this.plotWidth = Math.max(1, this.totalWidth - this.padding.left - this.padding.right);
      this.pixelsPerSecond = this.plotWidth / duration;
      this.cappedByMemory = true;
      return;
    }

    this.plotWidth = desiredPlotWidth;
    this.pixelsPerSecond = desiredPps;
    this.totalWidth = Math.max(this.viewportWidth, desiredTotalWidth);
  }

  resizeMainCanvas() {
    const dpr = this.mainRenderDpr;

    this.mainCanvas.style.width = `${this.totalWidth}px`;
    this.mainCanvas.style.height = `${CANVAS_HEIGHT}px`;

    this.mainCanvas.width = Math.floor(this.totalWidth * dpr);
    this.mainCanvas.height = Math.floor(CANVAS_HEIGHT * dpr);

    this.mainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  drawEmpty() {
    this.mainCtx.clearRect(0, 0, this.totalWidth, CANVAS_HEIGHT);
    this.mainCtx.fillStyle = "#f6fbff";
    this.mainCtx.fillRect(0, 0, this.totalWidth, CANVAS_HEIGHT);

    this.mainCtx.fillStyle = "#6d7e90";
    this.mainCtx.font = "16px Segoe UI, sans-serif";
    this.mainCtx.textAlign = "center";
    this.mainCtx.textBaseline = "middle";
    this.mainCtx.fillText("ここに波形が表示されます", this.totalWidth / 2, CANVAS_HEIGHT / 2);
  }

  drawStaticLayer() {
    const ctx = this.mainCtx;
    const left = this.padding.left;
    const top = this.padding.top;
    const chartHeight = CANVAS_HEIGHT - this.padding.top - this.padding.bottom;

    ctx.clearRect(0, 0, this.totalWidth, CANVAS_HEIGHT);
    ctx.fillStyle = "#f6fbff";
    ctx.fillRect(0, 0, this.totalWidth, CANVAS_HEIGHT);

    this.drawGrid(ctx, left, top, chartHeight);
    this.drawWaveform(ctx, left, top, chartHeight);
    this.drawTicks(ctx, left, top, chartHeight);

    if (this.cappedByMemory) {
      ctx.fillStyle = "#9c5b00";
      ctx.font = "12px Segoe UI, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      ctx.fillText("長時間のため描画幅を自動調整", this.totalWidth - 8, CANVAS_HEIGHT - 4);
    }
  }

  drawGrid(ctx, left, top, chartHeight) {
    const zeroY = top + chartHeight - 6;
    const usableHeight = chartHeight - 12;

    const y25 = zeroY - usableHeight * 0.25;
    const y50 = zeroY - usableHeight * 0.5;
    const y75 = zeroY - usableHeight * 0.75;
    const y100 = zeroY - usableHeight;

    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(left, y25);
    ctx.lineTo(left + this.plotWidth, y25);
    ctx.moveTo(left, y50);
    ctx.lineTo(left + this.plotWidth, y50);
    ctx.moveTo(left, y75);
    ctx.lineTo(left + this.plotWidth, y75);
    ctx.moveTo(left, y100);
    ctx.lineTo(left + this.plotWidth, y100);
    ctx.stroke();

    ctx.strokeStyle = ZERO_LINE_COLOR;
    ctx.beginPath();
    ctx.moveTo(left, zeroY);
    ctx.lineTo(left + this.plotWidth, zeroY);
    ctx.stroke();

    ctx.fillStyle = TICK_TEXT_COLOR;
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText("100%", left - 8, y100);
    ctx.fillText("75%", left - 8, y75);
    ctx.fillText("50%", left - 8, y50);
    ctx.fillText("25%", left - 8, y25);
    ctx.fillText("0%", left - 8, zeroY);
  }

  drawWaveform(ctx, left, top, chartHeight) {
    const { minValues, maxValues, blockCount, blockSize, sampleRate } = this.data;

    if (blockCount === 0) {
      return;
    }

    const zeroY = top + chartHeight - 6;
    const usableHeight = Math.max(1, chartHeight - 12);

    const samplesPerPixel = sampleRate / this.pixelsPerSecond;
    const blocksPerPixel = samplesPerPixel / blockSize;

    const pixelColumns = Math.max(1, Math.floor(this.plotWidth));

    ctx.strokeStyle = WAVE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let x = 0; x < pixelColumns; x += 1) {
      const startBlock = clamp(Math.floor(x * blocksPerPixel), 0, blockCount - 1);
      const endBlock = clamp(Math.floor((x + 1) * blocksPerPixel), startBlock, blockCount - 1);

      let peak = 0;

      for (let b = startBlock; b <= endBlock; b += 1) {
        const localPeak = Math.max(Math.abs(minValues[b]), Math.abs(maxValues[b]));

        if (localPeak > peak) {
          peak = localPeak;
        }
      }

      const yTop = zeroY - peak * usableHeight;
      const px = left + x + 0.5;

      ctx.moveTo(px, zeroY);
      ctx.lineTo(px, yTop);
    }

    ctx.stroke();
  }

  drawTicks(ctx, left, top, chartHeight) {
    const duration = this.data.duration;
    const stepSec = this.zoomIntervalSec;

    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.fillStyle = TICK_TEXT_COLOR;
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let t = 0; t <= duration; t += stepSec) {
      const x = this.timeToX(t);

      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + chartHeight);
      ctx.stroke();

      ctx.fillText(formatTime(t), x, CANVAS_HEIGHT - this.padding.bottom + 8);
    }

    const endX = this.timeToX(duration);
    ctx.fillText(formatTime(duration), endX, CANVAS_HEIGHT - this.padding.bottom + 8);

    ctx.textAlign = "left";
    ctx.fillText("time →", 8, CANVAS_HEIGHT - this.padding.bottom + 8);
  }

  renderOverlay(playbackTime, hoverTime) {
    this.overlayCtx.clearRect(0, 0, this.viewportWidth, CANVAS_HEIGHT);

    if (!this.data) {
      return;
    }

    const scrollLeft = this.scrollContainer.scrollLeft;

    if (typeof hoverTime === "number") {
      this.drawOverlayLine(hoverTime, HOVER_HEAD_COLOR, 1, scrollLeft);
    }

    if (typeof playbackTime === "number") {
      this.drawOverlayLine(playbackTime, PLAYHEAD_COLOR, 2, scrollLeft);
    }
  }

  drawOverlayLine(time, color, width, scrollLeft) {
    const xGlobal = this.timeToX(time);
    const x = xGlobal - scrollLeft;

    if (x < 0 || x > this.viewportWidth) {
      return;
    }

    this.overlayCtx.strokeStyle = color;
    this.overlayCtx.lineWidth = width;
    this.overlayCtx.beginPath();
    this.overlayCtx.moveTo(x, this.padding.top);
    this.overlayCtx.lineTo(x, CANVAS_HEIGHT - this.padding.bottom);
    this.overlayCtx.stroke();
  }

  timeToX(time) {
    return this.padding.left + clamp(time, 0, this.data.duration) * this.pixelsPerSecond;
  }

  xToTime(xInCanvas) {
    const x = clamp(xInCanvas - this.padding.left, 0, this.plotWidth);
    return this.pixelsPerSecond > 0 ? x / this.pixelsPerSecond : 0;
  }

  timeFromPointerEvent(event) {
    if (!this.data) {
      return 0;
    }

    const rect = this.mainCanvas.getBoundingClientRect();
    const xInCanvas = event.clientX - rect.left;
    return this.xToTime(xInCanvas);
  }

  viewportXFromEvent(event) {
    const rect = this.shell.getBoundingClientRect();
    return clamp(event.clientX - rect.left, 0, this.viewportWidth);
  }

  scrollToTime(time) {
    if (!this.data) {
      return;
    }

    const x = this.timeToX(time);
    const left = x - this.viewportWidth / 2;
    const maxScroll = Math.max(0, this.totalWidth - this.viewportWidth);

    this.scrollContainer.scrollLeft = clamp(left, 0, maxScroll);
  }
}

class WaveformApp {
  constructor() {
    this.fileInput = document.getElementById("fileInput");
    this.zoomSelect = document.getElementById("zoomSelect");
    this.analyzeButton = document.getElementById("analyzeButton");

    this.playButton = document.getElementById("playButton");
    this.pauseButton = document.getElementById("pauseButton");
    this.stopButton = document.getElementById("stopButton");

    this.volumeSlider = document.getElementById("volumeSlider");
    this.volumeValue = document.getElementById("volumeValue");

    this.currentTimeText = document.getElementById("currentTimeText");
    this.totalTimeText = document.getElementById("totalTimeText");

    this.statusText = document.getElementById("statusText");
    this.metaText = document.getElementById("metaText");

    this.audio = document.getElementById("audioPlayer");
    this.mainCanvas = document.getElementById("waveCanvas");
    this.overlayCanvas = document.getElementById("overlayCanvas");
    this.scrollContainer = document.getElementById("chartScroll");
    this.canvasShell = document.getElementById("canvasShell");
    this.tooltip = document.getElementById("hoverTooltip");

    this.analyzer = new WaveformAnalyzer(256);
    this.renderer = new WaveformRenderer(
      this.mainCanvas,
      this.overlayCanvas,
      this.scrollContainer,
      this.canvasShell
    );

    this.waveformData = null;
    this.currentObjectUrl = "";
    this.hoverTime = null;
    this.rafId = 0;

    this.analyzeButton.disabled = true;
    this.audio.volume = 1;

    this.bindEvents();
    this.updateVolumeView(100);
    this.updateTimeView(0, 0);
    this.setStatus("ファイルを選択してください。");
    this.updateControlAvailability();
  }

  bindEvents() {
    this.fileInput.addEventListener("change", () => {
      const hasFile = !!this.getSelectedFile();
      this.analyzeButton.disabled = !hasFile;
      this.setStatus(hasFile ? "ファイルを選択しました。解析ボタンを押してください。" : "ファイルを選択してください。");
    });

    this.zoomSelect.addEventListener("change", () => {
      const zoomSec = Number(this.zoomSelect.value);
      this.applyZoom(zoomSec);
    });

    this.volumeSlider.addEventListener("input", () => {
      const percent = Number(this.volumeSlider.value);
      this.audio.volume = clamp(percent / 100, 0, 1);
      this.updateVolumeView(percent);
    });

    this.analyzeButton.addEventListener("click", async () => {
      await this.handleAnalyze();
    });

    this.playButton.addEventListener("click", async () => {
      await this.handlePlay();
    });

    this.pauseButton.addEventListener("click", () => {
      this.audio.pause();
    });

    this.stopButton.addEventListener("click", () => {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.updateTimeView(0, this.getDuration());
      this.renderer.scrollToTime(0);
      this.renderFrame();
      this.updateControlAvailability();
    });

    this.audio.addEventListener("loadedmetadata", () => {
      this.updateTimeView(this.audio.currentTime, this.getDuration());
      this.renderFrame();
      this.updateControlAvailability();
    });

    this.audio.addEventListener("timeupdate", () => {
      if (!this.isPlaying()) {
        this.updateTimeView(this.audio.currentTime, this.getDuration());
        this.renderFrame();
      }
    });

    this.audio.addEventListener("play", () => {
      this.startRenderLoop();
      this.updateControlAvailability();
    });

    this.audio.addEventListener("pause", () => {
      this.stopRenderLoop();
      this.updateTimeView(this.audio.currentTime, this.getDuration());
      this.renderFrame();
      this.updateControlAvailability();
    });

    this.audio.addEventListener("ended", () => {
      this.stopRenderLoop();
      this.updateTimeView(this.getDuration(), this.getDuration());
      this.renderFrame();
      this.setStatus("再生が終了しました。");
      this.updateControlAvailability();
    });

    this.mainCanvas.addEventListener("click", (event) => {
      this.handleCanvasClick(event);
    });

    this.mainCanvas.addEventListener("mousemove", (event) => {
      this.handleCanvasHover(event);
    });

    this.mainCanvas.addEventListener("mouseleave", () => {
      this.hoverTime = null;
      this.tooltip.hidden = true;
      this.renderFrame();
    });

    this.scrollContainer.addEventListener("scroll", () => {
      this.renderFrame();
    });

    this.scrollContainer.addEventListener(
      "wheel",
      (event) => {
        const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX;

        if (delta === 0) {
          return;
        }

        // Ctrl + ホイール時は横スクロールではなくズーム段階を切り替える
        if (event.ctrlKey) {
          event.preventDefault();
          const direction = delta < 0 ? -1 : 1;
          this.stepZoomByWheel(direction);
          return;
        }

        // 通常ホイールは波形エリアの横スクロール
        event.preventDefault();
        this.scrollContainer.scrollLeft += delta;
      },
      { passive: false }
    );

    window.addEventListener("keydown", (event) => {
      if (!this.shouldHandleSpaceShortcut(event)) {
        return;
      }

      event.preventDefault();

      if (this.isPlaying()) {
        this.audio.pause();
        this.setStatus("一時停止しました。");
        return;
      }

      const duration = this.getDuration();

      if (duration > 0 && this.audio.currentTime >= duration) {
        this.audio.currentTime = 0;
      }

      this.handlePlay();
    });

    window.addEventListener("resize", () => {
      this.renderer.resizeViewport();

      if (this.waveformData) {
        this.renderer.redrawStatic();
      }

      this.renderFrame();
    });

    window.addEventListener("beforeunload", () => {
      this.clearAudioSource();
      this.stopRenderLoop();
    });
  }

  updateVolumeView(percent) {
    this.volumeValue.textContent = `${Math.round(percent)}%`;
  }

  getSelectedFile() {
    return this.fileInput.files && this.fileInput.files[0] ? this.fileInput.files[0] : null;
  }

  getDuration() {
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
      return this.audio.duration;
    }

    return this.waveformData ? this.waveformData.duration : 0;
  }

  applyZoom(zoomSec) {
    const nextZoom = ZOOM_STEPS_SEC.includes(zoomSec) ? zoomSec : ZOOM_STEPS_SEC[0];
    const keepTime = this.waveformData ? this.audio.currentTime : 0;

    this.zoomSelect.value = String(nextZoom);
    this.renderer.setZoomInterval(nextZoom);

    if (this.waveformData) {
      this.renderer.scrollToTime(keepTime);
    }

    this.renderFrame();
  }

  stepZoomByWheel(direction) {
    const current = Number(this.zoomSelect.value);
    const currentIndex = ZOOM_STEPS_SEC.indexOf(current);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = clamp(safeIndex + direction, 0, ZOOM_STEPS_SEC.length - 1);

    if (nextIndex === safeIndex) {
      return;
    }

    this.applyZoom(ZOOM_STEPS_SEC[nextIndex]);
  }

  async handleAnalyze() {
    const file = this.getSelectedFile();

    if (!file) {
      this.setStatus("先にmp3ファイルを選択してください。", true);
      return;
    }

    try {
      this.disableWhileAnalyzing(true);
      this.setStatus("解析中です... 少し待ってください。");
      this.metaText.textContent = "";

      const result = await this.analyzer.analyzeFile(file);

      this.waveformData = result;
      this.renderer.setZoomInterval(Number(this.zoomSelect.value));
      this.renderer.setData(result);

      this.setAudioSource(file);
      this.audio.currentTime = 0;
      this.renderer.scrollToTime(0);

      this.updateTimeView(0, result.duration);
      this.hoverTime = null;
      this.tooltip.hidden = true;
      this.renderFrame();

      this.metaText.textContent =
        `長さ: ${result.duration.toFixed(2)}秒 / サンプルレート: ${result.sampleRate}Hz / ` +
        `チャンネル: ${result.channelCount} / ブロック数: ${result.blockCount}`;

      this.setStatus("解析完了。波形をクリックすると再生位置を移動できます。");
    } catch (error) {
      this.waveformData = null;
      this.renderer.clearData();
      this.clearAudioSource();
      this.updateTimeView(0, 0);
      this.setStatus("解析に失敗しました。mp3ファイルを確認してください。", true);
      this.metaText.textContent = String(error);
    } finally {
      this.disableWhileAnalyzing(false);
    }
  }

  async handlePlay() {
    if (!this.waveformData) {
      this.setStatus("先に解析を実行してください。", true);
      return;
    }

    try {
      await this.audio.play();
      this.setStatus("再生中です。");
    } catch (error) {
      this.setStatus("再生できませんでした。ブラウザ設定を確認してください。", true);
      this.metaText.textContent = String(error);
    }
  }

  handleCanvasClick(event) {
    if (!this.waveformData) {
      return;
    }

    const targetTime = this.renderer.timeFromPointerEvent(event);
    const wasPlaying = this.isPlaying();

    this.audio.currentTime = targetTime;
    this.updateTimeView(targetTime, this.getDuration());
    this.renderFrame();

    if (wasPlaying) {
      this.audio.play().catch(() => {
        // 再生失敗時はUIのみ更新
      });
    }

    this.setStatus(`ジャンプしました: ${formatTime(targetTime)}。`);
  }

  handleCanvasHover(event) {
    if (!this.waveformData) {
      return;
    }

    this.hoverTime = this.renderer.timeFromPointerEvent(event);
    this.tooltip.hidden = false;
    this.tooltip.style.left = `${this.renderer.viewportXFromEvent(event)}px`;
    this.tooltip.textContent = formatTime(this.hoverTime);

    this.renderFrame();
  }

  setAudioSource(file) {
    this.clearAudioSource();
    this.currentObjectUrl = URL.createObjectURL(file);
    this.audio.src = this.currentObjectUrl;
    this.audio.load();
  }

  clearAudioSource() {
    this.audio.pause();

    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = "";
    }

    if (this.audio.src) {
      this.audio.removeAttribute("src");
      this.audio.load();
    }
  }

  isPlaying() {
    return !this.audio.paused && !this.audio.ended;
  }

  shouldHandleSpaceShortcut(event) {
    const isSpace = event.code === "Space" || event.key === " " || event.key === "Spacebar";

    if (!isSpace || event.repeat || event.defaultPrevented) {
      return false;
    }

    if (!this.waveformData) {
      return false;
    }

    const target = event.target instanceof Element ? event.target : null;
    const active = document.activeElement instanceof Element ? document.activeElement : null;

    if (this.isTypingElement(target) || this.isTypingElement(active)) {
      return false;
    }

    return true;
  }

  isTypingElement(element) {
    if (!element) {
      return false;
    }

    if (element.matches("input, textarea, select, button")) {
      return true;
    }

    if (element.closest("input, textarea, select, button")) {
      return true;
    }

    if (element.closest('[contenteditable]:not([contenteditable="false"])')) {
      return true;
    }

    return element.isContentEditable;
  }

  startRenderLoop() {
    if (this.rafId) {
      return;
    }

    const tick = () => {
      const current = this.audio.currentTime;
      this.updateTimeView(current, this.getDuration());

      const x = this.renderer.timeToX(current);
      const left = this.scrollContainer.scrollLeft;
      const right = left + this.renderer.viewportWidth;

      if (x < left + 24 || x > right - 24) {
        this.renderer.scrollToTime(current);
      }

      this.renderFrame();

      if (this.isPlaying()) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.rafId = 0;
      }
    };

    this.rafId = requestAnimationFrame(tick);
  }

  stopRenderLoop() {
    if (!this.rafId) {
      return;
    }

    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  renderFrame() {
    const playTime = this.waveformData ? this.audio.currentTime : null;
    this.renderer.renderOverlay(playTime, this.hoverTime);
  }

  updateTimeView(current, total) {
    this.currentTimeText.textContent = formatTime(current);
    this.totalTimeText.textContent = formatTime(total);
  }

  disableWhileAnalyzing(isAnalyzing) {
    if (isAnalyzing) {
      this.analyzeButton.disabled = true;
      this.playButton.disabled = true;
      this.pauseButton.disabled = true;
      this.stopButton.disabled = true;
      this.stopRenderLoop();
      this.audio.pause();
      return;
    }

    this.analyzeButton.disabled = !this.getSelectedFile();
    this.updateControlAvailability();
  }

  updateControlAvailability() {
    const ready = !!this.waveformData && !!this.audio.src;

    if (!ready) {
      this.playButton.disabled = true;
      this.pauseButton.disabled = true;
      this.stopButton.disabled = true;
      return;
    }

    this.playButton.disabled = this.isPlaying();
    this.pauseButton.disabled = !this.isPlaying();
    this.stopButton.disabled = !this.isPlaying() && this.audio.currentTime <= 0;
  }

  setStatus(message, isError = false) {
    this.statusText.textContent = message;
    this.statusText.style.color = isError ? "#b30024" : "#12233a";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new WaveformApp();
});








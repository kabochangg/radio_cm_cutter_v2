const CANVAS_HEIGHT = 280;
const MINIMAP_HEIGHT = 86;
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
const DRAG_THRESHOLD_PX = 6;
const HANDLE_HIT_PX = 7;
const HISTORY_LIMIT = 60;
const MINIMAP_BINS = 2048;

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

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function audioBufferToWavBlob(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const frameCount = audioBuffer.length;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channelCount * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;

  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channels = [];

  for (let ch = 0; ch < channelCount; ch += 1) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  let offset = 44;

  for (let i = 0; i < frameCount; i += 1) {
    for (let ch = 0; ch < channelCount; ch += 1) {
      const v = clamp(channels[ch][i], -1, 1);
      const int16 = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return new Blob([wav], { type: "audio/wav" });
}
function float32ToInt16Block(data, start, end) {
  const size = end - start;
  const out = new Int16Array(size);

  for (let i = 0; i < size; i += 1) {
    const v = clamp(data[start + i], -1, 1);
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }

  return out;
}

function audioBufferToMp3Blob(audioBuffer, kbps = 128) {
  if (!window.lamejs || typeof window.lamejs.Mp3Encoder !== "function") {
    throw new Error("MP3エンコーダを読み込めませんでした。ネットワーク接続を確認してください。");
  }

  const channels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const encoder = new window.lamejs.Mp3Encoder(channels, sampleRate, kbps);
  const blockSize = 1152;
  const mp3Chunks = [];

  const left = audioBuffer.getChannelData(0);
  const right = channels === 2
    ? audioBuffer.getChannelData(1)
    : audioBuffer.getChannelData(0);

  for (let i = 0; i < audioBuffer.length; i += blockSize) {
    const end = Math.min(i + blockSize, audioBuffer.length);
    const leftChunk = float32ToInt16Block(left, i, end);

    let encoded;

    if (channels === 2) {
      const rightChunk = float32ToInt16Block(right, i, end);
      encoded = encoder.encodeBuffer(leftChunk, rightChunk);
    } else {
      encoded = encoder.encodeBuffer(leftChunk);
    }

    if (encoded.length > 0) {
      mp3Chunks.push(new Int8Array(encoded));
    }
  }

  const flush = encoder.flush();

  if (flush.length > 0) {
    mp3Chunks.push(new Int8Array(flush));
  }

  return new Blob(mp3Chunks, { type: "audio/mpeg" });
}

function buildEditedFileName(originalName) {
  if (!originalName) {
    return "audio_edited.mp3";
  }

  const dot = originalName.lastIndexOf(".");
  const base = dot > 0 ? originalName.slice(0, dot) : originalName;
  return `${base}_edited.mp3`;
}

function cloneAudioBufferChannels(audioBuffer) {
  const channels = [];

  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch += 1) {
    channels.push(new Float32Array(audioBuffer.getChannelData(ch)));
  }

  return channels;
}

function createWaveformDataFromPayload(payload) {
  return {
    duration: payload.duration,
    sampleRate: payload.sampleRate,
    channelCount: payload.channelCount,
    blockSize: payload.blockSize,
    blockCount: payload.blockCount,
    minValues: new Float32Array(payload.minValuesBuffer),
    maxValues: new Float32Array(payload.maxValuesBuffer),
    miniPeaks: payload.miniPeaksBuffer ? new Float32Array(payload.miniPeaksBuffer) : null,
  };
}

class WaveWorkerClient {
  constructor(workerPath = "./worker.js") {
    this.worker = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.lastError = "";

    if (typeof Worker !== "function") {
      this.lastError = "Worker未対応ブラウザ";
      return;
    }

    try {
      this.worker = new Worker(workerPath);
      this.worker.addEventListener("message", (event) => this.handleMessage(event));
      this.worker.addEventListener("error", (event) => {
        this.lastError = event.message || "Worker実行エラー";
      });
    } catch (error) {
      this.lastError = String(error);
      this.worker = null;
    }
  }

  isAvailable() {
    return !!this.worker;
  }

  request(type, payload, transferList = []) {
    if (!this.worker) {
      return Promise.reject(new Error("Workerが利用できません。"));
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ requestId, type, payload }, transferList);
    });
  }

  handleMessage(event) {
    const { requestId, ok, result, error } = event.data || {};
    const entry = this.pending.get(requestId);

    if (!entry) {
      return;
    }

    this.pending.delete(requestId);

    if (ok) {
      entry.resolve(result);
      return;
    }

    entry.reject(new Error(error || "Worker処理に失敗しました。"));
  }

  async buildWaveformData(audioBuffer, blockSize, minimapBins = MINIMAP_BINS) {
    const channels = cloneAudioBufferChannels(audioBuffer);
    const channelBuffers = channels.map((channel) => channel.buffer);

    const result = await this.request(
      "build-waveform",
      {
        sampleRate: audioBuffer.sampleRate,
        length: audioBuffer.length,
        channelCount: audioBuffer.numberOfChannels,
        blockSize,
        minimapBins,
        channelBuffers,
      },
      channelBuffers
    );

    return createWaveformDataFromPayload(result);
  }

  async cutAudioBuffer(audioBuffer, startSample, endSample, blockSize, minimapBins = MINIMAP_BINS) {
    const channels = cloneAudioBufferChannels(audioBuffer);
    const channelBuffers = channels.map((channel) => channel.buffer);

    const result = await this.request(
      "cut-segment",
      {
        sampleRate: audioBuffer.sampleRate,
        length: audioBuffer.length,
        channelCount: audioBuffer.numberOfChannels,
        startSample,
        endSample,
        blockSize,
        minimapBins,
        channelBuffers,
      },
      channelBuffers
    );

    return {
      sampleRate: result.sampleRate,
      channelCount: result.channelCount,
      length: result.length,
      channels: result.channelBuffers.map((buffer) => new Float32Array(buffer)),
      waveformData: createWaveformDataFromPayload(result.waveformData),
    };
  }

  terminate() {
    if (!this.worker) {
      return;
    }

    this.worker.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
/**
 * 音声解析クラス。
 * 各ブロック(例:256サンプル)ごとに min/max を保持し、ズーム時に再利用する。
 */
class WaveformAnalyzer {
  constructor(blockSize = 256, workerClient = null, minimapBins = MINIMAP_BINS) {
    this.blockSize = blockSize;
    this.workerClient = workerClient;
    this.minimapBins = minimapBins;
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
      const waveformData = await this.buildWaveformDataAsync(audioBuffer);
      return { audioBuffer, waveformData };
    } finally {
      await context.close().catch(() => {
        // close失敗は解析結果に影響しないため握りつぶす
      });
    }
  }

  async buildWaveformDataAsync(audioBuffer) {
    if (this.workerClient && this.workerClient.isAvailable()) {
      try {
        return await this.workerClient.buildWaveformData(
          audioBuffer,
          this.blockSize,
          this.minimapBins
        );
      } catch (_) {
        // fallback below
      }
    }

    return this.buildWaveformData(audioBuffer);
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
      miniPeaks: this.buildMiniPeaks(minValues, maxValues, this.minimapBins),
    };
  }

  buildMiniPeaks(minValues, maxValues, minimapBins) {
    const blockCount = minValues.length;

    if (blockCount === 0) {
      return new Float32Array(0);
    }

    const bins = Math.max(1, Math.min(minimapBins, blockCount));
    const peaks = new Float32Array(bins);
    const blocksPerBin = blockCount / bins;

    for (let iBin = 0; iBin < bins; iBin += 1) {
      const start = Math.floor(iBin * blocksPerBin);
      const end = Math.max(start + 1, Math.floor((iBin + 1) * blocksPerBin));

      let peak = 0;

      for (let b = start; b < end && b < blockCount; b += 1) {
        const localPeak = Math.max(Math.abs(minValues[b]), Math.abs(maxValues[b]));

        if (localPeak > peak) {
          peak = localPeak;
        }
      }

      peaks[iBin] = peak;
    }

    return peaks;
  }
}

/**
 * 波形描画クラス。
 * 目盛り線ピクセル間隔を固定し、ズームで1目盛り秒数だけ変える。
 */
class WaveformRenderer {
  constructor(mainCanvas, overlayCanvas, scrollContainer, shell, miniCanvas = null) {
    this.mainCanvas = mainCanvas;
    this.overlayCanvas = overlayCanvas;
    this.scrollContainer = scrollContainer;
    this.shell = shell;
    this.miniCanvas = miniCanvas;

    this.mainCtx = this.mainCanvas.getContext("2d");
    this.overlayCtx = this.overlayCanvas.getContext("2d");
    this.miniCtx = this.miniCanvas ? this.miniCanvas.getContext("2d") : null;
    this.selectionPattern = this.createSelectionPattern();

    this.padding = { top: 16, right: 14, bottom: 30, left: 52 };
    this.miniPadding = { top: 8, right: 8, bottom: 8, left: 8 };
    this.zoomIntervalSec = 10;
    // 波形本体は内部解像度を固定し、横幅上限を広く確保してズーム差を出しやすくする
    this.mainRenderDpr = 1;

    this.data = null;
    this.totalWidth = 1200;
    this.plotWidth = 1134;
    this.pixelsPerSecond = TICK_SPACING_PX / this.zoomIntervalSec;
    this.viewportWidth = 1200;
    this.cappedByMemory = false;

    this.minimapWidth = 0;
    this.minimapPlotWidth = 0;
    this.minimapCacheCanvas = null;

    this.resizeViewport();
    this.resizeMiniMap();
    this.drawEmpty();
    this.renderOverlay(null, null);
    this.renderMiniMap(null);
  }

  setData(data) {
    this.data = data;
    this.redrawStatic();
    this.redrawMiniMapStatic();
  }

  clearData() {
    this.data = null;
    this.mainCanvas.classList.remove("clickable");
    this.totalWidth = this.viewportWidth;
    this.resizeMainCanvas();
    this.drawEmpty();
    this.minimapCacheCanvas = null;
    this.drawMiniMapEmpty();
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

  resizeMiniMap() {
    if (!this.miniCanvas || !this.miniCtx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, Math.floor(this.shell.clientWidth || this.scrollContainer.clientWidth || 1200));

    this.minimapWidth = width;
    this.minimapPlotWidth = Math.max(1, width - this.miniPadding.left - this.miniPadding.right);

    this.miniCanvas.style.width = `${width}px`;
    this.miniCanvas.style.height = `${MINIMAP_HEIGHT}px`;

    this.miniCanvas.width = Math.floor(width * dpr);
    this.miniCanvas.height = Math.floor(MINIMAP_HEIGHT * dpr);
    this.miniCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (this.data) {
      this.redrawMiniMapStatic();
    } else {
      this.drawMiniMapEmpty();
    }
  }

  drawMiniMapEmpty() {
    if (!this.miniCtx) {
      return;
    }

    const width = this.minimapWidth || Math.floor(this.shell.clientWidth || 1200);

    this.miniCtx.clearRect(0, 0, width, MINIMAP_HEIGHT);
    this.miniCtx.fillStyle = "#f6fbff";
    this.miniCtx.fillRect(0, 0, width, MINIMAP_HEIGHT);

    this.miniCtx.fillStyle = "#6d7e90";
    this.miniCtx.font = "12px Segoe UI, sans-serif";
    this.miniCtx.textAlign = "center";
    this.miniCtx.textBaseline = "middle";
    this.miniCtx.fillText("ミニマップ", width / 2, MINIMAP_HEIGHT / 2);
  }

  createSelectionPattern() {
    const tile = document.createElement("canvas");
    tile.width = 12;
    tile.height = 12;

    const pctx = tile.getContext("2d");

    if (!pctx) {
      return null;
    }

    pctx.strokeStyle = "rgba(18, 59, 105, 0.35)";
    pctx.lineWidth = 2;

    pctx.beginPath();
    pctx.moveTo(-2, 12);
    pctx.lineTo(12, -2);
    pctx.stroke();

    pctx.beginPath();
    pctx.moveTo(4, 14);
    pctx.lineTo(14, 4);
    pctx.stroke();

    return this.overlayCtx.createPattern(tile, "repeat");
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

  redrawMiniMapStatic() {
    if (!this.miniCtx) {
      return;
    }

    if (!this.data) {
      this.minimapCacheCanvas = null;
      this.drawMiniMapEmpty();
      return;
    }

    const cache = document.createElement("canvas");
    cache.width = this.minimapWidth;
    cache.height = MINIMAP_HEIGHT;

    const ctx = cache.getContext("2d");

    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, this.minimapWidth, MINIMAP_HEIGHT);
    ctx.fillStyle = "#f6fbff";
    ctx.fillRect(0, 0, this.minimapWidth, MINIMAP_HEIGHT);

    const top = this.miniPadding.top;
    const left = this.miniPadding.left;
    const zeroY = MINIMAP_HEIGHT - this.miniPadding.bottom - 1;
    const usableHeight = Math.max(1, zeroY - top);

    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, zeroY + 0.5);
    ctx.lineTo(left + this.minimapPlotWidth, zeroY + 0.5);
    ctx.stroke();

    const { minValues, maxValues, miniPeaks, blockCount, blockSize, sampleRate } = this.data;

    if (blockCount > 0 && this.data.duration > 0) {
      const pixelColumns = Math.max(1, Math.floor(this.minimapPlotWidth));

      ctx.strokeStyle = WAVE_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();

      if (miniPeaks && miniPeaks.length > 0) {
        const binsPerPixel = miniPeaks.length / pixelColumns;

        for (let x = 0; x < pixelColumns; x += 1) {
          const startBin = clamp(Math.floor(x * binsPerPixel), 0, miniPeaks.length - 1);
          const endBin = clamp(Math.floor((x + 1) * binsPerPixel), startBin, miniPeaks.length - 1);

          let peak = 0;

          for (let b = startBin; b <= endBin; b += 1) {
            if (miniPeaks[b] > peak) {
              peak = miniPeaks[b];
            }
          }

          const yTop = zeroY - peak * usableHeight;
          const px = left + x + 0.5;

          ctx.moveTo(px, zeroY);
          ctx.lineTo(px, yTop);
        }
      } else {
        const miniPps = this.minimapPlotWidth / this.data.duration;
        const samplesPerPixel = sampleRate / miniPps;
        const blocksPerPixel = samplesPerPixel / blockSize;

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
      }

      ctx.stroke();
    }

    this.minimapCacheCanvas = cache;
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

  renderOverlay(playbackTime, hoverTime, selectionRange = null, activeHandle = null) {
    this.overlayCtx.clearRect(0, 0, this.viewportWidth, CANVAS_HEIGHT);

    if (!this.data) {
      return;
    }

    const scrollLeft = this.scrollContainer.scrollLeft;

    if (selectionRange) {
      const activeEdge = activeHandle ? activeHandle.edge : null;
      this.drawSelectionRange(selectionRange, scrollLeft, activeEdge);
    }

    if (typeof hoverTime === "number") {
      this.drawOverlayLine(hoverTime, HOVER_HEAD_COLOR, 1, scrollLeft);
    }

    if (typeof playbackTime === "number") {
      this.drawOverlayLine(playbackTime, PLAYHEAD_COLOR, 2, scrollLeft);
    }
  }

  drawSelectionRange(range, scrollLeft, activeEdge = null) {
    const chartTop = this.padding.top;
    const chartBottom = CANVAS_HEIGHT - this.padding.bottom;
    const chartHeight = chartBottom - chartTop;

    const x1 = this.timeToX(range.start) - scrollLeft;
    const x2 = this.timeToX(range.end) - scrollLeft;

    let left = Math.min(x1, x2);
    let right = Math.max(x1, x2);

    if (right < 0 || left > this.viewportWidth) {
      return;
    }

    left = clamp(left, 0, this.viewportWidth);
    right = clamp(right, 0, this.viewportWidth);

    const width = right - left;

    if (width < 1) {
      return;
    }

    this.overlayCtx.save();
    this.overlayCtx.fillStyle = "rgba(28, 95, 166, 0.16)";
    this.overlayCtx.fillRect(left, chartTop, width, chartHeight);

    if (this.selectionPattern) {
      this.overlayCtx.fillStyle = this.selectionPattern;
      this.overlayCtx.fillRect(left, chartTop, width, chartHeight);
    }

    this.overlayCtx.strokeStyle = "rgba(20, 77, 137, 0.95)";
    this.overlayCtx.lineWidth = 1;
    this.overlayCtx.beginPath();
    this.overlayCtx.moveTo(left + 0.5, chartTop);
    this.overlayCtx.lineTo(left + 0.5, chartBottom);
    this.overlayCtx.moveTo(right - 0.5, chartTop);
    this.overlayCtx.lineTo(right - 0.5, chartBottom);
    this.overlayCtx.stroke();

    this.drawSelectionHandles(left, right, chartTop, chartHeight, activeEdge);
    this.overlayCtx.restore();
  }

  drawSelectionHandles(left, right, top, height, activeEdge) {
    const handleWidth = 6;

    const drawHandle = (x, isActive) => {
      this.overlayCtx.fillStyle = isActive ? "rgba(17, 82, 153, 0.95)" : "rgba(17, 82, 153, 0.65)";
      this.overlayCtx.fillRect(x - handleWidth / 2, top, handleWidth, height);
    };

    drawHandle(left, activeEdge === "start");
    drawHandle(right, activeEdge === "end");
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

  renderMiniMap(playbackTime = null) {
    if (!this.miniCtx) {
      return;
    }

    if (!this.data || !this.minimapCacheCanvas) {
      this.drawMiniMapEmpty();
      return;
    }

    this.miniCtx.clearRect(0, 0, this.minimapWidth, MINIMAP_HEIGHT);
    this.miniCtx.drawImage(this.minimapCacheCanvas, 0, 0, this.minimapWidth, MINIMAP_HEIGHT);

    const viewport = this.getMiniViewportRect();

    if (viewport) {
      const chartTop = this.miniPadding.top;
      const chartHeight = MINIMAP_HEIGHT - this.miniPadding.top - this.miniPadding.bottom;

      this.miniCtx.fillStyle = "rgba(17, 82, 153, 0.14)";
      this.miniCtx.fillRect(viewport.left, chartTop, viewport.width, chartHeight);

      this.miniCtx.strokeStyle = "rgba(17, 82, 153, 0.9)";
      this.miniCtx.lineWidth = 1;
      this.miniCtx.strokeRect(
        viewport.left + 0.5,
        chartTop + 0.5,
        Math.max(1, viewport.width - 1),
        Math.max(1, chartHeight - 1)
      );
    }

    if (typeof playbackTime === "number") {
      const x = this.timeToMiniX(playbackTime);
      this.miniCtx.strokeStyle = PLAYHEAD_COLOR;
      this.miniCtx.lineWidth = 1.5;
      this.miniCtx.beginPath();
      this.miniCtx.moveTo(x, this.miniPadding.top);
      this.miniCtx.lineTo(x, MINIMAP_HEIGHT - this.miniPadding.bottom);
      this.miniCtx.stroke();
    }
  }

  getMiniViewportRect() {
    if (!this.data || this.minimapPlotWidth <= 0) {
      return null;
    }

    const safeTotalWidth = Math.max(1, this.totalWidth);
    const leftRatio = this.scrollContainer.scrollLeft / safeTotalWidth;
    const rawWidth = (this.viewportWidth / safeTotalWidth) * this.minimapPlotWidth;

    const minWidth = Math.min(this.minimapPlotWidth, 12);
    const width = clamp(rawWidth, minWidth, this.minimapPlotWidth);
    const maxLeft = this.miniPadding.left + this.minimapPlotWidth - width;

    const left = clamp(
      this.miniPadding.left + leftRatio * this.minimapPlotWidth,
      this.miniPadding.left,
      maxLeft
    );

    return {
      left,
      width,
      right: left + width,
    };
  }

  timeToMiniX(time) {
    if (!this.data || this.data.duration <= 0) {
      return this.miniPadding.left;
    }

    const ratio = clamp(time, 0, this.data.duration) / this.data.duration;
    return this.miniPadding.left + ratio * this.minimapPlotWidth;
  }

  miniClientXToLocal(clientX) {
    if (!this.miniCanvas) {
      return 0;
    }

    const rect = this.miniCanvas.getBoundingClientRect();
    return clamp(clientX - rect.left, 0, this.minimapWidth);
  }

  miniLeftToScrollLeft(miniLeft) {
    const maxScroll = Math.max(0, this.totalWidth - this.viewportWidth);

    if (maxScroll <= 0) {
      return 0;
    }

    const leftRatio = clamp(
      (miniLeft - this.miniPadding.left) / Math.max(1, this.minimapPlotWidth),
      0,
      1
    );

    return clamp(leftRatio * this.totalWidth, 0, maxScroll);
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
    this.undoButton = document.getElementById("undoButton");
    this.redoButton = document.getElementById("redoButton");
    this.cutButton = document.getElementById("cutButton");
    this.exportButton = document.getElementById("exportButton");

    this.volumeSlider = document.getElementById("volumeSlider");
    this.volumeValue = document.getElementById("volumeValue");

    this.currentTimeText = document.getElementById("currentTimeText");
    this.totalTimeText = document.getElementById("totalTimeText");

    this.statusText = document.getElementById("statusText");
    this.metaText = document.getElementById("metaText");
    this.selectionText = document.getElementById("selectionText");

    this.audio = document.getElementById("audioPlayer");
    this.mainCanvas = document.getElementById("waveCanvas");
    this.overlayCanvas = document.getElementById("overlayCanvas");
    this.scrollContainer = document.getElementById("chartScroll");
    this.canvasShell = document.getElementById("canvasShell");
    this.tooltip = document.getElementById("hoverTooltip");
    this.miniMapCanvas = document.getElementById("miniMapCanvas");

    this.workerClient = new WaveWorkerClient("./worker.js");
    this.analyzer = new WaveformAnalyzer(256, this.workerClient, MINIMAP_BINS);
    this.renderer = new WaveformRenderer(
      this.mainCanvas,
      this.overlayCanvas,
      this.scrollContainer,
      this.canvasShell,
      this.miniMapCanvas
    );

    this.waveformData = null;
    this.audioBufferData = null;
    this.currentObjectUrl = "";
    this.currentFileName = "";
    this.pendingSeekTime = null;
    this.hoverTime = null;
    this.selectionRange = null;
    this.dragState = null;
    this.activeHandle = null;
    this.suppressClickJump = false;
    this.minimapDragState = null;
    this.undoStack = [];
    this.redoStack = [];
    this.pendingSelectionSnapshot = null;
    this.rafId = 0;

    this.analyzeButton.disabled = true;
    this.audio.volume = 1;

    this.bindEvents();
    this.updateVolumeView(100);
    this.updateTimeView(0, 0);
    this.setStatus("ファイルを選択してください。");
    this.updateSelectionInfo(null);
    this.updateControlAvailability();
    this.updateHistoryButtons();
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

    this.undoButton.addEventListener("click", () => {
      this.handleUndo();
    });

    this.redoButton.addEventListener("click", () => {
      this.handleRedo();
    });

    this.cutButton.addEventListener("click", async () => {
      await this.handleCutSelectedSegment();
    });

    this.exportButton.addEventListener("click", async () => {
      await this.handleExportMp3();
    });

    this.audio.addEventListener("loadedmetadata", () => {
      if (typeof this.pendingSeekTime === "number") {
        this.audio.currentTime = clamp(this.pendingSeekTime, 0, this.getDuration());
        this.pendingSeekTime = null;
      }

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

    this.mainCanvas.addEventListener("mousedown", (event) => {
      this.beginSelectionDrag(event);
    });

    if (this.miniMapCanvas) {
      this.miniMapCanvas.addEventListener("mousedown", (event) => {
        this.beginMiniMapDrag(event);
      });

      this.miniMapCanvas.addEventListener("dragstart", (event) => {
        event.preventDefault();
      });

    }

    this.mainCanvas.addEventListener("click", (event) => {
      if (this.suppressClickJump) {
        this.suppressClickJump = false;
        return;
      }

      this.handleCanvasClick(event);
    });

    this.mainCanvas.addEventListener("mousemove", (event) => {
      if (this.dragState) {
        this.updateSelectionDrag(event.clientX);
        return;
      }

      this.handleCanvasHover(event);
    });

    this.mainCanvas.addEventListener("mouseleave", () => {
      if (this.dragState) {
        return;
      }

      this.hoverTime = null;
      this.tooltip.hidden = true;
      this.renderFrame();
    });

    window.addEventListener("mousemove", (event) => {
      if (this.minimapDragState) {
        this.updateMiniMapDrag(event.clientX);
      }

      if (!this.dragState) {
        return;
      }

      this.updateSelectionDrag(event.clientX);
    });

    window.addEventListener("mouseup", (event) => {
      this.endMiniMapDrag();
      this.endSelectionDrag(event);
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

        if (event.ctrlKey) {
          event.preventDefault();
          const direction = delta < 0 ? -1 : 1;
          this.stepZoomByWheel(direction);
          return;
        }

        event.preventDefault();
        this.scrollContainer.scrollLeft += delta;
      },
      { passive: false }
    );

    window.addEventListener("keydown", (event) => {
      if (this.handleHistoryShortcut(event)) {
        return;
      }

      if (event.key === "Escape" && this.clearSelection()) {
        event.preventDefault();
        return;
      }

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
      this.renderer.resizeMiniMap();

      if (this.waveformData) {
        this.renderer.redrawStatic();
      }

      this.renderFrame();
    });

    window.addEventListener("beforeunload", () => {
      this.clearAudioSource();
      this.stopRenderLoop();

      if (this.workerClient) {
        this.workerClient.terminate();
      }
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

  cloneSelectionRange(range) {
    if (!range) {
      return null;
    }

    return { start: range.start, end: range.end };
  }

  selectionRangesEqual(a, b) {
    if (!a && !b) {
      return true;
    }

    if (!a || !b) {
      return false;
    }

    const epsilon = 0.000001;
    return Math.abs(a.start - b.start) <= epsilon && Math.abs(a.end - b.end) <= epsilon;
  }

  captureHistoryState() {
    return {
      audioBufferData: this.audioBufferData,
      waveformData: this.waveformData,
      selectionRange: this.cloneSelectionRange(this.selectionRange),
      currentTime: this.audio.currentTime,
      scrollLeft: this.scrollContainer.scrollLeft,
      zoomSec: Number(this.zoomSelect.value),
      currentFileName: this.currentFileName,
    };
  }

  pushUndoSnapshot(snapshot) {
    if (!snapshot) {
      return;
    }

    this.undoStack.push(snapshot);

    if (this.undoStack.length > HISTORY_LIMIT) {
      this.undoStack.shift();
    }

    this.redoStack.length = 0;
    this.updateHistoryButtons();
  }

  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pendingSelectionSnapshot = null;
    this.updateHistoryButtons();
  }

  handleHistoryShortcut(event) {
    const isMod = event.ctrlKey || event.metaKey;

    if (!isMod || event.altKey) {
      return false;
    }

    const key = event.key.toLowerCase();
    const target = event.target instanceof Element ? event.target : null;
    const active = document.activeElement instanceof Element ? document.activeElement : null;

    if (this.isTypingElement(target) || this.isTypingElement(active)) {
      return false;
    }

    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      this.handleUndo();
      return true;
    }

    if (key === "y" || (key === "z" && event.shiftKey)) {
      event.preventDefault();
      this.handleRedo();
      return true;
    }

    return false;
  }

  handleUndo() {
    if (this.undoStack.length === 0) {
      return;
    }

    const current = this.captureHistoryState();
    const snapshot = this.undoStack.pop();
    this.redoStack.push(current);

    if (this.redoStack.length > HISTORY_LIMIT) {
      this.redoStack.shift();
    }

    this.restoreFromSnapshot(snapshot, "Undoを実行しました。");
    this.updateHistoryButtons();
  }

  handleRedo() {
    if (this.redoStack.length === 0) {
      return;
    }

    const current = this.captureHistoryState();
    const snapshot = this.redoStack.pop();
    this.undoStack.push(current);

    if (this.undoStack.length > HISTORY_LIMIT) {
      this.undoStack.shift();
    }

    this.restoreFromSnapshot(snapshot, "Redoを実行しました。");
    this.updateHistoryButtons();
  }

  restoreFromSnapshot(snapshot, statusMessage) {
    this.audio.pause();
    this.stopRenderLoop();

    const previousAudioBuffer = this.audioBufferData;
    const previousWaveformData = this.waveformData;

    this.audioBufferData = snapshot.audioBufferData || null;
    this.waveformData = snapshot.waveformData || null;
    this.selectionRange = this.cloneSelectionRange(snapshot.selectionRange);
    this.dragState = null;
    this.activeHandle = null;
    this.hoverTime = null;
    this.pendingSelectionSnapshot = null;
    this.tooltip.hidden = true;
    this.currentFileName = snapshot.currentFileName || this.currentFileName;

    const zoom = ZOOM_STEPS_SEC.includes(snapshot.zoomSec) ? snapshot.zoomSec : Number(this.zoomSelect.value);
    this.zoomSelect.value = String(zoom);
    this.renderer.setZoomInterval(zoom);

    if (this.waveformData && this.audioBufferData) {
      const audioChanged = previousAudioBuffer !== this.audioBufferData || previousWaveformData !== this.waveformData;
      const seekTime = clamp(snapshot.currentTime, 0, this.waveformData.duration);

      if (audioChanged) {
        this.renderer.setData(this.waveformData);
        const wavBlob = audioBufferToWavBlob(this.audioBufferData);
        this.setAudioSource(wavBlob, seekTime);
      } else {
        this.audio.currentTime = seekTime;
      }

      const maxScroll = Math.max(0, this.renderer.totalWidth - this.renderer.viewportWidth);
      this.scrollContainer.scrollLeft = clamp(snapshot.scrollLeft, 0, maxScroll);
      this.updateTimeView(seekTime, this.waveformData.duration);
    } else {
      this.renderer.clearData();
      this.clearAudioSource();
      this.updateTimeView(0, 0);
    }

    this.updateSelectionInfo(this.selectionRange);
    this.updateControlAvailability();
    this.renderFrame();
    this.setStatus(statusMessage);
  }

  updateHistoryButtons() {
    if (!this.undoButton || !this.redoButton) {
      return;
    }

    this.undoButton.disabled = this.undoStack.length === 0;
    this.redoButton.disabled = this.redoStack.length === 0;
  }

  beginMiniMapDrag(event) {
    if (!this.waveformData || !this.miniMapCanvas || event.button !== 0) {
      return;
    }

    event.preventDefault();

    const localX = this.renderer.miniClientXToLocal(event.clientX);
    const viewport = this.renderer.getMiniViewportRect();
    let anchorOffset = 0;

    if (viewport && localX >= viewport.left && localX <= viewport.right) {
      anchorOffset = localX - viewport.left;
    } else {
      anchorOffset = viewport ? viewport.width / 2 : 0;
    }

    this.minimapDragState = { anchorOffset };
    this.miniMapCanvas.classList.add("dragging");
    this.applyMiniMapScroll(localX, anchorOffset);
  }

  updateMiniMapDrag(clientX) {
    if (!this.minimapDragState || !this.waveformData) {
      return;
    }

    const localX = this.renderer.miniClientXToLocal(clientX);
    this.applyMiniMapScroll(localX, this.minimapDragState.anchorOffset);
  }

  endMiniMapDrag() {
    if (!this.minimapDragState) {
      return;
    }

    this.minimapDragState = null;

    if (this.miniMapCanvas) {
      this.miniMapCanvas.classList.remove("dragging");
    }
  }

  applyMiniMapScroll(localX, anchorOffset = 0) {
    if (!this.waveformData) {
      return;
    }

    const targetLeft = localX - anchorOffset;
    this.scrollContainer.scrollLeft = this.renderer.miniLeftToScrollLeft(targetLeft);
    this.renderFrame();
  }

  beginSelectionDrag(event) {
    if (!this.waveformData || event.button !== 0) {
      return;
    }

    event.preventDefault();
    this.pendingSelectionSnapshot = this.captureHistoryState();

    const edge = this.findHandleHit(event.clientX);

    if (edge) {
      this.dragState = {
        mode: "resize",
        edge,
      };
      this.activeHandle = { edge };
    } else {
      const startTime = this.renderer.timeFromPointerEvent(event);
      this.dragState = {
        mode: "create",
        anchorTime: startTime,
        currentTime: startTime,
        startClientX: event.clientX,
        moved: false,
      };
      this.activeHandle = null;
    }

    this.hoverTime = null;
    this.tooltip.hidden = true;
    this.updateSelectionInfo(this.getActiveSelectionRange());
    this.renderFrame();
  }

  updateSelectionDrag(clientX) {
    if (!this.dragState || !this.waveformData) {
      return;
    }

    if (this.dragState.mode === "create") {
      this.dragState.currentTime = this.timeFromClientX(clientX);
      this.dragState.moved = Math.abs(clientX - this.dragState.startClientX) >= DRAG_THRESHOLD_PX;
    } else if (this.selectionRange) {
      const duration = this.getDuration();
      const targetTime = clamp(this.timeFromClientX(clientX), 0, duration);

      if (this.dragState.edge === "start") {
        this.selectionRange.start = clamp(targetTime, 0, this.selectionRange.end);
      } else {
        this.selectionRange.end = clamp(targetTime, this.selectionRange.start, duration);
      }
    }

    this.hoverTime = null;
    this.tooltip.hidden = true;
    this.updateSelectionInfo(this.getActiveSelectionRange());
    this.renderFrame();
  }

  endSelectionDrag(event) {
    if (!this.dragState || !this.waveformData) {
      return;
    }

    this.updateSelectionDrag(event.clientX);

    if (this.dragState.mode === "create") {
      if (this.dragState.moved) {
        const normalized = this.normalizeSelectionRange(
          this.dragState.anchorTime,
          this.dragState.currentTime
        );

        if (normalized.end - normalized.start > 0.0001) {
          this.selectionRange = normalized;
          this.suppressNextClickJump();
          this.setStatus(
            `区間選択: ${formatTime(normalized.start)} - ${formatTime(normalized.end)} (${(normalized.end - normalized.start).toFixed(2)}秒)`
          );
        }
      }
    } else {
      if (this.selectionRange && this.selectionRange.end - this.selectionRange.start <= 0.0001) {
        this.selectionRange = null;
        this.setStatus("端点調整で長さ0になったため選択を解除しました。");
      } else if (this.selectionRange) {
        this.setStatus(
          `区間を調整: ${formatTime(this.selectionRange.start)} - ${formatTime(this.selectionRange.end)} (${(this.selectionRange.end - this.selectionRange.start).toFixed(2)}秒)`
        );
      }

      this.suppressNextClickJump();
    }

    const beforeSelection = this.pendingSelectionSnapshot ? this.pendingSelectionSnapshot.selectionRange : null;
    const didSelectionChange = this.pendingSelectionSnapshot
      ? !this.selectionRangesEqual(beforeSelection, this.selectionRange)
      : false;

    if (didSelectionChange) {
      this.pushUndoSnapshot(this.pendingSelectionSnapshot);
    }

    this.pendingSelectionSnapshot = null;
    this.dragState = null;
    this.activeHandle = null;
    this.updateSelectionInfo(this.selectionRange);
    this.updateControlAvailability();
    this.renderFrame();
  }

  timeFromClientX(clientX) {
    return this.renderer.xToTime(this.getCanvasX(clientX));
  }

  getCanvasX(clientX) {
    const rect = this.mainCanvas.getBoundingClientRect();
    return clientX - rect.left;
  }

  findHandleHit(clientX) {
    if (!this.waveformData || !this.selectionRange) {
      return null;
    }

    const x = this.getCanvasX(clientX);
    const startDist = Math.abs(x - this.renderer.timeToX(this.selectionRange.start));
    const endDist = Math.abs(x - this.renderer.timeToX(this.selectionRange.end));

    if (startDist > HANDLE_HIT_PX && endDist > HANDLE_HIT_PX) {
      return null;
    }

    return startDist <= endDist ? "start" : "end";
  }

  normalizeSelectionRange(t1, t2) {
    const start = Math.min(t1, t2);
    const end = Math.max(t1, t2);
    return { start, end };
  }

  getActiveSelectionRange() {
    if (this.dragState && this.dragState.mode === "create" && this.dragState.moved) {
      return this.normalizeSelectionRange(this.dragState.anchorTime, this.dragState.currentTime);
    }

    return this.selectionRange;
  }

  suppressNextClickJump() {
    this.suppressClickJump = true;
    window.setTimeout(() => {
      this.suppressClickJump = false;
    }, 0);
  }

  clearSelection() {
    if (!this.selectionRange && !this.dragState) {
      return false;
    }

    if (this.selectionRange) {
      this.pushUndoSnapshot(this.captureHistoryState());
    }

    this.selectionRange = null;
    this.pendingSelectionSnapshot = null;
    this.dragState = null;
    this.activeHandle = null;
    this.updateSelectionInfo(null);
    this.updateControlAvailability();
    this.renderFrame();
    this.setStatus("選択範囲を解除しました。");
    return true;
  }

  updateSelectionInfo(range) {
    if (!this.selectionText) {
      return;
    }

    if (!range) {
      this.selectionText.textContent = "選択範囲: なし";
      return;
    }

    const duration = Math.max(0, range.end - range.start);
    this.selectionText.textContent =
      `選択範囲: ${formatTime(range.start)} - ${formatTime(range.end)} (長さ ${duration.toFixed(2)}秒)`;
  }

  async createEmptyAudioBuffer(sampleRate, channelCount, length) {
    if (typeof AudioBuffer === "function") {
      try {
        return new AudioBuffer({
          length,
          numberOfChannels: channelCount,
          sampleRate,
        });

      } catch (_) {
        // fallback below
      }
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;

    if (!AudioCtx) {
      throw new Error("このブラウザはAudioBuffer生成に対応していません。");
    }

    const context = new AudioCtx();

    try {
      return context.createBuffer(channelCount, length, sampleRate);
    } finally {
      await context.close().catch(() => {
        // close失敗は後続に影響しない
      });

    }
  }

  async createAudioBufferFromChannels(sampleRate, channels) {
    if (!channels || channels.length === 0) {
      throw new Error("チャンネルデータがありません。");
    }

    const channelCount = channels.length;
    const length = channels[0].length;
    const buffer = await this.createEmptyAudioBuffer(sampleRate, channelCount, length);

    for (let ch = 0; ch < channelCount; ch += 1) {
      buffer.getChannelData(ch).set(channels[ch]);
    }

    return buffer;
  }

  async handleCutSelectedSegment() {
    if (!this.audioBufferData || !this.selectionRange) {
      return;
    }

    const sourceBuffer = this.audioBufferData;
    const sampleRate = sourceBuffer.sampleRate;
    const totalSamples = sourceBuffer.length;

    const startTime = clamp(Math.min(this.selectionRange.start, this.selectionRange.end), 0, sourceBuffer.duration);
    const endTime = clamp(Math.max(this.selectionRange.start, this.selectionRange.end), 0, sourceBuffer.duration);

    const startSample = clamp(Math.floor(startTime * sampleRate), 0, totalSamples);
    const endSample = clamp(Math.ceil(endTime * sampleRate), startSample, totalSamples);
    const removedSamples = endSample - startSample;

    if (removedSamples <= 0) {
      this.setStatus("有効な選択区間がありません。", true);
      return;
    }

    const newLength = totalSamples - removedSamples;

    if (newLength <= 0) {
      this.setStatus("音声全体が選択されています。最低1区間は残してください。", true);
      return;
    }

    const oldTime = this.audio.currentTime;
    const wasPlaying = this.isPlaying();
    const beforeCutSnapshot = this.captureHistoryState();

    try {
      this.setStatus("選択区間をカットしています...");
      this.audio.pause();
      this.stopRenderLoop();

      let newBuffer;
      let newWaveformData;

      if (this.workerClient && this.workerClient.isAvailable()) {
        try {
          const workerResult = await this.workerClient.cutAudioBuffer(
            sourceBuffer,
            startSample,
            endSample,
            this.analyzer.blockSize,
            this.analyzer.minimapBins
          );

          newBuffer = await this.createAudioBufferFromChannels(workerResult.sampleRate, workerResult.channels);
          newWaveformData = workerResult.waveformData;
        } catch (_) {
          // Worker失敗時は同期処理にフォールバック
        }
      }

      if (!newBuffer || !newWaveformData) {
        const channelCount = sourceBuffer.numberOfChannels;
        newBuffer = await this.createEmptyAudioBuffer(sampleRate, channelCount, newLength);

        for (let ch = 0; ch < channelCount; ch += 1) {
          const src = sourceBuffer.getChannelData(ch);
          const dst = newBuffer.getChannelData(ch);

          const before = src.subarray(0, startSample);
          dst.set(before, 0);

          const after = src.subarray(endSample);
          dst.set(after, before.length);
        }

        newWaveformData = await this.analyzer.buildWaveformDataAsync(newBuffer);
      }

      const wavBlob = audioBufferToWavBlob(newBuffer);

      let mappedTime = oldTime;

      if (oldTime > endTime) {
        mappedTime = oldTime - (endTime - startTime);
      } else if (oldTime > startTime) {
        mappedTime = startTime;
      }

      mappedTime = clamp(mappedTime, 0, newWaveformData.duration);

      this.audioBufferData = newBuffer;
      this.waveformData = newWaveformData;

      this.renderer.setZoomInterval(Number(this.zoomSelect.value));
      this.renderer.setData(newWaveformData);

      this.setAudioSource(wavBlob, mappedTime);
      this.selectionRange = null;
      this.dragState = null;
      this.activeHandle = null;
      this.hoverTime = null;
      this.tooltip.hidden = true;

      this.renderer.scrollToTime(mappedTime);
      this.updateTimeView(mappedTime, newWaveformData.duration);
      this.updateSelectionInfo(null);
      this.updateControlAvailability();
      this.renderFrame();
      this.pushUndoSnapshot(beforeCutSnapshot);

      this.metaText.textContent =
        `長さ: ${newWaveformData.duration.toFixed(2)}秒 / サンプルレート: ${newWaveformData.sampleRate}Hz / ` +
        `チャンネル: ${newWaveformData.channelCount} / ブロック数: ${newWaveformData.blockCount}`;
      this.setStatus(`カット完了: ${(endTime - startTime).toFixed(2)}秒を削除しました。`);

      if (wasPlaying) {
        await this.audio.play().catch(() => {
          // 再生失敗時はUIのみ更新
        });
      }
    } catch (error) {
      this.setStatus("カット処理に失敗しました。", true);
      this.metaText.textContent = String(error);
    } finally {
      this.updateControlAvailability();
    }
  }

  async handleExportMp3() {
    if (!this.audioBufferData) {
      this.setStatus("先に音声を読み込んでください。", true);
      return;
    }

    try {
      this.setStatus("MP3を書き出し中です...");
      const mp3Blob = audioBufferToMp3Blob(this.audioBufferData, 128);
      const fileName = buildEditedFileName(this.currentFileName);

      const url = URL.createObjectURL(mp3Blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      this.setStatus(`MP3を書き出しました: ${fileName}`);
    } catch (error) {
      this.setStatus("MP3書き出しに失敗しました。", true);
      this.metaText.textContent = String(error);
    }
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

      const { audioBuffer, waveformData } = await this.analyzer.analyzeFile(file);

      this.currentFileName = file.name;
      this.audioBufferData = audioBuffer;
      this.waveformData = waveformData;
      this.clearHistory();
      this.renderer.setZoomInterval(Number(this.zoomSelect.value));
      this.renderer.setData(waveformData);

      this.setAudioSource(file, 0);
      this.renderer.scrollToTime(0);

      this.updateTimeView(0, waveformData.duration);
      this.hoverTime = null;
      this.selectionRange = null;
      this.dragState = null;
      this.activeHandle = null;
      this.tooltip.hidden = true;
      this.updateSelectionInfo(null);
      this.renderFrame();

      this.metaText.textContent =
        `長さ: ${waveformData.duration.toFixed(2)}秒 / サンプルレート: ${waveformData.sampleRate}Hz / ` +
        `チャンネル: ${waveformData.channelCount} / ブロック数: ${waveformData.blockCount}`;

      this.setStatus("解析完了。クリックで再生位置移動、ドラッグで区間選択、端点ドラッグで調整できます。");
    } catch (error) {
      this.waveformData = null;
      this.audioBufferData = null;
      this.currentFileName = "";
      this.renderer.clearData();
      this.clearAudioSource();
      this.updateTimeView(0, 0);
      this.setStatus("解析に失敗しました。mp3ファイルを確認してください。", true);
      this.metaText.textContent = String(error);
      this.selectionRange = null;
      this.dragState = null;
      this.activeHandle = null;
      this.clearHistory();
      this.updateSelectionInfo(null);
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
    if (!this.waveformData || this.dragState) {
      return;
    }

    this.hoverTime = this.renderer.timeFromPointerEvent(event);
    this.tooltip.hidden = false;
    this.tooltip.style.left = `${this.renderer.viewportXFromEvent(event)}px`;
    this.tooltip.textContent = formatTime(this.hoverTime);

    this.renderFrame();
  }

  setAudioSource(mediaSource, seekTime = 0) {
    this.clearAudioSource();
    this.currentObjectUrl = URL.createObjectURL(mediaSource);
    this.audio.src = this.currentObjectUrl;
    this.pendingSeekTime = seekTime;
    this.audio.load();
  }

  clearAudioSource() {
    this.audio.pause();

    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = "";
    }

    this.pendingSeekTime = null;

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
    const activeSelection = this.getActiveSelectionRange();
    this.renderer.renderOverlay(playTime, this.hoverTime, activeSelection, this.activeHandle);
    this.renderer.renderMiniMap(playTime);
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
      this.cutButton.disabled = true;
      this.exportButton.disabled = true;
      this.undoButton.disabled = true;
      this.redoButton.disabled = true;
      this.stopRenderLoop();
      this.audio.pause();
      return;
    }

    this.analyzeButton.disabled = !this.getSelectedFile();
    this.updateControlAvailability();
    this.updateHistoryButtons();
  }

  updateControlAvailability() {
    const ready = !!this.waveformData && !!this.audio.src;

    if (!ready) {
      this.playButton.disabled = true;
      this.pauseButton.disabled = true;
      this.stopButton.disabled = true;
      this.cutButton.disabled = true;
      this.exportButton.disabled = true;
      this.updateHistoryButtons();
      return;
    }

    this.playButton.disabled = this.isPlaying();
    this.pauseButton.disabled = !this.isPlaying();
    this.stopButton.disabled = !this.isPlaying() && this.audio.currentTime <= 0;
    this.cutButton.disabled = !this.selectionRange;
    this.exportButton.disabled = false;
    this.updateHistoryButtons();
  }

  setStatus(message, isError = false) {
    this.statusText.textContent = message;
    this.statusText.style.color = isError ? "#b30024" : "#12233a";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new WaveformApp();
});




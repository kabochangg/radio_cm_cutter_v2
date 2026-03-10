function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildMiniPeaks(minValues, maxValues, minimapBins) {
  const blockCount = minValues.length;

  if (blockCount === 0) {
    return new Float32Array(0);
  }

  const bins = Math.max(1, Math.min(minimapBins || 2048, blockCount));
  const peaks = new Float32Array(bins);
  const blocksPerBin = blockCount / bins;

  for (let i = 0; i < bins; i += 1) {
    const start = Math.floor(i * blocksPerBin);
    const end = Math.max(start + 1, Math.floor((i + 1) * blocksPerBin));

    let peak = 0;

    for (let b = start; b < end && b < blockCount; b += 1) {
      const localPeak = Math.max(Math.abs(minValues[b]), Math.abs(maxValues[b]));

      if (localPeak > peak) {
        peak = localPeak;
      }
    }

    peaks[i] = peak;
  }

  return peaks;
}

function buildWaveformFromChannels(channels, sampleRate, blockSize, minimapBins) {
  const channelCount = channels.length;
  const totalSamples = channels[0] ? channels[0].length : 0;
  const safeBlockSize = Math.max(1, blockSize | 0);

  const blockCount = Math.ceil(totalSamples / safeBlockSize);
  const minValues = new Float32Array(blockCount);
  const maxValues = new Float32Array(blockCount);

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const start = blockIndex * safeBlockSize;
    const end = Math.min(start + safeBlockSize, totalSamples);

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

  const miniPeaks = buildMiniPeaks(minValues, maxValues, minimapBins);

  return {
    duration: sampleRate > 0 ? totalSamples / sampleRate : 0,
    sampleRate,
    channelCount,
    blockSize: safeBlockSize,
    blockCount,
    minValuesBuffer: minValues.buffer,
    maxValuesBuffer: maxValues.buffer,
    miniPeaksBuffer: miniPeaks.buffer,
  };
}

function toFloat32Channels(channelBuffers, expectedChannelCount) {
  const channels = [];
  const count = Math.max(0, expectedChannelCount | 0);

  for (let ch = 0; ch < count; ch += 1) {
    channels.push(new Float32Array(channelBuffers[ch]));
  }

  return channels;
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const { requestId, type, payload } = data;

  try {
    if (type === "build-waveform") {
      const channels = toFloat32Channels(payload.channelBuffers || [], payload.channelCount || 0);
      const waveform = buildWaveformFromChannels(
        channels,
        payload.sampleRate || 0,
        payload.blockSize || 256,
        payload.minimapBins || 2048
      );

      self.postMessage(
        {
          requestId,
          ok: true,
          result: waveform,
        },
        [waveform.minValuesBuffer, waveform.maxValuesBuffer, waveform.miniPeaksBuffer]
      );
      return;
    }

    if (type === "cut-segment") {
      const sampleRate = payload.sampleRate || 0;
      const channelCount = payload.channelCount || 0;
      const channels = toFloat32Channels(payload.channelBuffers || [], channelCount);
      const totalSamples = payload.length || (channels[0] ? channels[0].length : 0);

      const startSample = clamp(payload.startSample | 0, 0, totalSamples);
      const endSample = clamp(payload.endSample | 0, startSample, totalSamples);
      const removedSamples = endSample - startSample;
      const newLength = totalSamples - removedSamples;

      if (newLength <= 0) {
        throw new Error("音声全体が削除対象です。");
      }

      const newChannels = [];

      for (let ch = 0; ch < channels.length; ch += 1) {
        const src = channels[ch];
        const out = new Float32Array(newLength);

        out.set(src.subarray(0, startSample), 0);
        out.set(src.subarray(endSample), startSample);
        newChannels.push(out);
      }

      const waveformData = buildWaveformFromChannels(
        newChannels,
        sampleRate,
        payload.blockSize || 256,
        payload.minimapBins || 2048
      );

      const channelBuffers = newChannels.map((channel) => channel.buffer);

      self.postMessage(
        {
          requestId,
          ok: true,
          result: {
            sampleRate,
            channelCount: newChannels.length,
            length: newLength,
            channelBuffers,
            waveformData,
          },
        },
        [...channelBuffers, waveformData.minValuesBuffer, waveformData.maxValuesBuffer, waveformData.miniPeaksBuffer]
      );
      return;
    }

    throw new Error(`未知のWorker処理: ${type}`);
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
});

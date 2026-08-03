export class AudioEngine {
    constructor() {
        this.audioCtx = null;
        this.previewSource = null;
    }

    initContext() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        return this.audioCtx;
    }

    async decodeFile(file) {
        this.initContext();
        try {
            const arrayBuffer = await file.arrayBuffer();
            return await this.audioCtx.decodeAudioData(arrayBuffer);
        } catch (err) {
            console.error('AudioEngine decode error:', err);
            throw new Error(`Failed to decode audio: ${err.message || 'Unknown format'}`);
        }
    }

    async renderHybridBuffer(playlist, trackABuffer, trackBBuffer) {
        if (playlist.length === 0) return null;

        const sampleRate = trackABuffer ? trackABuffer.sampleRate : (trackBBuffer ? trackBBuffer.sampleRate : 44100);
        const totalDuration = playlist.reduce((acc, reg) => acc + (reg.end - reg.start), 0);
        
        const offlineCtx = new OfflineAudioContext(2, Math.max(1, Math.floor(totalDuration * sampleRate)), sampleRate);
        
        let currentOffset = 0;
        
        for (const segment of playlist) {
            const buffer = segment.trackId === 'A' ? trackABuffer : trackBBuffer;
            if (!buffer) continue;

            const source = offlineCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(offlineCtx.destination);
            
            const segmentDuration = segment.end - segment.start;
            source.start(currentOffset, segment.start, segmentDuration);
            currentOffset += segmentDuration;
        }
        
        return await offlineCtx.startRendering();
    }

    cloneBuffer(buffer) {
        const out = this.initContext().createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        for (let i = 0; i < buffer.numberOfChannels; i++) {
            out.copyToChannel(buffer.getChannelData(i), i);
        }
        return out;
    }

    cutBuffer(buffer, startSec, endSec) {
        const sampleRate = buffer.sampleRate;
        const startSample = Math.floor(startSec * sampleRate);
        const endSample = Math.floor(endSec * sampleRate);
        const cutLength = endSample - startSample;
        
        if (cutLength <= 0) return buffer;

        const newLength = buffer.length - cutLength;
        const newBuffer = this.initContext().createBuffer(buffer.numberOfChannels, newLength, sampleRate);

        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const oldData = buffer.getChannelData(channel);
            const newData = newBuffer.getChannelData(channel);
            
            newData.set(oldData.subarray(0, startSample));
            newData.set(oldData.subarray(endSample), startSample);
        }

        return newBuffer;
    }

    stopPreview() {
        if (this.previewSource) {
            try { this.previewSource.stop(); } catch(e) {}
            this.previewSource = null;
        }
    }

    playBuffer(buffer) {
        this.stopPreview();
        const ctx = this.initContext();
        
        this.previewSource = ctx.createBufferSource();
        this.previewSource.buffer = buffer;
        this.previewSource.connect(ctx.destination);
        this.previewSource.start(0);
        return this.previewSource;
    }

    audioBufferToWav(buffer) {
        const numOfChan = buffer.numberOfChannels,
            length = buffer.length * numOfChan * 2 + 44,
            bufferNew = new ArrayBuffer(length),
            view = new DataView(bufferNew),
            channels = [], 
            sampleRate = buffer.sampleRate;
        
        let i, sample, offset = 0, pos = 0;

        const setUint16 = (data) => { view.setUint16(pos, data, true); pos += 2; };
        const setUint32 = (data) => { view.setUint32(pos, data, true); pos += 4; };

        setUint32(0x46464952); // "RIFF"
        setUint32(length - 8); 
        setUint32(0x45564157); // "WAVE"

        setUint32(0x20746d66); // "fmt " chunk
        setUint32(16); 
        setUint16(1); // PCM
        setUint16(numOfChan);
        setUint32(sampleRate);
        setUint32(sampleRate * 2 * numOfChan);
        setUint16(numOfChan * 2);
        setUint16(16);

        setUint32(0x61746164); // "data"
        setUint32(length - pos - 4);

        for(i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));

        while(pos < length) {
            for(i = 0; i < numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][offset]));
                sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF) | 0;
                view.setInt16(pos, sample, true);
                pos += 2;
            }
            offset++;
        }

        return new Blob([bufferNew], { type: 'audio/wav' });
    }

    async audioBufferToMp3(buffer, kbps = 128) {
        const channels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
        const mp3Data = [];

        const left = buffer.getChannelData(0);
        const right = channels > 1 ? buffer.getChannelData(1) : left;


        const convertToInt16 = (float32Array) => {
            const int16Array = new Int16Array(float32Array.length);
            for (let i = 0; i < float32Array.length; i++) {
                let s = Math.max(-1, Math.min(1, float32Array[i]));
                int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            return int16Array;
        };

        const lInt16 = convertToInt16(left);
        const rInt16 = convertToInt16(right);

        const sampleBlockSize = 1152;
        for (let i = 0; i < lInt16.length; i += sampleBlockSize) {
            const lChunk = lInt16.subarray(i, i + sampleBlockSize);
            const rChunk = rInt16.subarray(i, i + sampleBlockSize);
            const mp3buf = mp3encoder.encodeBuffer(lChunk, rChunk);
            if (mp3buf.length > 0) {
                mp3Data.push(mp3buf);
            }
        }

        const mp3Last = mp3encoder.flush();
        if (mp3Last.length > 0) {
            mp3Data.push(mp3Last);
        }

        return new Blob(mp3Data, { type: 'audio/mp3' });
    }
}

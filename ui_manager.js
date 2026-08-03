import { AudioEngine } from './audio_engine.js';

const App = {
    engine: new AudioEngine(),
    tracks: {
        A: { ws: null, regions: null, buffer: null, color: '#14b8a6', last_cut_point: 0 },
        B: { ws: null, regions: null, buffer: null, color: '#8b5cf6', last_cut_point: 0 }
    },
    hybrid: { ws: null, regions: null, buffer: null, isEditing: false, undoStack: [] },
    playlist: [],
    isRendering: false
};

function logDebug(msg) {
    const log = document.getElementById('debug-log');
    if (!log) return;
    const time = new Date().toLocaleTimeString();
    log.innerHTML += `<div><span style="color:#555">[${time}]</span> ${msg}</div>`;
    log.scrollTop = log.scrollHeight;
}

function showError(msg) {
    logDebug(`ERROR: ${msg}`);
    const toast = document.getElementById('error-toast');
    const message = document.getElementById('error-message');
    if (message) message.innerText = msg;
    if (toast) {
        toast.style.display = 'flex';
        setTimeout(() => {
            toast.style.display = 'none';
        }, 8000);
    }
}

function initWavesurfer(id, container, color, height = 128) {
    try {
        const ws = WaveSurfer.create({
            container: container,
            waveColor: '#27272a',
            progressColor: color,
            cursorColor: '#fff',
            height: height,
            normalize: true,
            interact: true
        });

        const regions = ws.registerPlugin(WaveSurfer.Regions.create());
        logDebug(`Wavesurfer ${id} initialized.`);
        return { ws, regions };
    } catch (e) {
        logDebug(`Critical Error: WaveSurfer init failed for ${id}: ${e.message}`);
        return null;
    }
}

async function handleFile(id, file) {
    if (!file) return;
    App.engine.initContext();
    logDebug(`File selected for Track ${id}: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    
    const status = document.getElementById('global-status');
    if (status) status.innerText = `Analyzing Track ${id}...`;
    
    try {
        logDebug(`Decoding Track ${id}...`);
        const buffer = await App.engine.decodeFile(file);
        App.tracks[id].buffer = buffer;
        App.tracks[id].last_cut_point = 0;
        App.tracks[id].regions.clearRegions();
        
        logDebug(`Track ${id} decoded. Duration: ${buffer.duration.toFixed(2)}s. Loading waveform...`);
        const audioUrl = URL.createObjectURL(file);
        await App.tracks[id].ws.load(audioUrl);
        
        if (status) status.innerText = `Track ${id} Loaded`;
        const endInput = document.getElementById(`precise-end-${id.toLowerCase()}`);
        if (endInput) endInput.value = buffer.duration.toFixed(1);
        
        logDebug(`Track ${id} ready.`);
    } catch (e) {
        if (status) status.innerText = "Error";
        showError(`Failed to load ${file.name}: ${e.message}`);
    }
}

function sliceToQueue(trackId, manualRange = null) {
    const track = App.tracks[trackId];
    if (!track.buffer) {
        showError("Please load an audio file first.");
        return;
    }

    let start, end;
    if (manualRange) {
        start = manualRange.start;
        end = manualRange.end;
    } else {
        start = track.last_cut_point;
        end = track.ws.getCurrentTime();
    }

    if (end <= start) {
        showError("Invalid range selection: End time must be after start time.");
        return;
    }

    track.regions.addRegion({
        start: start,
        end: end,
        color: track.color + '44',
        drag: false,
        resize: false,
        id: `slice-${Date.now()}`
    });

    const segment = {
        id: Date.now() + Math.random(),
        trackId: trackId,
        start: start,
        end: end,
        label: `Source ${trackId === 'A' ? '1' : '2'}`
    };

    App.playlist.push(segment);
    if (!manualRange) track.last_cut_point = end;

    logDebug(`Added slice: Source ${trackId}, ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
    updateTimelineUI();
    updateHybridPreview();
}

async function updateHybridPreview(fromEditing = false) {
    if (App.playlist.length === 0 && !fromEditing) {
        App.hybrid.ws.empty();
        document.getElementById('hybrid-status').innerText = "Empty sequencer";
        return;
    }
    
    if (App.isRendering) return;
    App.isRendering = true;
    const statusLabel = document.getElementById('hybrid-status');
    if (statusLabel) statusLabel.innerText = fromEditing ? "Updating buffer..." : "Rebuilding preview...";

    try {
        if (!fromEditing) {
            logDebug("Rendering hybrid buffer...");
            const buffer = await App.engine.renderHybridBuffer(App.playlist, App.tracks.A.buffer, App.tracks.B.buffer);
            App.hybrid.buffer = buffer;
            App.hybrid.undoStack = [];
            updateUndoBtn();
        }

        if (App.hybrid.buffer) {
            const wavBlob = App.engine.audioBufferToWav(App.hybrid.buffer);
            const url = URL.createObjectURL(wavBlob);
            await App.hybrid.ws.load(url);
            if (statusLabel) statusLabel.innerText = "Preview updated";
            logDebug("Hybrid preview updated.");
        }
    } catch (e) {
        logDebug(`Render error: ${e.message}`);
        if (statusLabel) statusLabel.innerText = "Update failed";
    } finally {
        App.isRendering = false;
    }
}

function updateUndoBtn() {
    const btn = document.getElementById('undo-hybrid');
    if (btn) btn.disabled = App.hybrid.undoStack.length === 0;
}

function cutHybridSelection() {
    const activeRegions = App.hybrid.regions.getRegions();
    if (activeRegions.length === 0) {
        showError("Please select a region to cut first.");
        return;
    }

    const region = activeRegions[0];
    const { start, end } = region;

    App.hybrid.undoStack.push(App.engine.cloneBuffer(App.hybrid.buffer));
    updateUndoBtn();

    App.hybrid.buffer = App.engine.cutBuffer(App.hybrid.buffer, start, end);
    
    App.hybrid.regions.clearRegions();
    logDebug(`Cut from hybrid: ${start.toFixed(2)}s to ${end.toFixed(2)}s`);
    updateHybridPreview(true);
}

function toggleHybridEditing() {
    App.hybrid.isEditing = !App.hybrid.isEditing;
    const btn = document.getElementById('toggle-edit-hybrid');
    const delBtn = document.getElementById('delete-region-hybrid');
    const waveContainer = document.getElementById('wave-hybrid-container');

    if (App.hybrid.isEditing) {
        btn.classList.replace('bg-zinc-800', 'bg-red-600');
        btn.querySelector('span').innerText = "Editing Mode ON";
        delBtn.classList.remove('hidden');
        waveContainer.classList.add('edit-active');
        App.hybrid.ws.setOptions({ interact: true });
        logDebug("Hybrid editing enabled.");
    } else {
        btn.classList.replace('bg-red-600', 'bg-zinc-800');
        btn.querySelector('span').innerText = "Enable Editing";
        delBtn.classList.add('hidden');
        waveContainer.classList.remove('edit-active');
        App.hybrid.regions.clearRegions();
        logDebug("Hybrid editing disabled.");
    }
}

function interleavePlaylist() {
    if (App.playlist.length < 2) return;
    const trackAItems = App.playlist.filter(item => item.trackId === 'A').sort((a, b) => a.start - b.start);
    const trackBItems = App.playlist.filter(item => item.trackId === 'B').sort((a, b) => a.start - b.start);
    const interleaved = [];
    const maxLength = Math.max(trackAItems.length, trackBItems.length);
    for (let i = 0; i < maxLength; i++) {
        if (trackAItems[i]) interleaved.push(trackAItems[i]);
        if (trackBItems[i]) interleaved.push(trackBItems[i]);
    }
    App.playlist = interleaved;
    logDebug("Playlist auto-interleaved.");
    updateTimelineUI();
    updateHybridPreview();
}

function updateTimelineUI() {
    const list = document.getElementById('timeline-list');
    if (App.playlist.length === 0) {
        list.innerHTML = `<div class="timeline-empty py-16 text-center text-zinc-600"><p class="text-xs italic">Sliced segments appear here.</p></div>`;
        return;
    }

    list.innerHTML = App.playlist.map((item, index) => {
        const trackColor = item.trackId === 'A' ? 'border-teal-500/50' : 'border-violet-500/50';
        const colorClass = item.trackId === 'A' ? 'text-teal-400' : 'text-violet-400';
        return `
        <div data-playlist-id="${item.id}" class="playlist-item flex items-center gap-2 p-2 rounded-xl bg-zinc-800/80 border-l-4 ${trackColor} shadow-sm group">
            <div class="flex flex-col gap-1 items-center justify-center px-1">
                <button class="move-up-btn text-zinc-500 hover:text-white" data-index="${index}"><i data-lucide="chevron-up" class="w-3 h-3"></i></button>
                <button class="move-down-btn text-zinc-500 hover:text-white" data-index="${index}"><i data-lucide="chevron-down" class="w-3 h-3"></i></button>
            </div>
            <div class="flex-grow">
                <div class="flex justify-between items-center">
                    <span class="text-[9px] font-black uppercase tracking-widest ${colorClass}">${item.trackId === 'A' ? 'SOURCE 1' : 'SOURCE 2'}</span>
                    <span class="text-[9px] font-mono text-zinc-500">${(item.end - item.start).toFixed(1)}s</span>
                </div>
                <div class="text-[10px] font-mono text-zinc-400">
                    ${formatTime(item.start)} → ${formatTime(item.end)}
                </div>
            </div>
            <button class="remove-btn p-2 text-zinc-500 hover:text-red-400" data-id="${item.id}">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
        </div>`;
    }).join('');

    lucide.createIcons();
    
    list.querySelectorAll('.remove-btn').forEach(btn => {
        btn.onclick = () => {
            const id = parseFloat(btn.dataset.id);
            App.playlist = App.playlist.filter(p => p.id !== id);
            updateTimelineUI();
            updateHybridPreview();
        };
    });

    list.querySelectorAll('.move-up-btn').forEach(btn => {
        btn.onclick = () => {
            const index = parseInt(btn.dataset.index);
            if (index > 0) {
                [App.playlist[index-1], App.playlist[index]] = [App.playlist[index], App.playlist[index-1]];
                updateTimelineUI();
                updateHybridPreview();
            }
        };
    });

    list.querySelectorAll('.move-down-btn').forEach(btn => {
        btn.onclick = () => {
            const index = parseInt(btn.dataset.index);
            if (index < App.playlist.length - 1) {
                [App.playlist[index+1], App.playlist[index]] = [App.playlist[index], App.playlist[index+1]];
                updateTimelineUI();
                updateHybridPreview();
            }
        };
    });
}

function formatTime(seconds) {
    if (isNaN(seconds)) return "00:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;
}

document.addEventListener('DOMContentLoaded', () => {
    logDebug("UI Loaded. Waiting for user interaction...");
    lucide.createIcons();

    const trackA = initWavesurfer('A', '#wave-a', App.tracks.A.color);
    const trackB = initWavesurfer('B', '#wave-b', App.tracks.B.color);
    const hybrid = initWavesurfer('H', '#wave-hybrid', '#ffffff', 96);
    
    if (trackA) { App.tracks.A.ws = trackA.ws; App.tracks.A.regions = trackA.regions; }
    if (trackB) { App.tracks.B.ws = trackB.ws; App.tracks.B.regions = trackB.regions; }
    if (hybrid) { App.hybrid.ws = hybrid.ws; App.hybrid.regions = hybrid.regions; }

    new Sortable(document.getElementById('timeline-list'), {
        animation: 150,
        ghostClass: 'sortable-ghost',
        onEnd: () => {
            const reordered = [];
            const items = document.getElementById('timeline-list').querySelectorAll('.playlist-item');
            items.forEach(el => {
                const id = parseFloat(el.dataset.playlistId);
                const item = App.playlist.find(p => p.id === id);
                if (item) reordered.push(item);
            });
            App.playlist = reordered;
            updateHybridPreview();
        }
    });

    document.getElementById('file-a').addEventListener('change', (e) => handleFile('A', e.target.files[0]));
    document.getElementById('file-b').addEventListener('change', (e) => handleFile('B', e.target.files[0]));
    
    document.getElementById('slice-a').onclick = () => sliceToQueue('A');
    document.getElementById('slice-b').onclick = () => sliceToQueue('B');

    document.getElementById('precise-add-a').onclick = () => {
        const start = parseFloat(document.getElementById('precise-start-a').value);
        const end = parseFloat(document.getElementById('precise-end-a').value);
        sliceToQueue('A', { start, end });
    };
    document.getElementById('precise-add-b').onclick = () => {
        const start = parseFloat(document.getElementById('precise-start-b').value);
        const end = parseFloat(document.getElementById('precise-end-b').value);
        sliceToQueue('B', { start, end });
    };

    document.getElementById('play-a').onclick = () => { App.engine.initContext(); trackA.ws.playPause(); };
    document.getElementById('play-b').onclick = () => { App.engine.initContext(); trackB.ws.playPause(); };
    document.getElementById('play-hybrid').onclick = () => { App.engine.initContext(); hybrid.ws.playPause(); };

    if (trackA) trackA.ws.on('timeupdate', (t) => { document.getElementById('time-a').innerText = `${formatTime(t)} / ${formatTime(trackA.ws.getDuration())}`; });
    if (trackB) trackB.ws.on('timeupdate', (t) => { document.getElementById('time-b').innerText = `${formatTime(t)} / ${formatTime(trackB.ws.getDuration())}`; });
    if (hybrid) hybrid.ws.on('timeupdate', (t) => { document.getElementById('time-hybrid').innerText = `${formatTime(t)} / ${formatTime(hybrid.ws.getDuration())}`; });

    document.getElementById('toggle-edit-hybrid').onclick = () => toggleHybridEditing();
    document.getElementById('delete-region-hybrid').onclick = () => cutHybridSelection();
    document.getElementById('undo-hybrid').onclick = () => {
        if (App.hybrid.undoStack.length > 0) {
            App.hybrid.buffer = App.hybrid.undoStack.pop();
            updateHybridPreview(true);
            updateUndoBtn();
        }
    };

    if (App.hybrid.regions) {
        App.hybrid.regions.on('region-created', (region) => {
            if (!App.hybrid.isEditing) {
                region.remove();
                return;
            }
            App.hybrid.regions.clearRegions();
            region.setOptions({ color: 'rgba(239, 68, 68, 0.4)' });
        });
    }

    document.getElementById('clear-playlist').onclick = () => { 
        App.playlist = []; 
        App.tracks.A.last_cut_point = 0;
        App.tracks.B.last_cut_point = 0;
        App.tracks.A.regions.clearRegions();
        App.tracks.B.regions.clearRegions();
        App.hybrid.undoStack = [];
        updateTimelineUI(); 
        updateHybridPreview();
        logDebug("Sequencer cleared.");
    };

    document.getElementById('auto-interleave').onclick = () => interleavePlaylist();

    document.getElementById('export-wav').onclick = async () => {
        if (!App.hybrid.buffer) return;
        App.engine.initContext();
        try {
            logDebug("Generating WAV export...");
            const blob = App.engine.audioBufferToWav(App.hybrid.buffer);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `hybrid_mix_${Date.now()}.wav`; a.click();
            logDebug("WAV export triggered.");
        } catch (e) { showError(`Export failed: ${e.message}`); }
    };

    document.getElementById('export-mp3').onclick = async () => {
        if (!App.hybrid.buffer) return;
        App.engine.initContext();
        const btn = document.getElementById('export-mp3');
        btn.classList.add('processing');
        btn.disabled = true;

        try {
            logDebug("Starting MP3 encoding...");
            await new Promise(r => setTimeout(r, 100));
            const blob = await App.engine.audioBufferToMp3(App.hybrid.buffer, 128);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `hybrid_mix_${Date.now()}.mp3`; a.click();
            logDebug("MP3 encoding complete.");
        } catch (e) { 
            showError(`MP3 Export failed: ${e.message}`); 
        } finally {
            btn.classList.remove('processing');
            btn.disabled = false;
        }
    };

    const modal = document.getElementById('onboarding-modal');
    if (!localStorage.getItem('hide-hybrid-onboarding')) modal.classList.remove('hidden');
    document.getElementById('close-onboarding').onclick = () => {
        if (document.getElementById('dont-show-again').checked) localStorage.setItem('hide-hybrid-onboarding', 'true');
        modal.classList.add('hidden');
        App.engine.initContext();
    };
    document.getElementById('help-btn').onclick = () => modal.classList.remove('hidden');
});

// ═══════════════════════════════════════════════════════
//  ⚙  CONFIGURATION — set this to your FastAPI server
// ═══════════════════════════════════════════════════════
const API_BASE_URL = 'http://localhost:8000';   // ← change this for production
const POLL_INTERVAL_MS = 3000;                  // how often to poll job status (ms)

// ── DOM refs ──
const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const filePreview   = document.getElementById('file-preview');
const fileNameEl    = document.getElementById('file-name-display');
const fileMetaEl    = document.getElementById('file-meta-display');
const fileRemoveBtn = document.getElementById('file-remove-btn');
const submitBtn     = document.getElementById('submit-btn');
const resetBtn      = document.getElementById('reset-btn');
const uploadPanel   = document.getElementById('upload-panel');
const progressPanel = document.getElementById('progress-panel');
const resultPanel   = document.getElementById('result-panel');
const jobIdEl       = document.getElementById('job-id-display');
const progressBar   = document.getElementById('progress-bar');
const logBox        = document.getElementById('log-box');
const downloadBtn   = document.getElementById('download-btn');

let selectedFile = null;
let pollTimer    = null;

// ── File selection ──
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) attachFile(fileInput.files[0]); });

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) attachFile(e.dataTransfer.files[0]);
});

fileRemoveBtn.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  filePreview.style.display = 'none';
  submitBtn.disabled = true;
});

function attachFile(file) {
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileMetaEl.textContent = `${(file.size / 1048576).toFixed(1)} MB · ${file.type || 'video'}`;
  filePreview.style.display = 'flex';
  submitBtn.disabled = false;
}

// ── Submit ──
submitBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  uploadPanel.style.display = 'none';
  progressPanel.style.display = 'block';
  await processVideo();
});

async function processVideo() {
  const quality = document.getElementById('output-quality').value;

  try {
    // ── STEP 1: Upload ──
    setStage('stage-upload', 'active', 'UPLOADING');
    addLog('Uploading video to S3 via API gateway...');
    setProgress(10);

    const formData = new FormData();
    formData.append('file', selectedFile);
    formData.append('interp_factor', '2');
    formData.append('quality', quality);

    const uploadRes = await fetch(`${API_BASE_URL}/api/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);
    const { job_id } = await uploadRes.json();

    setStage('stage-upload', 'done', 'COMPLETE');
    jobIdEl.textContent = job_id;
    addLog(`Job registered: ${job_id}`, 'accent');
    setProgress(25);

    // ── STEP 2-5: Poll ──
    setStage('stage-queue', 'active', 'WAITING');
    addLog('Job placed in SageMaker processing queue...');

    await pollJobStatus(job_id);

  } catch (err) {
    addLog(`ERROR: ${err.message}`, 'err');
    console.error(err);
  }
}

async function pollJobStatus(jobId) {
  return new Promise((resolve, reject) => {
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/job/${jobId}`);
        if (!res.ok) { addLog(`Poll error: ${res.status}`, 'warn'); return; }

        const data = await res.json();
        handleStatusUpdate(data, resolve, reject, jobId);
      } catch (e) {
        addLog(`Network error: ${e.message}`, 'warn');
      }
    }, POLL_INTERVAL_MS);
  });
}

function handleStatusUpdate(data, resolve, reject, jobId) {
  const { status, progress, message, result } = data;

  // Update log
  if (message) addLog(message);

  // Map status → stage UI
  const statusMap = {
    queued:        { stage: 'stage-queue',      label: 'QUEUED',    pct: 25  },
    preprocessing: { stage: 'stage-preprocess', label: 'RUNNING',   pct: 45  },
    inference:     { stage: 'stage-inference',  label: 'RUNNING',   pct: 70  },
    exporting:     { stage: 'stage-export',     label: 'EXPORTING', pct: 88  },
    done:          { stage: 'stage-export',     label: 'COMPLETE',  pct: 100 },
    failed:        { stage: null,               label: 'FAILED',    pct: null },
  };

  const entry = statusMap[status];
  if (!entry) return;

  setProgress(progress ?? entry.pct);

  // Mark previous stages done
  const stageOrder = ['stage-upload', 'stage-queue', 'stage-preprocess', 'stage-inference', 'stage-export'];
  const currentIdx = stageOrder.indexOf(entry.stage);
  stageOrder.forEach((s, i) => {
    if (i < currentIdx) setStage(s, 'done', 'DONE');
  });
  if (entry.stage) setStage(entry.stage, 'active', entry.label);

  if (status === 'done') {
    clearInterval(pollTimer);
    stageOrder.forEach(s => setStage(s, 'done', 'DONE'));
    addLog('Enhancement complete. Video ready for download.', 'accent');
    setTimeout(() => showResult(result, jobId), 600);
    resolve();
  }

  if (status === 'failed') {
    clearInterval(pollTimer);
    addLog(`Pipeline failed: ${message}`, 'err');
    reject(new Error(message));
  }
}

function showResult(result, jobId) {
  progressPanel.style.display = 'none';
  resultPanel.style.display = 'block';

  document.getElementById('orig-fps').textContent      = result?.original_fps ?? '—';
  document.getElementById('enhanced-fps').textContent  = result?.enhanced_fps ?? '—';
  document.getElementById('frames-interp').textContent = result?.frames_added ?? '—';
  document.getElementById('psnr-score').textContent    = result?.psnr         ?? '—';

  // Download link — backend provides a pre-signed S3 URL or direct endpoint
  const downloadUrl = result?.download_url ?? `${API_BASE_URL}/api/download/${jobId}`;
  downloadBtn.href = downloadUrl;
  downloadBtn.setAttribute('download', `enhanced_${selectedFile?.name ?? 'video.mp4'}`);
}

resetBtn.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  filePreview.style.display = 'none';
  submitBtn.disabled = true;
  progressBar.style.width = '0%';
  logBox.innerHTML = '<span class="log-line accent">[FILM-SECURE] Pipeline initialised</span>';
  document.querySelectorAll('.stage').forEach(s => {
    s.className = 'stage';
    s.querySelector('.stage-bullet').style.cssText = '';
    s.querySelector('.stage-status').textContent = 'PENDING';
  });
  jobIdEl.textContent = '—';
  resultPanel.style.display = 'none';
  uploadPanel.style.display = 'block';
});

// ── Helpers ──
function setStage(id, state, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `stage ${state}`;
  el.querySelector('.stage-status').textContent = label;
}

function setProgress(pct) {
  progressBar.style.width = `${Math.min(100, pct)}%`;
}

function addLog(msg, cls = '') {
  const line = document.createElement('span');
  line.className = `log-line${cls ? ' ' + cls : ''}`;
  line.textContent = `[${timestamp()}] ${msg}`;
  logBox.appendChild(document.createElement('br'));
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function timestamp() {
  return new Date().toTimeString().slice(0, 8);
}
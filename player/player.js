/**
 * player/player.js
 * Standalone Theater Mode Media Player for Media Extractor PRO.
 * Handles direct streams, HLS, DASH, audio, full keyboard shortcuts, and background downloads.
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Parse URL query parameters
  const params = new URLSearchParams(window.location.search);
  const mediaUrl = params.get('url') || '';
  const mediaTitle = params.get('title') || 'Media Stream';
  const mediaType = (params.get('type') || 'video').toUpperCase();
  const sourcePage = params.get('source') || params.get('referrer') || '';
  const initialTime = parseFloat(params.get('t') || '0');

  // DOM Elements
  const video = $('mainVideoPlayer');
  const viewport = $('playerViewport');
  const bigPlayBtn = $('theaterBigPlayBtn');
  const playPauseBtn = $('theaterPlayPauseBtn');
  const rewindBtn = $('theaterRewindBtn');
  const forwardBtn = $('theaterForwardBtn');
  const seekSlider = $('theaterSeekSlider');
  const progressBar = $('theaterProgressBar');
  const bufferBar = $('theaterBufferBar');
  const timeDisplay = $('theaterTimeDisplay');
  const volumeBtn = $('theaterVolumeBtn');
  const volumeSlider = $('theaterVolumeSlider');
  const speedSelect = $('theaterSpeedSelect');
  const pipBtn = $('theaterPipBtn');
  const fitBtn = $('theaterFitBtn');
  const fullscreenBtn = $('theaterFullscreenBtn');
  const spinner = $('theaterSpinner');
  const copyUrlBtn = $('copyUrlBtn');
  const sourcePageBtn = $('sourcePageBtn');
  const downloadBtn = $('downloadBtn');
  const backToGrabberBtn = $('backToGrabberBtn');

  // Universal Preview Stage Elements
  const playerImageStage = $('playerImageStage');
  const imageCanvas = $('imageCanvas');
  const mainImageViewer = $('mainImageViewer');
  const imgZoomInBtn = $('imgZoomInBtn');
  const imgZoomOutBtn = $('imgZoomOutBtn');
  const imgZoomLevel = $('imgZoomLevel');
  const imgFitBtn = $('imgFitBtn');
  const imgActualBtn = $('imgActualBtn');
  const imgRotateBtn = $('imgRotateBtn');
  const playerDocStage = $('playerDocStage');
  const mainDocViewer = $('mainDocViewer');
  const docFallbackNotice = $('docFallbackNotice');
  const docFallbackTitle = $('docFallbackTitle');
  const docFallbackDownloadBtn = $('docFallbackDownloadBtn');
  const docFallbackOpenLink = $('docFallbackOpenLink');

  // State
  let isSeeking = false;
  let toastTimer = null;
  let hideControlsTimer = null;
  let lastVolume = 1;
  let isCoverFit = false;
  let currentZoom = 1;
  let currentRotation = 0;

  // Initialize UI Metadata
  document.title = `${mediaTitle} — Media Extractor PRO`;
  $('playerMediaTitle').textContent = mediaTitle;
  $('playerMediaTitle').title = mediaTitle;
  $('mediaTypeBadge').textContent = mediaType;
  $('streamUrlText').textContent = mediaUrl || 'No URL specified';
  $('streamUrlText').title = mediaUrl;

  if (sourcePage) {
    $('streamSourceText').textContent = sourcePage;
  } else {
    try {
      if (mediaUrl) $('streamSourceText').textContent = new URL(mediaUrl).hostname;
    } catch (_) {}
  }

  // Toast Helper
  function showToast(text) {
    if (!toast) return;
    toast.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 1400);
  }

  // Time Formatter
  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const remSec = String(s % 60).padStart(2, '0');
    const remMin = String(m % 60).padStart(2, '0');
    if (h > 0) return `${h}:${remMin}:${remSec}`;
    return `${remMin}:${remSec}`;
  }

  // Volume UI Update
  function updateVolumeUI() {
    if (volumeSlider) volumeSlider.value = video.muted ? 0 : video.volume;
    if (volumeBtn) {
      if (video.muted || video.volume === 0) volumeBtn.textContent = '🔇';
      else if (video.volume < 0.5) volumeBtn.textContent = '🔉';
      else volumeBtn.textContent = '🔊';
    }
  }

  // Toggle Play / Pause
  function togglePlay() {
    if (video.paused || video.ended) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  // Auto Hide Controls in Theater Mode
  function resetControlsHideTimer() {
    viewport.classList.remove('hide-controls');
    clearTimeout(hideControlsTimer);
    if (!video.paused) {
      hideControlsTimer = setTimeout(() => {
        if (!video.paused && !isSeeking) {
          viewport.classList.add('hide-controls');
        }
      }, 2800);
    }
  }

  viewport.addEventListener('mousemove', resetControlsHideTimer);
  viewport.addEventListener('mouseleave', () => {
    if (!video.paused) viewport.classList.add('hide-controls');
  });

  // Wire Controls
  if (playPauseBtn) playPauseBtn.onclick = togglePlay;
  if (bigPlayBtn) bigPlayBtn.onclick = togglePlay;

  if (video) {
    video.onclick = (e) => {
      if (e.target === video) togglePlay();
    };
  }

  if (rewindBtn) {
    rewindBtn.onclick = () => {
      video.currentTime = Math.max(0, video.currentTime - 10);
      showToast('⏪ -10s');
    };
  }

  if (forwardBtn) {
    forwardBtn.onclick = () => {
      const dur = video.duration || 0;
      video.currentTime = Math.min(dur, video.currentTime + 10);
      showToast('+10s ⏩');
    };
  }

  // Seeking
  if (seekSlider) {
    seekSlider.oninput = (e) => {
      isSeeking = true;
      const pct = parseFloat(e.target.value);
      if (progressBar) progressBar.style.width = pct + '%';
      const dur = video.duration || 0;
      if (dur > 0 && timeDisplay) {
        const cur = (pct / 100) * dur;
        timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
      }
    };

    seekSlider.onchange = (e) => {
      const pct = parseFloat(e.target.value);
      const dur = video.duration || 0;
      if (dur > 0) {
        video.currentTime = (pct / 100) * dur;
      }
      isSeeking = false;
    };
  }

  // Volume
  if (volumeBtn) {
    volumeBtn.onclick = () => {
      if (video.muted || video.volume === 0) {
        video.muted = false;
        video.volume = lastVolume > 0 ? lastVolume : 1;
      } else {
        lastVolume = video.volume;
        video.muted = true;
      }
      updateVolumeUI();
      showToast(video.muted ? 'Muted' : `Volume ${Math.round(video.volume * 100)}%`);
    };
  }

  if (volumeSlider) {
    volumeSlider.oninput = (e) => {
      const val = parseFloat(e.target.value);
      video.volume = val;
      video.muted = val === 0;
      if (val > 0) lastVolume = val;
      updateVolumeUI();
    };
  }

  // Playback Speed
  if (speedSelect) {
    speedSelect.onchange = (e) => {
      video.playbackRate = parseFloat(e.target.value);
      showToast(`Speed ${e.target.value}x`);
    };
  }

  // Picture in Picture
  if (pipBtn) {
    pipBtn.onclick = async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (document.pictureInPictureEnabled && video.readyState >= 1) {
          await video.requestPictureInPicture();
        }
      } catch (err) {
        showToast('PiP error: ' + err.message);
      }
    };
  }

  // Aspect Fit / Fill
  if (fitBtn) {
    fitBtn.onclick = () => {
      isCoverFit = !isCoverFit;
      if (isCoverFit) {
        viewport.classList.add('fit-cover');
        fitBtn.textContent = '><';
        showToast('Mode: Fill Screen');
      } else {
        viewport.classList.remove('fit-cover');
        fitBtn.textContent = '↔';
        showToast('Mode: Fit 16:9');
      }
    };
  }

  // Fullscreen
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      viewport.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  if (fullscreenBtn) {
    fullscreenBtn.onclick = toggleFullscreen;
  }

  // Video Events
  video.onplay = () => {
    if (playPauseBtn) playPauseBtn.textContent = '⏸';
    if (bigPlayBtn) bigPlayBtn.classList.add('hidden');
    resetControlsHideTimer();
  };

  video.onpause = () => {
    if (playPauseBtn) playPauseBtn.textContent = '▶';
    if (bigPlayBtn) bigPlayBtn.classList.remove('hidden');
    viewport.classList.remove('hide-controls');
  };

  video.onwaiting = () => {
    if (spinner) spinner.classList.remove('hidden');
  };

  video.onplaying = () => {
    if (spinner) spinner.classList.add('hidden');
  };

  video.oncanplay = () => {
    if (spinner) spinner.classList.add('hidden');
  };

  video.ontimeupdate = () => {
    if (isSeeking) return;
    const cur = video.currentTime || 0;
    const dur = video.duration || 0;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    if (progressBar) progressBar.style.width = pct + '%';
    if (seekSlider) seekSlider.value = pct;
    if (timeDisplay) {
      timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    }

    if (bufferBar && video.buffered && video.buffered.length > 0 && dur > 0) {
      try {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        const bufPct = Math.min(100, (bufferedEnd / dur) * 100);
        bufferBar.style.width = bufPct + '%';
      } catch (_) {}
    }
  };

  video.onloadedmetadata = () => {
    if (timeDisplay) {
      timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    }
    if (video.videoWidth && video.videoHeight) {
      $('streamResBadge').textContent = `${video.videoWidth}x${video.videoHeight}`;
    }
    if (initialTime > 0) {
      video.currentTime = initialTime;
    }
  };

  video.onended = () => {
    if (playPauseBtn) playPauseBtn.textContent = '▶';
    if (bigPlayBtn) bigPlayBtn.classList.remove('hidden');
    viewport.classList.remove('hide-controls');
  };

  // Header Actions
  if (copyUrlBtn) {
    copyUrlBtn.onclick = () => {
      navigator.clipboard.writeText(mediaUrl).then(() => {
        showToast('✓ URL Copied to clipboard');
      }).catch(() => {
        prompt('Copy stream URL:', mediaUrl);
      });
    };
  }

  if (sourcePageBtn) {
    sourcePageBtn.onclick = () => {
      if (sourcePage && /^https?:\/\//i.test(sourcePage)) {
        window.open(sourcePage, '_blank');
      } else {
        showToast('Source page unavailable');
      }
    };
  }

  function getFilenameForDownload(title, type, url) {
    let ext = '';
    try {
      const clean = (url || '').split('?')[0].split('#')[0];
      const m = clean.match(/\.([a-z0-9]{2,5})$/i);
      if (m) ext = m[1].toLowerCase();
    } catch (_) {}
    if (!ext) {
      if (type === 'IMAGE') ext = 'jpg';
      else if (type === 'DOC') ext = 'pdf';
      else if (type === 'AUDIO') ext = 'mp3';
      else ext = 'mp4';
    }
    const cleanTitle = (title || 'media').replace(/[\\/:*?"<>|]/g, '_');
    if (cleanTitle.toLowerCase().endsWith('.' + ext)) return cleanTitle;
    return `${cleanTitle}.${ext}`;
  }

  if (downloadBtn) {
    downloadBtn.onclick = () => {
      if (!mediaUrl) return;
      downloadBtn.disabled = true;
      downloadBtn.textContent = 'Starting…';

      const targetFilename = getFilenameForDownload(mediaTitle, mediaType, mediaUrl);

      // Send download request to background service worker
      chrome.runtime.sendMessage({
        type: 'DIRECT_DOWNLOAD',
        url: mediaUrl,
        filename: targetFilename
      }, (resp) => {
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = '<span class="btn-icon">⬇</span><span class="btn-text">Download</span>';
        if (resp && resp.ok) {
          showToast('✓ Download started!');
        } else {
          // Fallback: trigger standard browser download link
          const a = document.createElement('a');
          a.href = mediaUrl;
          a.download = targetFilename;
          a.target = '_blank';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          showToast('✓ Triggered download');
        }
      });
    };
  }

  if (backToGrabberBtn) {
    backToGrabberBtn.onclick = (e) => {
      e.preventDefault();
      const grabberUrl = chrome.runtime.getURL('grabber/grabber.html');
      window.location.href = grabberUrl;
    };
  }

  // Universal Image Stage Controls
  function updateImageTransform() {
    if (!mainImageViewer) return;
    mainImageViewer.style.transform = `scale(${currentZoom}) rotate(${currentRotation}deg)`;
    if (imgZoomLevel) imgZoomLevel.textContent = `${Math.round(currentZoom * 100)}%`;
  }

  if (imgZoomInBtn) {
    imgZoomInBtn.onclick = () => {
      currentZoom = Math.min(5, +(currentZoom + 0.25).toFixed(2));
      updateImageTransform();
    };
  }
  if (imgZoomOutBtn) {
    imgZoomOutBtn.onclick = () => {
      currentZoom = Math.max(0.15, +(currentZoom - 0.25).toFixed(2));
      updateImageTransform();
    };
  }
  if (imgFitBtn) {
    imgFitBtn.onclick = () => {
      currentZoom = 1;
      currentRotation = 0;
      updateImageTransform();
      showToast('Zoom: Fit');
    };
  }
  if (imgActualBtn) {
    imgActualBtn.onclick = () => {
      if (mainImageViewer && mainImageViewer.naturalWidth) {
        const containerWidth = imageCanvas.clientWidth || 800;
        currentZoom = +(mainImageViewer.naturalWidth / containerWidth).toFixed(2);
      } else {
        currentZoom = 1;
      }
      updateImageTransform();
      showToast('1:1 Actual Size');
    };
  }
  if (imgRotateBtn) {
    imgRotateBtn.onclick = () => {
      currentRotation = (currentRotation + 90) % 360;
      updateImageTransform();
      showToast(`Rotated ${currentRotation}°`);
    };
  }
  if (imageCanvas) {
    imageCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        currentZoom = Math.min(5, +(currentZoom + 0.15).toFixed(2));
      } else {
        currentZoom = Math.max(0.15, +(currentZoom - 0.15).toFixed(2));
      }
      updateImageTransform();
    }, { passive: false });
  }

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (mediaType === 'IMAGE') {
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        imgZoomInBtn?.click();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        imgZoomOutBtn?.click();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        imgRotateBtn?.click();
      } else if (e.key === '0') {
        e.preventDefault();
        imgFitBtn?.click();
      }
    } else {
      if (e.code === 'Space' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 5 : 10));
        showToast(e.shiftKey ? '⏪ -5s' : '⏪ -10s');
      } else if (e.code === 'ArrowRight' || e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        const dur = video.duration || 0;
        video.currentTime = Math.min(dur, video.currentTime + (e.shiftKey ? 5 : 10));
        showToast(e.shiftKey ? '+5s ⏩' : '+10s ⏩');
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        video.volume = Math.min(1, +(video.volume + 0.05).toFixed(2));
        video.muted = false;
        updateVolumeUI();
        showToast(`Volume ${Math.round(video.volume * 100)}%`);
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        video.volume = Math.max(0, +(video.volume - 0.05).toFixed(2));
        updateVolumeUI();
        showToast(`Volume ${Math.round(video.volume * 100)}%`);
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        video.muted = !video.muted;
        updateVolumeUI();
        showToast(video.muted ? 'Muted' : 'Unmuted');
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        if (pipBtn) pipBtn.click();
      } else if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        if (fitBtn) fitBtn.click();
      }
    }

    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      if (downloadBtn) downloadBtn.click();
    } else if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      if (copyUrlBtn) copyUrlBtn.click();
    }
  });

  // Stage Initialization
  if (mediaUrl) {
    if (mediaType === 'IMAGE') {
      viewport.classList.add('hidden');
      playerDocStage.classList.add('hidden');
      playerImageStage.classList.remove('hidden');

      mainImageViewer.src = mediaUrl;
      mainImageViewer.onload = () => {
        if (mainImageViewer.naturalWidth && mainImageViewer.naturalHeight) {
          $('streamResBadge').textContent = `${mainImageViewer.naturalWidth}x${mainImageViewer.naturalHeight}`;
        }
      };
      mainImageViewer.onerror = () => {
        showToast('Could not load image');
      };
    } else if (mediaType === 'DOC') {
      viewport.classList.add('hidden');
      playerImageStage.classList.add('hidden');
      playerDocStage.classList.remove('hidden');

      const isPdf = /\.pdf(\?|#|$)/i.test(mediaUrl);
      if (isPdf) {
        mainDocViewer.src = mediaUrl;
        mainDocViewer.classList.remove('hidden');
        docFallbackNotice.classList.add('hidden');
        $('streamResBadge').textContent = 'PDF Document';
      } else {
        mainDocViewer.classList.add('hidden');
        docFallbackNotice.classList.remove('hidden');
        if (docFallbackTitle) docFallbackTitle.textContent = mediaTitle || 'Document File';
        if (docFallbackOpenLink) docFallbackOpenLink.href = mediaUrl;
        if (docFallbackDownloadBtn) docFallbackDownloadBtn.onclick = () => downloadBtn?.click();
        $('streamResBadge').textContent = 'Document';
      }
    } else {
      // Video / Audio Stage
      playerImageStage.classList.add('hidden');
      playerDocStage.classList.add('hidden');
      viewport.classList.remove('hidden');

      video.src = mediaUrl;
      video.load();
      video.play().catch(() => {});
    }
  } else {
    showToast('No stream URL provided');
  }
})();

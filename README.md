# ROSE — TikTok 1080p 120FPS Quality Bypass (Web & Online)

100% standalone web service designed to bypass TikTok server-side video compression up to 1080p 120 FPS (Lossless 1:1 stream-copy + container normalization).

Runs **directly in the browser** online on **GitHub Pages** (no Python or local server required).

---

## 🌐 Online Deployment (GitHub Pages)

The website is fully client-side and requires zero backend:
1. **Client-side Lossless Processing:** Executes in ~0.3s directly inside the browser using modern Web APIs (`rose_patcher.js`). No video is uploaded to third-party servers, 0% quality loss, and instant automatic downloads.
2. **TikTok Video Checker & Downloader:** Inspects stream signals and offers multi-quality downloads (1080p HD no watermark, 720p SD, MP3 audio, watermarked video).

### How to publish to GitHub Pages:
1. Push the contents of this repository to GitHub.
2. Go to **Settings** ➔ **Pages**.
3. Under **Build and deployment**:
   - **Source:** select **Deploy from a branch**
   - **Branch:** select `main` (or `master`) and folder `/(root)`
   - Click **Save**.
4. In under a minute your site will be live at:  
   `https://<your-username>.github.io/<your-repo>/`

---

## 💻 Local Run (Optional)

If you prefer running a local server with FFmpeg support:
1. Double click `START_ENCODEX_STUDIO.bat` (or execute `python app.py`).
2. Open in your browser: `http://127.0.0.1:5050`.


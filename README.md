# Grab UI - Media Automation & Management

Grab UI is a powerful, web-based media automation tool that combines a robust shell-based processing engine with a modern, multi-session web interface. It allows users to scrape, download, transcode, and organize movies and TV shows with enterprise-grade features.

## 🚀 Key Features

### 📡 Smart Scraping & Downloading (`grab.sh`)
- **Mode-Based Processing:** Specialized logic for Movies and TV Shows.
- **Recursive Scraper:** Automatically detects and traverses directory structures for complete series downloads.
- **Intelligent Filtering:** Prioritizes high-resolution mirrors (2160p, 1080p) and premium audio formats (5.1, DDP, TrueHD).
- **Duplicate Prevention:** Checks local workspace history to avoid redundant downloads.
- **Recursive Downloader:** Robust `wget` implementation with random-wait and retry logic to bypass server throttling.

### ⚙️ Media Processing Engine
- **HandBrake Integration:** Automatic transcoding of MKV files to optimized MP4 format using high-quality presets.
- **FileBot Organization:** Semantically renames and organizes files into Plex-compatible structures (`{plex.id}`).
- **Subfolder Management:** Dynamically creates and manages staging and output directories for organized media libraries.

### 🌐 Advanced Web Interface (`index.js` & UI)
- **Multi-Session Terminal:** Manage up to **3 concurrent processing slots** with real-time Xterm.js terminal feedback.
- **Interactive Control:** Start, monitor, and kill processes directly from the browser.
- **Live Library Explorer:** Real-time tree view of `__STAGING__` and `__OUTPUTS__` directories with automated refreshes.
- **Deep File Inspection:** Built-in `ffprobe` integration to view detailed file metadata (bitrate, codecs, resolution) on click.
- **Admin Panel:** Global toggle for FileBot/HandBrake features and system-wide settings management.

## 🔐 Security & Authentication
Grab UI integrates directly with your host system's security model:
- **Linux Account Integration:** Uses `authenticate-pam` to validate credentials against **existing Linux system users**. No separate database required.
- **Session Persistence:** Persistent file-based sessions for long-running downloads.
- **Admin Authorization:** Dedicated administrative layer for feature management and password control.

## 🛠 Installation & Deployment
For detailed setup instructions, including system dependencies (`HandBrakeCLI`, `filebot`, `libpam0g-dev`), please refer to the:

👉 **[Deployment Guide](deployment.md)**

---
*Note: This tool is intended for personal media management and organization.*

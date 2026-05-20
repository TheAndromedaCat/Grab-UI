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

### 1. Prerequisites
Ensure your system meets the following requirements:
- **Node.js** (v18.x or higher recommended):
  ```bash
  # Using NodeSource for the latest LTS
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt install -y nodejs
  ```
- **Linux Environment** (Ubuntu/Debian recommended)
- **PAM Development Headers** (Required for authentication):
  ```bash
  sudo apt update
  sudo apt install libpam0g-dev build-essential
  ```
- **Optional Processing Tools**:
  - `HandBrakeCLI`: `sudo apt install handbrake-cli`
  - `ffmpeg` & `ffprobe`: `sudo apt install ffmpeg`
  - `filebot`: Follow [official instructions](https://www.filebot.net/linux/apt.html) to add their repository.

### 2. Quick Start
1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd grab
   ```
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Configure Environment** (Optional):
   Create a `.env` file or set environment variables:
   - `PORT`: Server port (default: 2026)
   - `ADMIN_PASSWORD`: Default admin password for the panel.

4. **Set Permissions**:
   Ensure the script and directories are writable:
   ```bash
   chmod +x grab.sh
   mkdir -p __STAGING__ __OUTPUTS__
   chmod -R 777 __STAGING__ __OUTPUTS__
   ```

### 3. Running with PM2 (Recommended)
PM2 ensures the server stays alive and restarts on failure:
```bash
# Install PM2 globally
npm install -g pm2

# Start the application
pm2 start index.js --name "grab-ui"

# Ensure it starts on system boot
pm2 save
pm2 startup
```

### 4. Management Commands
- **Logs:** `pm2 logs grab-ui`
- **Restart:** `pm2 restart grab-ui`
- **Stop:** `pm2 stop grab-ui`
- **Monitor:** `pm2 monit`

The web interface will be available at `http://your-server-ip:2026`.

---
*Note: This tool is intended for personal media management and organization.*

Grab UI is still somewhat in a Work in Progress state, and some features and functionality may be subject to change.

# Grab UI - Media Automation & Management

Grab UI is a powerful, web-based media automation tool that combines a robust shell-based processing engine with a modern, multi-session web interface. It allows users to scrape, download, transcode, and organize movies and TV shows with enterprise-grade features.

## 📋 Table of Contents
- [🚀 Key Features](#-key-features)
    - [📡 Smart Scraping & Downloading](#-smart-scraping--downloading-grabsh)
    - [⚙️ Media Processing Engine](#️-media-processing-engine)
    - [🌐 Advanced Web Interface](#-advanced-web-interface-indexjs--ui)
- [📁 Project Management & Security](#-project-management--security)
- [🔐 Security & Authentication](#-security--authentication)
- [🛠 Installation & Deployment](#-installation--deployment)
    - [1. Prerequisites](#1-prerequisites)
    - [2. Quick Start](#2-quick-start)
    - [3. Running with PM2](#3-running-with-pm2-recommended)
    - [4. Management Commands](#4-management-commands)

## 🚀 Key Features

### 📡 Smart Scraping & Downloading (`grab.sh`)
- **Mode-Based Processing:** Specialized logic for Movies and TV Shows.
- **Recursive Scraper:** Automatically detects and traverses directory structures for complete series downloads.
- **Intelligent Filtering:** Prioritizes high-resolution mirrors (2160p, 1080p) and premium audio formats (5.1, DDP, TrueHD).
- **Duplicate Prevention:** Checks local workspace history to avoid redundant downloads.
- **Recursive Downloader:** Robust `wget` implementation with random-wait and retry logic to bypass server throttling.
- **Real-time Velocity Metrics:** Integrated live throughput monitoring to provide granular insights into active download speeds and network performance.

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

## 📁 Project Management & Security
Grab UI includes a robust project ownership and permission system designed to keep user data private and secure, even when accessed via external services like SMB or FTP.

### How it Works
1. **Ownership:** The first user to start a session with a specific "Project" name becomes the owner of that project.
2. **Real-Time Collaboration & Synchronization:**
   - **One Process Per Project:** To ensure data integrity, only one instance of `grab.sh` can run per project at any time.
   - **Shared Sessions:** If a user selects a project that is already running (started by another authorized user), they automatically join the active session.
   - **Live Sync:** All users watching the same project receive synchronized terminal output, real-time configuration updates, and shared control (input prompts and process termination).
   - **Session Persistence:** Log history and process status are maintained globally for projects, allowing users to reconnect and see the current state immediately.
3. **Access Control:** 
   - Owners can manage project access by clicking the **Project ﹢** label in their session card.
   - This opens a modal where they can **Add** or **Remove** other Linux users by their username.
4. **Visibility:**
   - **UI Filtering:** Users only see folders in the staging/outputs tree that they own or have been granted access to.
   - **System Integrity:** The UI prevents users from "hijacking" another user's name as a project name.

### SMB & FTP Privacy
When a command is run, the system automatically configures the project directories on the host filesystem:
- **Ownership:** The directory ownership is set to the user who initiated the command (`chown`).
- **Permissions:** Directories are strictly set to `0700` (`rwx------`) using `chmod`.
- **Impact:** This ensures that while logged in via SMB or FTP, users **cannot see or enter** folders belonging to other users or projects they aren't part of. Only the project owner and the system administrator have visibility.

## 🔐 Security & Authentication
Grab UI integrates directly with your host system's security model:
- **Linux Account Integration:** Uses `authenticate-pam` to validate credentials against **existing Linux system users**. No separate database required.
- **Session Persistence:** Persistent file-based sessions for long-running downloads.
- **Admin Authorization:** Dedicated administrative layer for feature management and password control.

## 🛠 Installation & Deployment

### 1. Prerequisites
Ensure your system meets the following requirements:

#### **Node.js Installation** (v18.x or higher recommended)
- **Ubuntu/Debian**:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt install -y nodejs
  ```
- **Arch Linux**:
  ```bash
  sudo pacman -S nodejs npm
  ```
- **Fedora**:
  ```bash
  sudo dnf install nodejs
  ```
- **openSUSE**:
  ```bash
  sudo zypper install nodejs20
  ```

#### **Mandatory System Dependencies**
These are required for basic functionality and authentication:

- **Ubuntu/Debian**:
  ```bash
  sudo apt update
  sudo apt install libpam0g-dev build-essential
  ```
- **Arch Linux**:
  ```bash
  sudo pacman -S pam base-devel
  ```
- **Fedora**:
  ```bash
  sudo dnf install pam-devel gcc-c++ make
  ```
- **openSUSE**:
  ```bash
  sudo zypper install pam-devel gcc-c++ make
  ```

#### **Optional Media Tools**
Install these to enable transcoding, metadata inspection, and automated renaming:

- **Ubuntu/Debian**:
  ```bash
  sudo apt install ffmpeg handbrake-cli
  ```
- **Arch Linux**:
  ```bash
  sudo pacman -S ffmpeg handbrake-cli
  ```
- **Fedora**:
  ```bash
  # Note: ffmpeg and HandBrake-cli may require RPM Fusion
  sudo dnf install ffmpeg HandBrake-cli
  ```
- **openSUSE**:
  ```bash
  # Note: ffmpeg and HandBrake-CLI may require the Packman repository
  sudo zypper install ffmpeg HandBrake-CLI
  ```

- **FileBot**: Follow [official instructions](https://www.filebot.net/linux/apt.html) for your specific distribution.

### 2. Quick Start
1. **Clone the repository**:
   ```bash
   git clone https://github.com/TheAndromedaCat/Grab-UI.git
   cd Grab-UI
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

## 🚀 Upcoming Roadmap
- [ ] **Stateful Download Resumption:** Implement advanced chunk-aware download management to facilitate partial fragment recovery, eliminating the need for full-file re-transfers during intermittent network interruptions.

---
*Note: This tool is intended for personal media management and organization.*
